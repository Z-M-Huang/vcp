#!/usr/bin/env bun
/**
 * API Task Runner — lightweight per-invocation script for API preset tasks.
 *
 * Creates a V2 Agent SDK session, sends a single task, outputs the result, and exits.
 * Replaces the heavyweight session-manager HTTP server for both one-shot and pipeline use.
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

// ================== ENV CONSTRUCTION ==================

/**
 * Build the base env object from the ENV_ALLOWLIST.
 * Inherits allowlisted host vars only — no provider-specific vars.
 * Both Anthropic and OpenAI env builders call this to avoid duplicating
 * the allowlist loop.
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

/**
 * Build the env object for an OpenAI-compatible session from an API preset.
 * Inherits allowlisted host vars + sets OPENAI_BASE_URL and CODEX_API_KEY.
 * Does NOT set ANTHROPIC_* vars or model alias vars (OpenAI SDK uses its own discovery).
 */
export function buildOpenAISessionEnv(preset: ApiPreset): Record<string, string> {
  const env = buildBaseEnv();
  env.OPENAI_BASE_URL = preset.base_url;
  env.CODEX_API_KEY = preset.api_key;
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

// ================== OPENAI SESSION ==================

/**
 * Run a task via the OpenAI-compatible API.
 *
 * Attempts to dynamically import @openai/codex-sdk first.
 * If the SDK is not installed or its API surface differs, falls back to raw HTTP
 * fetch to /v1/chat/completions (same endpoint used by testOpenAIModel in config-server).
 *
 * The system prompt (if provided) is prepended to the task text as a
 * [SYSTEM INSTRUCTIONS] block since the Codex SDK may not support native
 * system prompts.
 *
 * Per AC10: dynamic import failure must produce a JSON error envelope + exit code 1.
 */
export async function runOpenAISession(
  preset: ApiPreset,
  model: string,
  taskText: string,
  timeoutMs: number,
): Promise<string> {
  // Build the full prompt (system prompt prepended as a framing block)
  const fullPrompt = taskText;

  // Raw HTTP fallback to /v1/chat/completions — used when SDK is not installed
  // or its API surface differs from what we expect.
  async function rawHttpFallback(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(`${preset.base_url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${preset.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: fullPrompt }],
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`OpenAI API returned ${resp.status}: ${resp.statusText}`);
      }

      const data = await resp.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('OpenAI API returned unexpected response format');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  // Attempt dynamic import of @openai/codex-sdk.
  // If not installed, emit JSON error with install instructions and exit.
  let sdkModule: any = null;
  try {
    sdkModule = await import('@openai/codex-sdk');
  } catch {
    // SDK not installed — report with install guidance (exit code 1 = validation error)
    emitAndExit({
      event: 'error',
      phase: 'validation',
      error: 'OpenAI Codex SDK not installed. Run: npm install @openai/codex-sdk',
    }, 1);
  }

  // SDK imported successfully — attempt to use it.
  // The @openai/codex-sdk API surface is unverified; fall back to raw HTTP if it
  // doesn't match expected shape.
  try {
    // Expected API surface (unverified): Codex constructor + startThread + run
    const Codex = sdkModule.Codex ?? sdkModule.default?.Codex ?? sdkModule.default;
    if (typeof Codex !== 'function') {
      throw new Error('Unexpected SDK shape — falling back to raw HTTP');
    }

    const env = buildOpenAISessionEnv(preset);
    const codex = new Codex({ env, config: { model } });

    type RunResult = { result: string } | { error: string };
    const sdkPromise = new Promise<string>(async (resolve, reject) => {
      try {
        const thread = await codex.startThread();
        const result: RunResult = await thread.run(fullPrompt);
        if ('error' in result) {
          reject(new Error(result.error));
        } else {
          resolve(result.result);
        }
      } catch (err) {
        reject(err);
      }
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`OpenAI session timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });

    return await Promise.race([sdkPromise, timeoutPromise]);
  } catch {
    // SDK API differs from expected — fall back to raw HTTP
    return rawHttpFallback();
  }
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

  // Apply working directory so V2 session operates in the target project
  try {
    process.chdir(args.cwd);
  } catch (err) {
    emitAndExit({ event: 'error', phase: 'validation', error: `Failed to change to working directory '${args.cwd}': ${(err as Error).message}` }, 1);
  }

  // Determine protocol: default to 'anthropic' for backward compatibility
  // If adding a 3rd protocol, extract to ProtocolAdapter interface
  const protocol = preset.protocol ?? 'anthropic';

  let output: OutputEvent = { event: 'error', phase: 'execution', error: 'unexpected: no result produced' };
  let exitCode: number = 2;

  if (protocol === 'openai') {
    // =========== OpenAI Protocol Path ===========
    const env = buildOpenAISessionEnv(preset);

    // Build task text, prepending system prompt as framing block if provided
    const taskWithPrompt = systemPromptContent
      ? `[SYSTEM INSTRUCTIONS]\n${systemPromptContent}\n\n[TASK]\n${args.task}`
      : args.task;

    // Debug logging: 4 individual writes (not batched — guaranteed writes on crash)
    await vcpLog(args.cwd, {
      source: 'api-task-runner', event: 'session_env', decision: 'info',
      details: JSON.stringify(Object.fromEntries(
        Object.entries(env).map(([k, v]) =>
          k === 'CODEX_API_KEY' ? [k, maskApiKey(v)] : [k, v]
        )
      )),
    }, debugEnabled);
    await vcpLog(args.cwd, {
      source: 'api-task-runner', event: 'session_config', decision: 'info',
      details: `protocol=openai model=${args.model} preset=${args.preset}`,
    }, debugEnabled);
    await vcpLog(args.cwd, {
      source: 'api-task-runner', event: 'session_system_prompt', decision: 'info',
      details: systemPromptContent ?? 'none',
    }, debugEnabled);
    await vcpLog(args.cwd, {
      source: 'api-task-runner', event: 'session_task', decision: 'info',
      details: args.task,
    }, debugEnabled);

    try {
      const result = await runOpenAISession(preset, args.model, taskWithPrompt, args.taskTimeoutMs);
      output = {
        event: 'complete',
        provider: args.preset,
        model: args.model,
        result: result || 'Task completed successfully',
      };
      exitCode = 0;
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('timed out')) {
        output = { event: 'error', phase: 'execution', error: 'Task execution timed out' };
        exitCode = 3;
      } else {
        output = { event: 'error', phase: 'execution', error: errMsg };
        exitCode = 2;
      }
    }
  } else {
    // =========== Anthropic Protocol Path (default) ===========
    // Session lifecycle — if/else chain ensures control always falls through
    // to emitAndExit() after the try/catch/finally block.
    // NOTE: Do NOT use `return` inside the try block — it would skip emitAndExit().
    const env = buildSessionEnv(preset, args.model);
    let session: any = null;

    // Debug logging: 4 individual writes (not batched — guaranteed writes on crash)
    await vcpLog(args.cwd, {
      source: 'api-task-runner', event: 'session_env', decision: 'info',
      details: JSON.stringify(Object.fromEntries(
        Object.entries(env).map(([k, v]) =>
          k === 'ANTHROPIC_API_KEY' ? [k, maskApiKey(v)] : [k, v]
        )
      )),
    }, debugEnabled);
    await vcpLog(args.cwd, {
      source: 'api-task-runner', event: 'session_config', decision: 'info',
      details: `protocol=anthropic model=${args.model} preset=${args.preset} permissionMode=default`,
    }, debugEnabled);
    await vcpLog(args.cwd, {
      source: 'api-task-runner', event: 'session_system_prompt', decision: 'info',
      details: systemPromptContent ?? 'none',
    }, debugEnabled);
    await vcpLog(args.cwd, {
      source: 'api-task-runner', event: 'session_task', decision: 'info',
      details: args.task,
    }, debugEnabled);

    try {
      await vcpLog(args.cwd, {
        source: 'api-task-runner', event: 'session_create', decision: 'info',
        details: `preset=${args.preset} model=${args.model} key=${maskApiKey(preset.api_key)}`,
      }, debugEnabled);

      session = unstable_v2_createSession({
        model: args.model,
        env,
        permissionMode: 'default',
        allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
        // Append review guidelines to default system prompt when provided
        ...(systemPromptContent && {
          systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptContent },
        }),
      });

      // Warmup — blocks until session is live
      await session.send('Respond with OK');
      const warmupResult = await collectSessionResult(session, WARMUP_TIMEOUT_MS);
      if (warmupResult.error) {
        output = { event: 'error', phase: 'warmup', error: `Warmup failed: ${warmupResult.error}` };
        exitCode = 2;
      } else {
        await vcpLog(args.cwd, {
          source: 'api-task-runner', event: 'session_ready', decision: 'info',
          details: `preset=${args.preset} model=${args.model}`,
        }, debugEnabled);

        // Send task
        await session.send(args.task);
        const result = await collectSessionResult(session, args.taskTimeoutMs);

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
      }
    } catch (err) {
      output = { event: 'error', phase: 'execution', error: (err as Error).message };
      exitCode = 2;
    } finally {
      if (session) {
        try { session.close(); } catch { /* best effort */ }
      }
    }
  }

  // Emit result and exit (after session is properly closed)
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
// buildBaseEnv and buildOpenAISessionEnv are exported via named export above
