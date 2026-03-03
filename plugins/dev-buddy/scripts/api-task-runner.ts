#!/usr/bin/env bun
/**
 * API Task Runner — lightweight per-invocation script for API preset tasks.
 *
 * Routes to AnthropicRunner (V2 Agent SDK) or OpenAIRunner (function-calling agent loop)
 * based on preset.protocol. Both implement the AgentRunner interface for capability parity.
 *
 * Each invocation is an independent process — multiple instances can run in parallel
 * without shared state, ports, or file locks.
 *
 * Usage:
 *   bun api-task-runner.ts --preset <name> --model <model> --task "<text>" --cwd <dir> [--task-timeout <ms>]
 *
 * Exit codes:
 *   0 - Success
 *   1 - Validation error (missing preset, invalid model)
 *   2 - Execution error (session failure, auth failure)
 *   3 - Timeout
 */

import fs from 'fs';
import path from 'path';
import { readPresets, maskApiKey } from './preset-utils.ts';
import { MODEL_NAME_REGEX } from '../types/stage-definitions.ts';
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';
import type { ApiPreset } from '../types/presets.ts';

// ================== CONFIGURATION ==================

/** Default per-task timeout: 5 minutes (300s). */
export const DEFAULT_TASK_TIMEOUT_MS = 300_000;

/** Default warmup timeout: 60 seconds. */
const WARMUP_TIMEOUT_MS = 60_000;

/** Max iterations for OpenAI agent loop. */
export const OPENAI_MAX_ITERATIONS = 100;

/** Max tokens for OpenAI completions. */
const OPENAI_MAX_TOKENS = 16384;

/** Default per-command timeout for bash tool: 120 seconds. */
const BASH_DEFAULT_TIMEOUT_MS = 120_000;

/** Max per-command timeout for bash tool: 600 seconds. */
const BASH_MAX_TIMEOUT_MS = 600_000;

/** Max output size from tool results (100KB). */
const TOOL_OUTPUT_MAX_BYTES = 100_000;

/** Max glob results returned. */
const GLOB_MAX_RESULTS = 200;

/** Grep tool timeout: 30 seconds. */
const GREP_TIMEOUT_MS = 30_000;

/** Env vars safe to inherit into the Agent SDK subprocess. */
export const ENV_ALLOWLIST = [
  // Cross-platform essentials
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
  'TMPDIR', 'TEMP', 'TMP',
  // Windows
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'HOMEDRIVE', 'HOMEPATH',
  // Network/proxy (enterprise environments)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  // TLS/certs
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

// ================== AGENT RUNNER INTERFACE ==================

export interface AgentRunOptions {
  model: string;
  systemPromptContent?: string;
  timeoutMs: number;
  cwd: string;
  debugEnabled: boolean;
  presetName: string;
}

export interface AgentRunResult {
  result: string | null;
  error: string | null;
  timedOut: boolean;
}

export interface AgentRunner {
  run(task: string, options: AgentRunOptions): Promise<AgentRunResult>;
}

// ================== TOOL DEFINITIONS ==================

/**
 * Tool names for the Anthropic Claude Agent SDK (PascalCase).
 * The OpenAI runner uses OPENAI_TOOLS (snake_case function names) for the same 6 capabilities.
 * Both arrays must track the same set of capabilities.
 */
export const ANTHROPIC_TOOL_NAMES = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'] as const;

/** OpenAI function calling types. */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * OpenAI function definitions — maps to the same 6 capabilities as ANTHROPIC_TOOL_NAMES.
 * Adding a tool here requires adding the matching PascalCase name to ANTHROPIC_TOOL_NAMES above.
 */
export const OPENAI_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative path to the file' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative path to the file' },
          content: { type: 'string', description: 'The content to write' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file. The old_string must appear exactly once.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to edit' },
          old_string: { type: 'string', description: 'The exact string to find and replace' },
          new_string: { type: 'string', description: 'The replacement string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return stdout + stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          timeout_ms: { type: 'number', description: 'Per-command timeout in ms (default 120000, max 600000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
          path: { type: 'string', description: 'Directory to search in (default: cwd)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for a pattern using grep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (basic regex)' },
          path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
          glob_filter: { type: 'string', description: 'File name pattern to filter (e.g. "*.ts")' },
        },
        required: ['pattern'],
      },
    },
  },
];

