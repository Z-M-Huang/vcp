#!/usr/bin/env bun
/**
 * One-Shot Runner — execute a single task via an API or CLI preset.
 *
 * For API presets: spawns a session-manager, sends the task via HTTP, shuts down.
 * For CLI presets: substitutes template placeholders, executes the CLI command.
 *
 * Usage:
 *   bun one-shot-runner.ts --type api --preset <name> --model <model> --cwd <dir> --task "<text>"
 *   bun one-shot-runner.ts --type cli --preset <name> --model <model> --cwd <dir> --task "<text>"
 *
 * Exit codes:
 *   0 - Success
 *   1 - Validation error (missing preset, invalid model, bad template)
 *   2 - Execution error (session failure, CLI error, auth failure)
 *   3 - Timeout
 */

import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import {
  readPresets,
  validateCliTemplate,
  VALID_ONE_SHOT_PLACEHOLDERS,
  REQUIRED_ONE_SHOT_PLACEHOLDERS,
  FORBIDDEN_ONE_SHOT_PLACEHOLDERS,
} from './preset-utils.ts';
import { MODEL_NAME_REGEX } from '../types/stage-definitions.ts';
import type { ApiPreset, CliPreset } from '../types/presets.ts';
import type { Message, Part } from '../types/a2a-lite.ts';
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';

// ================== CONFIGURATION ==================

const DEFAULT_API_TIMEOUT_MS = 300_000;  // 5 minutes
const DEFAULT_CLI_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const SESSION_STARTUP_TIMEOUT_MS = 30_000; // 30 seconds
const SHUTDOWN_GRACE_MS = 5_000;
const KILL_GRACE_MS = 3_000;

/** Custom error for startup timeout — distinguishes from AbortSignal.timeout's TimeoutError. */
class StartupTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupTimeoutError';
  }
}

// Placeholder sets are centralized in preset-utils.ts (VALID_ONE_SHOT_PLACEHOLDERS, etc.)

// ================== OUTPUT HELPERS ==================

interface OutputEvent {
  event: 'complete' | 'error';
  provider?: string;
  model?: string;
  result?: string;
  phase?: string;
  error?: string;
}

/** Result from a run path — emitted AFTER cleanup, then process.exit is called. */
interface RunResult {
  output: OutputEvent;
  exitCode: number;
}

function makeComplete(provider: string, model: string, result: string): RunResult {
  return {
    output: { event: 'complete', provider, model, result },
    exitCode: 0,
  };
}

function makeError(phase: string, error: string, exitCode: number = 2): RunResult {
  return {
    output: { event: 'error', phase, error },
    exitCode,
  };
}

/** Emit result JSON to stdout and exit. Called only after all cleanup is done. */
function emitAndExit(result: RunResult): never {
  console.log(JSON.stringify(result.output));
  process.exit(result.exitCode);
}

// ================== RESULT EXTRACTION ==================

/**
 * Extract text from an A2A-lite Message result.
 * Message has { role, parts[] } where parts are TextPart | DataPart | FilePart.
 */
function extractResultText(result?: Message | null): string {
  if (!result || !Array.isArray(result.parts)) return '';
  return result.parts
    .filter((p: Part) => p.type === 'text')
    .map((p: Part) => (p as { type: 'text'; text: string }).text)
    .join('\n');
}

// ================== HTTP STATUS MAPPING ==================

/** Map HTTP error status to a structured error result. */
function mapHttpStatusToError(status: number, statusText: string): RunResult {
  switch (status) {
    case 503: return makeError('api_execution', `HTTP 503: Session not ready`, 2);
    case 408: return makeError('api_execution', `HTTP 408: Queue timeout`, 3);
    default: return makeError('api_execution', `HTTP ${status}: ${statusText}`, 2);
  }
}

/** Validate the task response body from /tasks/send. */
function validateTaskResponse(body: {
  task?: { status?: string; error?: { message?: string }; result?: Message };
}): RunResult | null {
  if (body.task?.status !== 'completed') {
    return makeError(
      'api_execution',
      `Task ${body.task?.status || 'unknown'}: ${body.task?.error?.message || 'unknown error'}`,
      2,
    );
  }
  return null; // success — no error
}

// ================== CLI ARG PARSING ==================

