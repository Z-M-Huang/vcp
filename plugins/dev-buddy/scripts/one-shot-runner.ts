#!/usr/bin/env bun
/**
 * One-Shot Runner — execute a single task via an API or CLI preset.
 *
 * For API presets: spawns api-task-runner.ts, reads stdout JSON result.
 * For CLI presets: substitutes template placeholders, executes the CLI command.
 *
 * Usage:
 *   bun one-shot-runner.ts --type api --preset <name> --model <model> --cwd <dir> --task "<text>"
 *   bun one-shot-runner.ts --type cli --preset <name> --model <model> --cwd <dir> --task "<text>"
 *   echo "<text>" | bun one-shot-runner.ts --type api --preset <name> --model <model> --cwd <dir> --task-stdin
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
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';

// ================== CONFIGURATION ==================

const DEFAULT_API_TIMEOUT_MS = 300_000;  // 5 minutes
const DEFAULT_CLI_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const KILL_GRACE_MS = 3_000;

/**
 * Buffer added to task timeout for the api-task-runner process timeout.
 * Accounts for warmup (~60s) and process startup/shutdown overhead.
 */
const PROCESS_TIMEOUT_BUFFER_MS = 120_000;

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

// ================== CLI ARG PARSING ==================

interface ParsedArgs {
  type: 'api' | 'cli';
  preset: string;
  model: string;
  cwd: string;
  task: string;
  /** When true, task text is read from stdin instead of --task arg. */
  taskFromStdin: boolean;
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
      case '--task-stdin':
        result.taskFromStdin = true;
        break;
    }
  }

  const missing: string[] = [];
  if (!result.type) missing.push('--type');
  if (!result.preset) missing.push('--preset');
  if (!result.model) missing.push('--model');
  if (!result.cwd) missing.push('--cwd');
  if (!result.task && !result.taskFromStdin) missing.push('--task or --task-stdin');

  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.join(', ')}`);
  }

  if (!MODEL_NAME_REGEX.test(result.model!)) {
    throw new Error(`Invalid model name '${result.model}'. Must match /^[a-zA-Z0-9._-]+$/`);
  }

  if (!result.taskFromStdin) {
    result.taskFromStdin = false;
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

// ================== API PATH ==================

/** Injectable dependencies for runApiPath — defaults to real implementations. */
interface ApiPathDeps {
  spawnTaskRunner(args: ParsedArgs, taskTimeoutMs: number): {
    proc: {
      exitCode: number | null;
      stdout: ReadableStream<Uint8Array>;
      kill(signal?: number | string): void;
    };
    exited: Promise<void>;
  };
  log: typeof vcpLog;
  /** Override PROCESS_TIMEOUT_BUFFER_MS for testing. */
  processTimeoutBufferMs?: number;
  /** Override KILL_GRACE_MS for testing. */
  killGraceMs?: number;
}

const defaultApiDeps: ApiPathDeps = {
  spawnTaskRunner(args, taskTimeoutMs) {
    const taskRunnerPath = path.join(path.dirname(import.meta.path), 'api-task-runner.ts');
    const proc = Bun.spawn([
      'bun', taskRunnerPath,
      '--preset', args.preset,
      '--model', args.model,
      '--task-stdin',
      '--cwd', args.cwd,
      '--task-timeout', String(taskTimeoutMs),
    ], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
    // Write task to stdin — avoids argv size limits (E2BIG) and ps exposure
    proc.stdin.write(args.task);
    proc.stdin.end();
    return { proc, exited: proc.exited.then(() => {}) };
  },
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
  const { proc, exited } = deps.spawnTaskRunner(args, taskTimeoutMs);

  // Collect stdout concurrently (start reading before exit to avoid buffer issues)
  const stdoutPromise = new Response(proc.stdout).text();

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    // Wait for process to complete with a wall-clock timeout
    // api-task-runner has internal timeout, but add buffer for warmup + startup
    const processTimeoutMs = taskTimeoutMs + (deps.processTimeoutBufferMs ?? PROCESS_TIMEOUT_BUFFER_MS);
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), processTimeoutMs);
      }),
    ]);

    if (timedOut) {
      // Graceful shutdown: SIGTERM → await grace period → SIGKILL
      // Must await so SIGKILL fires before process.exit() kills the event loop
      const graceMs = deps.killGraceMs ?? KILL_GRACE_MS;
      try { proc.kill('SIGTERM'); } catch { /* best effort */ }
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
          resolve();
        }, graceMs);
      });
      return makeError('api_execution', 'api-task-runner process timed out', 3);
    }

    const stdout = await stdoutPromise;
    const lastLine = stdout.trim().split('\n').pop() || '';

    if (!lastLine) {
      return makeError('api_execution', 'api-task-runner produced no output', 2);
    }

    let output: OutputEvent;
    try {
      output = JSON.parse(lastLine);
    } catch {
      return makeError('api_execution', `api-task-runner produced invalid JSON: ${lastLine.slice(0, 200)}`, 2);
    }

    if (output.event === 'complete') {
      return makeComplete(
        output.provider || args.preset,
        output.model || args.model,
        output.result || 'Task completed successfully',
      );
    } else {
      const exitCode = proc.exitCode === 3 ? 3 : proc.exitCode === 1 ? 1 : 2;
      return makeError(
        output.phase || 'api_execution',
        output.error || 'Unknown error',
        exitCode,
      );
    }
  } catch (err) {
    return makeError('api_execution', (err as Error).message || 'Unknown error', 2);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
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

  // Read task from stdin if --task-stdin was set (avoids argv size limits + ps exposure)
  if (args.taskFromStdin) {
    try {
      args.task = await new Response(Bun.stdin.stream()).text();
      if (!args.task.trim()) {
        emitAndExit(makeError('validation', 'No task provided on stdin', 1));
      }
    } catch (err) {
      emitAndExit(makeError('validation', `Failed to read task from stdin: ${(err as Error).message}`, 1));
    }
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
  makeComplete,
  makeError,
  runApiPath,
  runCliPath,
  type ParsedArgs,
  type OutputEvent,
  type RunResult,
  type ApiPathDeps,
};