// ================== TOOL EXECUTION ==================

/**
 * Execute a tool call from the OpenAI function-calling loop.
 * Errors are returned as strings (never thrown) — the model sees the error and can adjust.
 */
export async function executeToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'read_file': {
        const filePath = args.file_path as string;
        if (!filePath) return 'Error: file_path is required';
        return fs.readFileSync(filePath, 'utf-8');
      }

      case 'write_file': {
        const filePath = args.file_path as string;
        const content = args.content as string;
        if (!filePath) return 'Error: file_path is required';
        if (content === undefined || content === null) return 'Error: content is required';
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content);
        return 'OK';
      }

      case 'edit_file': {
        const filePath = args.file_path as string;
        const oldString = args.old_string as string;
        const newString = args.new_string as string;
        if (!filePath) return 'Error: file_path is required';
        if (!oldString) return 'Error: old_string is required';
        if (newString === undefined || newString === null) return 'Error: new_string is required';

        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const occurrences = fileContent.split(oldString).length - 1;
        if (occurrences === 0) {
          return `Error: old_string not found in ${filePath}`;
        }
        if (occurrences > 1) {
          return `Error: old_string found ${occurrences} times in ${filePath} — must be unique`;
        }
        const updated = fileContent.replace(oldString, newString);
        fs.writeFileSync(filePath, updated);
        return 'OK';
      }

      case 'bash': {
        const command = args.command as string;
        if (!command) return 'Error: command is required';
        const rawTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : BASH_DEFAULT_TIMEOUT_MS;
        const cmdTimeout = Math.min(Math.max(rawTimeout, 1000), BASH_MAX_TIMEOUT_MS);

        const proc = Bun.spawn(['sh', '-c', command], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        // Race command execution against timeout — Bun stream reads may block
        // even after proc.kill(), so we use Promise.race to ensure we return promptly.
        const execPromise = (async () => {
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          await proc.exited;
          return { stdout, stderr, exitCode: proc.exitCode };
        })();

        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          setTimeout(() => {
            try { proc.kill(9); } catch { /* already done */ }
            resolve('timeout');
          }, cmdTimeout);
        });

        const raceResult = await Promise.race([execPromise, timeoutPromise]);

        if (raceResult === 'timeout') {
          return `Error: command timed out after ${cmdTimeout}ms`;
        }

        const { stdout, stderr, exitCode } = raceResult;
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
        if (!output) output = `(exit code: ${exitCode})`;

        return output.length > TOOL_OUTPUT_MAX_BYTES
          ? output.slice(0, TOOL_OUTPUT_MAX_BYTES) + '\n... (truncated)'
          : output;
      }

      case 'glob': {
        const pattern = args.pattern as string;
        if (!pattern) return 'Error: pattern is required';
        const searchPath = (args.path as string) || process.cwd();

        const glob = new Bun.Glob(pattern);
        const results: string[] = [];
        for (const match of glob.scanSync({ cwd: searchPath })) {
          results.push(match);
          if (results.length >= GLOB_MAX_RESULTS) break;
        }
        return results.length > 0 ? results.join('\n') : '(no matches)';
      }

      case 'grep': {
        const pattern = args.pattern as string;
        if (!pattern) return 'Error: pattern is required';
        const searchPath = (args.path as string) || '.';
        const globFilter = args.glob_filter as string | undefined;

        const grepArgs = ['grep', '-rn'];
        if (globFilter) grepArgs.push(`--include=${globFilter}`);
        grepArgs.push(pattern, searchPath);

        const proc = Bun.spawn(grepArgs, {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const timer = setTimeout(() => { try { proc.kill(); } catch { /* already done */ } }, GREP_TIMEOUT_MS);

        try {
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          await proc.exited;

          // grep exit codes: 0 = matches found, 1 = no matches, 2+ = error
          if (proc.exitCode !== null && proc.exitCode >= 2) {
            return `Error: grep failed: ${stderr.trim() || `exit code ${proc.exitCode}`}`;
          }

          if (!stdout.trim()) return '(no matches)';
          return stdout.length > TOOL_OUTPUT_MAX_BYTES
            ? stdout.slice(0, TOOL_OUTPUT_MAX_BYTES) + '\n... (truncated)'
            : stdout;
        } finally {
          clearTimeout(timer);
        }
      }

      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

// ================== ENV CONSTRUCTION ==================

/**
 * Build the base env object from the ENV_ALLOWLIST.
 * Inherits allowlisted host vars only — no provider-specific vars.
 */
export function buildBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }
  return env;
}