interface ParsedArgs {
  type: 'api' | 'cli';
  preset: string;
  model: string;
  cwd: string;
  task: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: Partial<ParsedArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--type':
        if (!next) throw new Error('--type requires a value');
        if (next !== 'api' && next !== 'cli') throw new Error('--type must be "api" or "cli"');
        result.type = next;
        i++;
        break;
      case '--preset':
        if (!next) throw new Error('--preset requires a value');
        result.preset = next;
        i++;
        break;
      case '--model':
        if (!next) throw new Error('--model requires a value');
        result.model = next;
        i++;
        break;
      case '--cwd':
        if (!next) throw new Error('--cwd requires a value');
        result.cwd = next;
        i++;
        break;
      case '--task':
        if (!next) throw new Error('--task requires a value');
        result.task = next;
        i++;
        break;
    }
  }

  const missing: string[] = [];
  if (!result.type) missing.push('--type');
  if (!result.preset) missing.push('--preset');
  if (!result.model) missing.push('--model');
  if (!result.cwd) missing.push('--cwd');
  if (!result.task) missing.push('--task');

  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.join(', ')}`);
  }

  if (!MODEL_NAME_REGEX.test(result.model!)) {
    throw new Error(`Invalid model name '${result.model}'. Must match /^[a-zA-Z0-9._-]+$/`);
  }

  return result as ParsedArgs;
}

// ================== TEMPLATE PROCESSING (CLI) ==================

/**
 * Tokenize a CLI args_template, respecting quoted strings.
 * Returns null on unbalanced quotes.
 */
function tokenizeTemplate(template: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const len = template.length;
  while (i < len) {
    while (i < len && /\s/.test(template[i])) i++;
    if (i >= len) break;
    let token = '';
    while (i < len && !/\s/.test(template[i])) {
      if (template[i] === '"') {
        i++;
        while (i < len && template[i] !== '"') {
          if (template[i] === '\\' && i + 1 < len) { token += template[i + 1]; i += 2; }
          else { token += template[i]; i++; }
        }
        if (i >= len) return null;
        i++;
      } else if (template[i] === "'") {
        i++;
        while (i < len && template[i] !== "'") { token += template[i]; i++; }
        if (i >= len) return null;
        i++;
      } else { token += template[i]; i++; }
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

/** Substitute placeholders in a template string. */
function substitutePlaceholders(template: string, placeholders: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(placeholders)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

/**
 * Check if template contains unsupported placeholders for one-shot mode.
 * Returns list of unsupported placeholders found.
 * @deprecated Kept for export compatibility. Prefer one_shot_args_template on the preset.
 */
function findUnsupportedPlaceholders(template: string): string[] {
  const pipelineOnly = ['output_file', 'schema_path'];
  const found: string[] = [];
  for (const ph of pipelineOnly) {
    if (template.includes(`{${ph}}`)) found.push(ph);
  }
  return found;
}

/**
 * Escape an argument for Windows cmd.exe shell invocation (CWE-78 prevention).
 * Mirrors escapeWinArg from cli-executor.ts.
 */
function escapeWinArg(arg: string): string {
  const needsQuoting = /[\s\t"&|<>^()@!%]/.test(arg);
  if (!needsQuoting) return arg;

  let escaped = '';
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (ch === '"') escaped += '""';
    else if (ch === '%') escaped += '%%';
    else if (ch === '!') escaped += '^!';
    else escaped += ch;
  }
  return `"${escaped}"`;
}

// ================== SESSION MANAGER CLEANUP ==================

/**
 * Clean up a session manager process: POST /shutdown then escalate to SIGTERM/SIGKILL.
 * This function never throws — all errors are swallowed (best-effort cleanup).
 */
async function cleanupSessionManager(
  proc: { exitCode: number | null; kill(signal?: number | string): void },
  port?: number,
  token?: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  // 1. Graceful shutdown via HTTP
  if (port && token) {
    try {
      await fetchFn(`http://localhost:${port}/shutdown`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(SHUTDOWN_GRACE_MS),
      });
    } catch { /* best-effort */ }
  }

  // 2. Wait briefly for process to exit
  await new Promise(r => setTimeout(r, 1_000));

  // 3. Escalate if still alive (exitCode === null means not exited)
  if (proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, KILL_GRACE_MS));
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
    }
  }
}

// ================== API PATH ==================

/**
 * Read a single line from a readable stream with timeout.
 * Used to capture the session-manager startup JSON.
 */
async function readStartupLine(
  stdout: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new StartupTimeoutError('Session manager startup timeout')), timeoutMs)
  );

  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Session manager stdout closed before startup output');
      buffer += decoder.decode(value, { stream: true });
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        reader.releaseLock();
        return buffer.slice(0, newlineIdx).trim();
      }
    }
  })();

  return Promise.race([readPromise, timeoutPromise]);
}

