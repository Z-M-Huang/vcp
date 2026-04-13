#!/usr/bin/env bun
/**
 * API Task Runner — lightweight per-invocation script for API preset tasks.
 *
 * Uses Vercel AI SDK's generateText() with agentool for tool execution.
 * Routes to the correct provider constructor based on preset.protocol.
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

import path from 'path';
import { generateText, streamText, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createBash, createRead, createWrite, createEdit, createGlob, createGrep } from 'agentool';
import { readPresets, maskApiKey } from './preset-utils.ts';
import { MODEL_NAME_REGEX } from '../types/stage-definitions.ts';
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';
import type { ApiPreset } from '../types/presets.ts';

// ================== CONFIGURATION ==================

/** Default per-task timeout: 5 minutes (300s). */
export const DEFAULT_TASK_TIMEOUT_MS = 300_000;

/** Max agent loop steps for generateText. */
export const MAX_AGENT_STEPS = 100;

// ================== AGENT RUNNER INTERFACE ==================

export interface AgentRunOptions {
  model: string;
  systemPromptContent?: string;
  timeoutMs: number;
  cwd: string;
  debugEnabled: boolean;
  presetName: string;
  /** PascalCase tool names to restrict available tools. Empty/undefined = all tools. */
  allowedTools?: string[];
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
 * Canonical tool registry — single source of truth for PascalCase name to agentool key mapping.
 * PascalCase names are the stable external API (used in --allowed-tools and stage definitions).
 */
export const TOOL_REGISTRY: ReadonlyArray<{ name: string; key: string }> = [
  { name: 'Read',  key: 'read' },
  { name: 'Write', key: 'write' },
  { name: 'Edit',  key: 'edit' },
  { name: 'Bash',  key: 'bash' },
  { name: 'Glob',  key: 'glob' },
  { name: 'Grep',  key: 'grep' },
];

/** PascalCase tool names for --allowed-tools filtering. */
export const TOOL_NAMES = TOOL_REGISTRY.map(t => t.name);

/**
 * Resolve PascalCase --allowed-tools to agentool key names.
 * Returns all keys when allowedTools is empty/undefined.
 */
export function resolveAllowedTools(allowedTools?: string[]): Set<string> {
  if (!allowedTools?.length) return new Set(TOOL_REGISTRY.map(t => t.key));
  const allowed = new Set(allowedTools);
  return new Set(
    TOOL_REGISTRY.filter(t => allowed.has(t.name)).map(t => t.key)
  );
}

/**
 * Build the tool set for generateText from agentool factories.
 * Filters based on --allowed-tools PascalCase names.
 */
export function buildToolSet(allowedTools?: string[]): Record<string, ReturnType<typeof createBash>> {
  const allowed = resolveAllowedTools(allowedTools);

  const all: Record<string, ReturnType<typeof createBash>> = {
    read: createRead(),
    write: createWrite(),
    edit: createEdit(),
    bash: createBash(),
    glob: createGlob(),
    grep: createGrep(),
  };

  const filtered: Record<string, ReturnType<typeof createBash>> = {};
  for (const [key, tool] of Object.entries(all)) {
    if (allowed.has(key)) filtered[key] = tool;
  }
  return filtered;
}

// ================== GATEWAY COMPAT ==================

/**
 * Custom fetch wrapper for Anthropic-protocol gateways that return non-compliant responses.
 *
 * Problem: @ai-sdk/anthropic validates response JSON with Zod. Anthropic's API includes
 * a `signature` field on `type: "thinking"` content blocks, but third-party gateways
 * (e.g., Bailian) omit it, causing Zod validation to fail.
 *
 * Fix: intercept the response, strip any thinking blocks that lack a `signature` field.
 * This is safe because thinking blocks are model-internal reasoning — they don't affect
 * the generated text or tool calls that the SDK extracts.
 */
export async function gatewayCompatFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);

  // Only patch successful JSON responses (SSE streams don't need patching —
  // the SDK's stream parser is more lenient than the batch JSON validator).
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('application/json')) {
    return response;
  }

  const body = await response.text();
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    // Not valid JSON — return as-is and let the SDK handle the error.
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Patch: filter out thinking blocks without a signature field.
  if (Array.isArray(json.content)) {
    json.content = json.content.filter(
      (block: any) => block.type !== 'thinking' || typeof block.signature === 'string',
    );
  }

  return new Response(JSON.stringify(json), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ================== UNIFIED RUNNER ==================

/**
 * Unified runner using Vercel AI SDK's streamText() with agentool tools.
 * Uses streaming to ensure compatibility with OpenAI-compatible gateways that
 * only return content via SSE (returning content:null for non-streaming requests).
 * Handles both 'anthropic' and 'openai' protocols via different provider constructors.
 */
export class UnifiedRunner implements AgentRunner {
  private streamTextFn: typeof streamText;
  constructor(private preset: ApiPreset, streamTextFn?: typeof streamText) {
    this.streamTextFn = streamTextFn ?? streamText;
  }

  async run(task: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const protocol = this.preset.protocol ?? 'anthropic';

    // Debug logging (3 entries)
    await vcpLog(options.cwd, {
      source: 'api-task-runner', event: 'session_config', decision: 'info',
      details: `protocol=${protocol} model=${options.model} preset=${options.presetName} base_url=${this.preset.base_url} key=${maskApiKey(this.preset.api_key)}`,
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
      const model = this.createModel(protocol, options.model);
      const tools = buildToolSet(options.allowedTools);

      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), options.timeoutMs);

      try {
        const stream = this.streamTextFn({
          model,
          tools,
          stopWhen: stepCountIs(MAX_AGENT_STEPS),
          system: options.systemPromptContent,
          prompt: task,
          maxOutputTokens: this.resolveMaxOutputTokens(),
          abortSignal: abortController.signal,
          ...(this.preset.reasoning_effort && {
            providerOptions: { openai: { reasoningEffort: this.preset.reasoning_effort } },
          }),
        });

        const [text, steps, response, finishReason, usage] = await Promise.all([
          stream.text, stream.steps, stream.response, stream.finishReason, stream.usage,
        ]);

        // Always log response shape — critical for diagnosing empty-response issues
        const stepDetails = steps.map((s, i) =>
          `${i}:text=${s.text.length}ch/tools=${s.toolCalls?.length ?? 0}/finish=${s.finishReason}`
        ).join(' ');
        await vcpLog(options.cwd, {
          source: 'api-task-runner', event: 'response_shape', decision: 'info',
          details: `text=${text.length}ch steps=${steps.length} finish=${finishReason} `
            + `tokens=${JSON.stringify(usage)} msgs=${response?.messages?.length ?? 0} [${stepDetails}]`,
        }, options.debugEnabled);

        // text only contains the LAST step's text. If the model's final
        // step is a tool call with no accompanying text, text is empty
        // even though intermediate steps contain the actual response.
        const stepsText = steps.map(s => s.text).filter(Boolean).join('\n\n').trim();

        if (text || stepsText) {
          return { result: text || stepsText, error: null, timedOut: false };
        }

        // Fallback: extract text content directly from response messages.
        // The SDK's .text/.steps[].text can miss content when OpenAI-protocol
        // gateways return it in a shape the accumulator doesn't recognize.
        const messagesText = (response?.messages ?? [])
          .filter((m: any) => m.role === 'assistant')
          .flatMap((m: any) => {
            if (typeof m.content === 'string') return [m.content];
            if (Array.isArray(m.content)) {
              return m.content
                .filter((c: any) => c.type === 'text' && c.text)
                .map((c: any) => c.text as string);
            }
            return [];
          })
          .filter(Boolean)
          .join('\n\n')
          .trim();

        if (messagesText) {
          await vcpLog(options.cwd, {
            source: 'api-task-runner', event: 'response_fallback', decision: 'info',
            details: `recovered ${messagesText.length}ch from response.messages (text/stepsText were empty)`,
          }, options.debugEnabled);
          return { result: messagesText, error: null, timedOut: false };
        }

        return {
          result: 'Task completed (no text response)',
          error: null,
          timedOut: false,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if ((err as Error).name === 'AbortError' || msg.includes('abort')) {
        return { result: null, error: `task timed out after ${options.timeoutMs / 1000}s`, timedOut: true };
      }
      return { result: null, error: msg, timedOut: false };
    }
  }

  private createModel(protocol: string, modelId: string) {
    if (protocol === 'openai') {
      // @ai-sdk/openai expects baseURL to include /v1 (default: https://api.openai.com/v1).
      // The web portal strips /v1 on save, so presets store URLs WITHOUT /v1.
      // Normalize: strip any trailing /v1, then re-append to ensure exactly one.
      // MUST use .chat() — .responses() is the default since AI SDK v5,
      // but third-party OpenAI-compatible gateways only implement /chat/completions.
      const baseURL = this.preset.base_url.replace(/\/v1\/?$/, '') + '/v1';
      return createOpenAI({ apiKey: this.preset.api_key, baseURL }).chat(modelId);
    }
    // Anthropic: @ai-sdk/anthropic expects baseURL to include /v1
    // (default: https://api.anthropic.com/v1, SDK appends /messages).
    // The web portal strips /v1 on save, so presets store URLs WITHOUT /v1.
    // Normalize: strip any trailing /v1, then re-append to ensure exactly one.
    // Uses gatewayCompatFetch to handle third-party gateways that return
    // non-compliant thinking blocks (missing `signature` field).
    const baseURL = this.preset.base_url.replace(/\/v1\/?$/, '') + '/v1';
    return createAnthropic({
      apiKey: this.preset.api_key,
      baseURL,
      fetch: gatewayCompatFetch,
    })(modelId);
  }

  private resolveMaxOutputTokens(): number | undefined {
    if (typeof this.preset.max_output_tokens === 'number' && this.preset.max_output_tokens > 0) {
      return this.preset.max_output_tokens;
    }
    return (this.preset.protocol ?? 'anthropic') === 'openai' ? 16384 : undefined;
  }
}

// ================== RUNNER FACTORY ==================

/**
 * Create the appropriate runner based on preset.
 * Both protocols are handled by UnifiedRunner via different provider constructors.
 */
export function createRunner(preset: ApiPreset): AgentRunner {
  return new UnifiedRunner(preset);
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
  /** Optional role name (e.g., 'discoverer') resolved via getSystemPrompt(). */
  systemPrompt?: string;
  /** Stage type for auto-resolving stage definition (e.g., 'plan-review', 'code-review'). */
  stageType?: string;
  /** When true, print result text to stdout instead of JSON wrapper. For one-shot mode. */
  stream: boolean;
  /** Comma-separated PascalCase tool names to restrict available tools. */
  allowedTools?: string[];
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
      case '--stage-type':
        if (!next) throw new Error('--stage-type requires a value');
        result.stageType = next;
        i++;
        break;
      case '--stream':
        result.stream = true;
        break;
      case '--allowed-tools':
        if (!next) throw new Error('--allowed-tools requires a value');
        result.allowedTools = next.split(',').map(t => t.trim());
        i++;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
        break;
    }
  }

  // Default --cwd to process.cwd() when not provided or empty
  // (CLAUDE_PROJECT_DIR may be unset in some environments)
  if (!result.cwd) result.cwd = process.cwd();

  const missing: string[] = [];
  if (!result.preset) missing.push('--preset');
  if (!result.model) missing.push('--model');
  if (!result.task && !result.taskFromStdin) missing.push('--task or --task-stdin');

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

  if (!result.stream) {
    result.stream = false;
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

  // Resolve --system-prompt role name to prompt content
  let systemPromptContent: string | undefined;
  if (args.systemPrompt) {
    const { getSystemPrompt } = await import('./system-prompts.ts');
    const builtInDir = path.join(import.meta.dir, '..', 'system-prompts', 'built-in');
    const rolePrompt = getSystemPrompt(args.systemPrompt, builtInDir);
    if (!rolePrompt) {
      const { discoverSystemPrompts } = await import('./system-prompts.ts');
      const available = discoverSystemPrompts(builtInDir).map(p => p.name);
      emitAndExit({ event: 'error', phase: 'validation', error: `--system-prompt role '${args.systemPrompt}' not found. Available: ${available.join(', ')}` }, 1);
    }
    systemPromptContent = rolePrompt!.content;
  }

  // Auto-resolve stage definition and compose with system prompt if --stage-type provided
  if (args.stageType) {
    const { loadStageDefinition } = await import('./system-prompts.ts');
    const stagesDir = path.join(import.meta.dir, '..', 'stages');
    const stageDef = loadStageDefinition(args.stageType, stagesDir);
    if (!stageDef) {
      emitAndExit({ event: 'error', phase: 'validation', error: `Stage definition not found for type '${args.stageType}' in ${stagesDir}` }, 1);
    }
    // Compose: stage definition content + existing system prompt content (role/guidelines)
    const roleContent = systemPromptContent ?? '';
    systemPromptContent = roleContent
      ? `${stageDef!.content}\n\n---\n\n${roleContent}`
      : stageDef!.content;
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
    allowedTools: args.allowedTools,
  });

  // Stream mode: plain text to stdout, errors to stderr (for one-shot / stdio:inherit)
  if (args.stream) {
    if (result.timedOut) {
      process.stderr.write('Error: Task execution timed out\n');
      process.exit(3);
    } else if (result.error) {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(2);
    } else {
      if (result.result) {
        process.stdout.write(result.result);
      }
      process.exit(0);
    }
  }

  // Pipeline mode: JSON output
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
  main().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const debug = await isDebugEnabled().catch(() => false);
    await vcpLog(process.cwd(), {
      source: 'api-task-runner', event: 'fatal', decision: 'error', details: msg,
    }, debug).catch(() => {});
    console.error(`[api-task-runner] Fatal: ${msg}`);
    process.exit(2);
  });
}

// Exports for testing
export { type OutputEvent };