/**
 * Build the env object for a V2 Agent SDK session from an API preset.
 * Inherits allowlisted host vars + sets Anthropic credentials and model aliases.
 * The env option replaces the entire subprocess env (clean isolation).
 */
export function buildSessionEnv(preset: ApiPreset, modelOverride?: string): Record<string, string> {
  const model = modelOverride ?? preset.models[0]; // Case-sensitive — passed unmodified
  const env = buildBaseEnv();

  // Provider credentials + model aliases (override any inherited values)
  env.ANTHROPIC_BASE_URL = preset.base_url;
  env.ANTHROPIC_API_KEY = preset.api_key;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;

  return env;
}

// ================== SESSION RESULT COLLECTION ==================

/**
 * Collect the result from a V2 session stream with wall-clock timeout.
 *
 * Uses Promise.race so timeout fires even if stream() yields nothing.
 * On timeout, session.close() kills the orphaned stream consumer.
 */
export async function collectSessionResult(
  session: any,
  timeoutMs: number = DEFAULT_TASK_TIMEOUT_MS,
): Promise<{ result: string | null; error: string | null; timedOut?: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  type CollectResult = { result: string | null; error: string | null; timedOut?: boolean };

  async function inner(): Promise<CollectResult> {
    for await (const msg of session.stream()) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          return { result: msg.result, error: null };
        } else {
          return { result: null, error: `${msg.subtype}: ${(msg as any).errors?.join(', ') || 'unknown'}` };
        }
      }
    }
    return { result: null, error: 'stream ended without result message' };
  }

  const timeout = new Promise<CollectResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ result: null, error: `task timed out after ${timeoutMs / 1000}s`, timedOut: true });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([inner(), timeout]);
    if (result.timedOut) {
      try { session.close(); } catch { /* already closed or errored */ }
    }
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ================== ANTHROPIC RUNNER ==================

export class AnthropicRunner implements AgentRunner {
  constructor(private preset: ApiPreset) {}