/** Injectable dependencies for runApiPath — defaults to real implementations. */
interface ApiPathDeps {
  spawnSessionManager(args: ParsedArgs, taskTimeoutMs: number): {
    proc: { exitCode: number | null; kill(signal?: number | string): void; stdout: ReadableStream<Uint8Array> };
  };
  readStartup(stdout: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string>;
  fetchFn: typeof fetch;
  log: typeof vcpLog;
}

const defaultApiDeps: ApiPathDeps = {
  spawnSessionManager(args, taskTimeoutMs) {
    const sessionManagerPath = path.join(path.dirname(import.meta.path), 'session-manager.ts');
    const proc = Bun.spawn([
      'bun', sessionManagerPath,
      '--preset', args.preset,
      '--model', args.model,
      '--cwd', args.cwd,
      '--task-timeout', String(taskTimeoutMs),
    ], { stdout: 'pipe', stderr: 'inherit' });
    return { proc };
  },
  readStartup: readStartupLine,
  fetchFn: fetch,
  log: vcpLog,
};

async function runApiPath(
  args: ParsedArgs,
  preset: ApiPreset,
  debugEnabled: boolean,
  deps: ApiPathDeps = defaultApiDeps,
): Promise<RunResult> {
  // Validate model against preset
  if (!preset.models.includes(args.model)) {
    return makeError('validation', `Model '${args.model}' not in preset's models: [${preset.models.join(', ')}]`, 1);
  }

  const taskTimeoutMs = preset.timeout_ms || DEFAULT_API_TIMEOUT_MS;
  const { proc } = deps.spawnSessionManager(args, taskTimeoutMs);

  let port: number | undefined;
  let token: string | undefined;
  let result: RunResult;

  try {
    // Wait for startup JSON
    const startupLine = await deps.readStartup(proc.stdout, SESSION_STARTUP_TIMEOUT_MS);
    const startup = JSON.parse(startupLine);
    if (startup.status !== 'ready' || !startup.port || !startup.token) {
      throw new Error(`Invalid startup output: ${startupLine}`);
    }
    port = startup.port;
    token = startup.token;

    await deps.log(args.cwd, {
      source: 'one-shot-runner', event: 'session_ready', decision: 'info',
      details: `preset=${args.preset} model=${args.model} port=${port}`,
    }, debugEnabled);

    // Send task with auth
    const response = await deps.fetchFn(`http://localhost:${port}/tasks/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: { role: 'user', parts: [{ type: 'text', text: args.task }] },
      }),
      signal: AbortSignal.timeout(taskTimeoutMs),
    });

    // Validate HTTP response
    if (!response.ok) {
      result = mapHttpStatusToError(response.status, response.statusText);
    } else {
      const body = await response.json() as {
        task?: { status?: string; error?: { message?: string }; result?: Message };
      };

      // Validate task status
      const taskError = validateTaskResponse(body);
      if (taskError) {
        result = taskError;
      } else {
        // Extract text from Message { role, parts[] }
        const resultText = extractResultText(body.task?.result) || 'Task completed successfully';
        result = makeComplete(args.preset, args.model, resultText);
      }
    }
  } catch (err) {
    if (err instanceof StartupTimeoutError) {
      result = makeError('api_execution', 'Session manager startup timed out', 3);
    } else if (err instanceof Error && err.name === 'TimeoutError') {
      result = makeError('api_execution', 'Task execution timed out', 3);
    } else {
      result = makeError('api_execution', (err as Error).message || 'Unknown error', 2);
    }
  }

  // Cleanup ALWAYS runs — no process.exit in the try block above
  await cleanupSessionManager(proc, port, token, deps.fetchFn);

  return result;
}

// ================== CLI PATH ==================

async function runCliPath(args: ParsedArgs, preset: CliPreset, debugEnabled: boolean): Promise<RunResult> {
  // Validate model against preset
  if (!preset.models.includes(args.model)) {
    return makeError('validation', `Model '${args.model}' not in preset's models: [${preset.models.join(', ')}]`, 1);
  }

  // Use one_shot_args_template if available; otherwise alert user to configure it.
  // Runtime trim guards against whitespace-only values from manual JSON edits.
  const template = preset.one_shot_args_template?.trim() || '';
  if (!template) {
    return makeError(
      'validation',
      `CLI preset '${args.preset}' does not have a 'one_shot_args_template' configured. ` +
      'This template is required for /dev-buddy-once. ' +
      'Add it via /dev-buddy-config or /dev-buddy-manage-presets. ' +
      'Example: "exec --full-auto -m {model} \\"{prompt}\\""',
      1,
    );
  }

  // Runtime placeholder contract check — catches hand-edited presets that bypass validatePreset()
  const templateErr = validateCliTemplate(template, 'one_shot_args_template', {
    validSet: VALID_ONE_SHOT_PLACEHOLDERS,
    required: REQUIRED_ONE_SHOT_PLACEHOLDERS,
    forbidden: FORBIDDEN_ONE_SHOT_PLACEHOLDERS,
  });
  if (templateErr) {
    return makeError('validation', `CLI preset '${args.preset}' has invalid one_shot_args_template: ${templateErr}`, 1);
  }

  // Build placeholders (one-shot only: model, prompt, reasoning_effort)
  const placeholders: Record<string, string> = {
    model: args.model,
    prompt: args.task,
    reasoning_effort: preset.reasoning_effort || 'medium',
  };

  // Tokenize and substitute
  const tokenized = tokenizeTemplate(template);
  if (!tokenized) {
    return makeError('validation', 'Failed to tokenize one_shot_args_template — unbalanced quotes', 1);
  }

  const substitutedArgs = tokenized.map(token => substitutePlaceholders(token, placeholders));
  const timeoutMs = preset.timeout_ms || DEFAULT_CLI_TIMEOUT_MS;

  await vcpLog(args.cwd, {
    source: 'one-shot-runner', event: 'cli_start', decision: 'info',
    details: `command=${preset.command} model=${args.model}`,
  }, debugEnabled);

  // Platform-aware command execution
  return new Promise<RunResult>((resolve) => {
    let timedOut = false;
    const isWindows = os.platform() === 'win32';
    let proc: ReturnType<typeof spawn>;

    if (isWindows) {
      // CWE-78 prevention: escape args for cmd.exe
      const escapedArgs = substitutedArgs.map(escapeWinArg);
      const fullCommand = `${preset.command} ${escapedArgs.join(' ')}`;
      proc = spawn(fullCommand, [], {
        stdio: 'inherit',
        shell: true,
        cwd: args.cwd,
      });
    } else {
      // Unix: shell: false — no injection risk, args passed as array
      proc = spawn(preset.command, substitutedArgs, {
        stdio: 'inherit',
        shell: false,
        cwd: args.cwd,
      });
    }

    // Wall-clock timeout
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve(makeError('cli_execution', `Failed to start '${preset.command}': ${err.message}`, 2));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(makeError('cli_execution', 'CLI tool timed out', 3));
        return;
      }
      if (code === 0) {
        resolve(makeComplete(args.preset, args.model, 'CLI task completed successfully'));
      } else {
        resolve(makeError('cli_execution', `CLI tool exited with code ${code}`, 2));
      }
    });
  });
}