  async run(task: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const env = buildSessionEnv(this.preset, options.model);

    // Debug logging: 4 individual writes (not batched — guaranteed writes on crash)
    await vcpLog(options.cwd, {
      source: 'api-task-runner', event: 'session_env', decision: 'info',
      details: JSON.stringify(Object.fromEntries(
        Object.entries(env).map(([k, v]) =>
          k === 'ANTHROPIC_API_KEY' ? [k, maskApiKey(v)] : [k, v]
        )
      )),
    }, options.debugEnabled);
    await vcpLog(options.cwd, {
      source: 'api-task-runner', event: 'session_config', decision: 'info',
      details: `protocol=anthropic model=${options.model} preset=${options.presetName} permissionMode=default`,
    }, options.debugEnabled);
    await vcpLog(options.cwd, {
      source: 'api-task-runner', event: 'session_system_prompt', decision: 'info',
      details: options.systemPromptContent ?? 'none',
    }, options.debugEnabled);
    await vcpLog(options.cwd, {
      source: 'api-task-runner', event: 'session_task', decision: 'info',
      details: task,
    }, options.debugEnabled);

    let session: any = null;
    try {
      await vcpLog(options.cwd, {
        source: 'api-task-runner', event: 'session_create', decision: 'info',
        details: `preset=${options.presetName} model=${options.model} key=${maskApiKey(this.preset.api_key)}`,
      }, options.debugEnabled);

      session = unstable_v2_createSession({
        model: options.model,
        env,
        permissionMode: 'default',
        allowedTools: [...ANTHROPIC_TOOL_NAMES],
        ...(options.systemPromptContent && {
          systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: options.systemPromptContent },
        }),
      });

      // Warmup — blocks until session is live
      await session.send('Respond with OK');
      const warmup = await collectSessionResult(session, WARMUP_TIMEOUT_MS);
      if (warmup.error) {
        return { result: null, error: `Warmup failed: ${warmup.error}`, timedOut: false };
      }

      await vcpLog(options.cwd, {
        source: 'api-task-runner', event: 'session_ready', decision: 'info',
        details: `preset=${options.presetName} model=${options.model}`,
      }, options.debugEnabled);

      // Send task
      await session.send(task);
      const result = await collectSessionResult(session, options.timeoutMs);
      return {
        result: result.result,
        error: result.error,
        timedOut: result.timedOut ?? false,
      };
    } catch (err) {
      return { result: null, error: (err as Error).message, timedOut: false };
    } finally {
      if (session) { try { session.close(); } catch { /* best effort */ } }
    }
  }
}

// ================== OPENAI RUNNER ==================

export class OpenAIRunner implements AgentRunner {
  constructor(private preset: ApiPreset) {}

  async run(task: string, options: AgentRunOptions): Promise<AgentRunResult> {
    // Debug logging: 3 entries (no subprocess env for OpenAI — uses fetch directly)
    await vcpLog(options.cwd, {
      source: 'api-task-runner', event: 'session_config', decision: 'info',
      details: `protocol=openai model=${options.model} preset=${options.presetName} base_url=${this.preset.base_url} key=${maskApiKey(this.preset.api_key)} maxIterations=${OPENAI_MAX_ITERATIONS}`,
    }, options.debugEnabled);
    await vcpLog(options.cwd, {
      source: 'api-task-runner', event: 'session_system_prompt', decision: 'info',
      details: options.systemPromptContent ?? 'none',
    }, options.debugEnabled);
    await vcpLog(options.cwd, {
      source: 'api-task-runner', event: 'session_task', decision: 'info',
      details: task,
    }, options.debugEnabled);

    try {
      const result = await this.agentLoop(task, options);
      return { result, error: null, timedOut: false };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('timed out')) {
        return { result: null, error: msg, timedOut: true };
      }
      return { result: null, error: msg, timedOut: false };
    }
  }

  private async agentLoop(task: string, options: AgentRunOptions): Promise<string> {
    const messages: OpenAIMessage[] = [];
    if (options.systemPromptContent) {
      messages.push({ role: 'system', content: options.systemPromptContent });
    }
    messages.push({ role: 'user', content: task });

    // Normalize base URL: strip trailing /v1 or /v1/ to avoid /v1/v1/chat/completions
    const baseUrl = this.preset.base_url.replace(/\/v1\/?$/, '');
    const deadline = Date.now() + options.timeoutMs;

    for (let i = 0; i < OPENAI_MAX_ITERATIONS; i++) {
      if (Date.now() >= deadline) {
        throw new Error(`OpenAI session timed out after ${options.timeoutMs / 1000}s`);
      }

      // Use preset max_output_tokens with defensive type check and fallback to constant
      const effectiveMaxTokens = typeof this.preset.max_output_tokens === 'number' && this.preset.max_output_tokens > 0
        ? this.preset.max_output_tokens
        : OPENAI_MAX_TOKENS;
      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        tools: OPENAI_TOOLS,
        max_tokens: effectiveMaxTokens,
      };
      if (this.preset.reasoning_effort) {
        body.reasoning_effort = this.preset.reasoning_effort;
      }

      const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.preset.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // Safety net — deadline check at loop top fires first for expired deadlines.
        // Min 1000ms prevents AbortSignal.timeout(0) edge case.
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1000)),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`OpenAI API returned ${resp.status}: ${text.slice(0, 500)}`);
      }

      const data = await resp.json() as any;
      const choice = data.choices?.[0];
      if (!choice) throw new Error('OpenAI API returned no choices');

      // Add assistant message to conversation history
      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: choice.message.content ?? null,
      };
      if (choice.message.tool_calls?.length) {
        assistantMsg.tool_calls = choice.message.tool_calls;
      }
      messages.push(assistantMsg);

      // If model wants to call tools, execute them and continue the loop
      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
        for (const tc of choice.message.tool_calls) {
          let toolArgs: Record<string, unknown> = {};
          try { toolArgs = JSON.parse(tc.function.arguments); } catch { /* empty args */ }
          const result = await executeToolCall(tc.function.name, toolArgs);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue;
      }

      // Model is done (finish_reason: 'stop', 'end_turn', or other non-tool reasons)
      return choice.message.content ?? 'Task completed (no text response)';
    }

    throw new Error(`OpenAI agent loop exceeded ${OPENAI_MAX_ITERATIONS} iterations`);
  }
}

// ================== RUNNER FACTORY ==================

/**
 * Create the appropriate runner based on preset protocol.
 * If adding a 3rd protocol, add a new case here.
 */
export function createRunner(preset: ApiPreset): AgentRunner {
  const protocol = preset.protocol ?? 'anthropic';
  if (protocol === 'openai') return new OpenAIRunner(preset);
  return new AnthropicRunner(preset);
}

// ================== OUTPUT HELPERS ==================

interface OutputEvent {
  event: 'complete' | 'error';
  provider?: string;
  model?: string;
  result?: string;
  phase?: string;
  error?: string;
}

function emitAndExit(output: OutputEvent, exitCode: number): never {
  console.log(JSON.stringify(output));
  process.exit(exitCode);
}

// ================== CLI ARG PARSING ==================

export interface ParsedArgs {
  preset: string;
  model: string;
  task: string;
  cwd: string;
  taskTimeoutMs: number;
  /** When true, task text is read from stdin instead of --task arg. */
  taskFromStdin: boolean;
  /** Optional path to a file whose content is appended to the system prompt. */
  systemPrompt?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: Partial<ParsedArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
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
      case '--task':
        if (!next) throw new Error('--task requires a value');
        result.task = next;
        i++;
        break;
      case '--cwd':
        if (!next) throw new Error('--cwd requires a value');
        result.cwd = next;
        i++;
        break;
      case '--task-stdin':
        result.taskFromStdin = true;
        break;
      case '--task-timeout':
        if (!next) throw new Error('--task-timeout requires a value');
        const ms = parseInt(next, 10);
        if (isNaN(ms) || ms <= 0) throw new Error('--task-timeout must be a positive integer (milliseconds)');
        result.taskTimeoutMs = ms;
        i++;
        break;
      case '--system-prompt':
        if (!next) throw new Error('--system-prompt requires a value');
        result.systemPrompt = next;
        i++;
        break;
    }
  }

  const missing: string[] = [];
  if (!result.preset) missing.push('--preset');
  if (!result.model) missing.push('--model');
  if (!result.task && !result.taskFromStdin) missing.push('--task or --task-stdin');
  if (!result.cwd) missing.push('--cwd');

  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.join(', ')}`);
  }

  if (!MODEL_NAME_REGEX.test(result.model!)) {
    throw new Error(`Invalid model name '${result.model}'. Must match /^[a-zA-Z0-9._-]+$/`);
  }

  if (!result.taskTimeoutMs) {
    result.taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS;
  }

  if (!result.taskFromStdin) {
    result.taskFromStdin = false;
  }

  return result as ParsedArgs;
}

// ================== MAIN ==================

async function main(): Promise<void> {
  const debugEnabled = await isDebugEnabled();

  // Parse args — no session yet, emitAndExit is safe
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    emitAndExit({ event: 'error', phase: 'validation', error: (err as Error).message }, 1);
  }

  // Read task from stdin if --task-stdin was set (avoids argv size limits + ps exposure)
  if (args.taskFromStdin) {
    try {
      args.task = await new Response(Bun.stdin.stream()).text();
      if (!args.task.trim()) {
        emitAndExit({ event: 'error', phase: 'validation', error: 'No task provided on stdin' }, 1);
      }
    } catch (err) {
      emitAndExit({ event: 'error', phase: 'validation', error: `Failed to read task from stdin: ${(err as Error).message}` }, 1);
    }
  }

  // Validate and read --system-prompt file if provided
  let systemPromptContent: string | undefined;
  if (args.systemPrompt) {
    try {
      // Path validation: must resolve under plugin's docs/ directory (CWE-22)
      const docsDir = path.resolve(path.join(import.meta.dir, '..', 'docs'));
      const resolved = path.resolve(args.systemPrompt);
      const relative = path.relative(docsDir, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        emitAndExit({ event: 'error', phase: 'validation', error: `--system-prompt path must be under plugin docs/ directory. Got: ${args.systemPrompt}` }, 1);
      }
      systemPromptContent = fs.readFileSync(resolved, 'utf-8');
      if (!systemPromptContent.trim()) {
        emitAndExit({ event: 'error', phase: 'validation', error: `--system-prompt file is empty: ${args.systemPrompt}` }, 1);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        emitAndExit({ event: 'error', phase: 'validation', error: `--system-prompt file not found: ${args.systemPrompt}` }, 1);
      }
      // Re-throw if not already handled by emitAndExit (which calls process.exit)
      throw err;
    }
  }

  // Load preset — no session yet, emitAndExit is safe
  let preset: ApiPreset;
  try {
    const presets = readPresets();
    const p = presets.presets[args.preset];
    if (!p) {
      const available = Object.keys(presets.presets).join(', ');
      emitAndExit({ event: 'error', phase: 'validation', error: `Preset '${args.preset}' not found. Available: ${available}` }, 1);
    }
    if (p.type !== 'api') {
      emitAndExit({ event: 'error', phase: 'validation', error: `Preset '${args.preset}' is type '${p.type}', expected 'api'` }, 1);
    }
    preset = p as ApiPreset;
  } catch (err) {
    emitAndExit({ event: 'error', phase: 'validation', error: `Failed to read presets: ${(err as Error).message}` }, 1);
  }

  // Validate model against preset — no session yet, emitAndExit is safe
  if (!preset.models.includes(args.model)) {
    emitAndExit({
      event: 'error', phase: 'validation',
      error: `Model '${args.model}' not in preset's models: [${preset.models.join(', ')}]`,
    }, 1);
  }

  // Apply working directory so sessions operate in the target project
  try {
    process.chdir(args.cwd);
  } catch (err) {
    emitAndExit({ event: 'error', phase: 'validation', error: `Failed to change to working directory '${args.cwd}': ${(err as Error).message}` }, 1);
  }

  // Create runner based on protocol and execute task
  const runner = createRunner(preset);
  const result = await runner.run(args.task, {
    model: args.model,
    systemPromptContent,
    timeoutMs: args.taskTimeoutMs,
    cwd: args.cwd,
    debugEnabled,
    presetName: args.preset,
  });

  // Map AgentRunResult to OutputEvent
  let output: OutputEvent;
  let exitCode: number;

  if (result.timedOut) {
    output = { event: 'error', phase: 'execution', error: 'Task execution timed out' };
    exitCode = 3;
  } else if (result.error) {
    output = { event: 'error', phase: 'execution', error: result.error };
    exitCode = 2;
  } else {
    output = {
      event: 'complete',
      provider: args.preset,
      model: args.model,
      result: result.result || 'Task completed successfully',
    };
    exitCode = 0;
  }

  emitAndExit(output, exitCode);
}

if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof Error) {
      console.error(`[api-task-runner] Error: ${err.message}`);
    } else {
      console.error('[api-task-runner] Unknown error:', err);
    }
    process.exit(2);
  });
}

// Exports for testing
export { type OutputEvent };