// ================== MAIN ==================

async function main(): Promise<void> {
  const debugEnabled = await isDebugEnabled();

  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    emitAndExit(makeError('validation', (err as Error).message, 1));
  }

  // Load preset
  let presets;
  try {
    presets = readPresets();
  } catch (err) {
    emitAndExit(makeError('validation', `Failed to read presets: ${(err as Error).message}`, 1));
  }

  const preset = presets.presets[args.preset];
  if (!preset) {
    const available = Object.keys(presets.presets).join(', ');
    emitAndExit(makeError('validation', `Preset '${args.preset}' not found. Available: ${available}`, 1));
  }

  // Route by type — run paths return RunResult, cleanup is already done
  let result: RunResult;

  if (args.type === 'api') {
    if (preset.type !== 'api') {
      emitAndExit(makeError('validation', `Preset '${args.preset}' is type '${preset.type}', expected 'api'`, 1));
    }
    result = await runApiPath(args, preset as ApiPreset, debugEnabled);
  } else if (args.type === 'cli') {
    if (preset.type !== 'cli') {
      emitAndExit(makeError('validation', `Preset '${args.preset}' is type '${preset.type}', expected 'cli'`, 1));
    }
    result = await runCliPath(args, preset as CliPreset, debugEnabled);
  } else {
    result = makeError('validation', `Unknown type: ${args.type}`, 1);
  }

  // Emit result and exit — cleanup has already run
  emitAndExit(result);
}

if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof Error) {
      console.error(`[one-shot-runner] Error: ${err.message}`);
    } else {
      console.error('[one-shot-runner] Unknown error:', err);
    }
    process.exit(2);
  });
}

// Exports for testing
export {
  parseArgs,
  tokenizeTemplate,
  substitutePlaceholders,
  findUnsupportedPlaceholders,
  escapeWinArg,
  readStartupLine,
  extractResultText,
  mapHttpStatusToError,
  validateTaskResponse,
  makeComplete,
  makeError,
  cleanupSessionManager,
  runApiPath,
  runCliPath,
  StartupTimeoutError,
  type ParsedArgs,
  type OutputEvent,
  type RunResult,
  type ApiPathDeps,
};
