/**
 * LLM runner — per-invocation Vercel AI SDK driver.
 *
 * Uses Vercel AI SDK's streamText() with agentool for tool execution.
 * Routes to the correct provider constructor based on preset.protocol.
 *
 * Each invocation is an independent process — multiple instances can run in parallel
 * without shared state, ports, or file locks.
 *
 * Pure module: no CLI, no process.exit, no top-level side effects beyond
 * creating the shared logger handle.
 */

import { generateText, streamText, stepCountIs } from 'ai';
import type { ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createBash, createRead, createWrite, createEdit, createGlob, createGrep } from 'agentool';
import { compactMessages } from 'agentool/context-compaction';
import { readPresets, maskApiKey } from './presets.ts';
import { MODEL_NAME_REGEX } from '@vcp-lib/prompt-assets/stage-definitions';
import { createLogger } from '@vcp-lib/logging';
import type { ApiPreset } from './types.ts';

const vcpLog = createLogger('dev-buddy.log');

// ================== CONFIGURATION ==================

/** Default per-task timeout: 5 minutes (300s). */
export const DEFAULT_TASK_TIMEOUT_MS = 300_000;

/** Max agent loop steps for generateText. */
export const MAX_AGENT_STEPS = 100;

/** Default context window when the preset does not specify `max_context_tokens`. */
export const DEFAULT_CONTEXT_TOKENS = 200_000;

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
    const logSource = `api-task-runner[${options.presetName}/${options.model}]`;

    // Debug logging (3 entries)
    await vcpLog(options.cwd, {
      source: logSource, event: 'session_config', decision: 'info',
      details: `protocol=${protocol} model=${options.model} preset=${options.presetName} base_url=${this.preset.base_url} key=${maskApiKey(this.preset.api_key)}`,
    }, options.debugEnabled);
    await vcpLog(options.cwd, {
      source: logSource, event: 'session_system_prompt', decision: 'info',
      details: options.systemPromptContent ?? 'none',
    }, options.debugEnabled);
    await vcpLog(options.cwd, {
      source: logSource, event: 'session_task', decision: 'info',
      details: task,
    }, options.debugEnabled);

    try {
      const model = this.createModel(protocol, options.model);
      const tools = buildToolSet(options.allowedTools);

      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), options.timeoutMs);

      // Sanitize strings for single-line log entries: escape newlines, then truncate.
      const sanitize = (s: string, max: number) => {
        const escaped = s.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        return escaped.length > max ? escaped.slice(0, max - 3) + '...' : escaped;
      };

      const maxOutputTokens = this.resolveMaxOutputTokens();
      const maxContextTokens = this.resolveMaxContextTokens();
      const reservedOutputTokens = this.resolveReservedOutputTokens(maxContextTokens);
      const summaryTargetTokens = Math.floor(maxContextTokens * 0.05);

      const onStepFinish = options.debugEnabled
        ? async (step: any) => {
            try {
              await vcpLog(options.cwd, {
                source: logSource, event: 'step_finish', decision: 'info',
                details: `step=${step.stepNumber} finish=${step.finishReason} `
                  + `text=${step.text.length}ch tokens=${JSON.stringify(step.usage)}`,
              }, true);

              for (const tc of step.toolCalls) {
                await vcpLog(options.cwd, {
                  source: logSource, event: 'step_tool_call', decision: 'info',
                  details: `step=${step.stepNumber} tool=${tc.toolName} `
                    + `input=${sanitize(JSON.stringify(tc.input), 500)}`,
                }, true);
              }

              for (const tr of step.toolResults) {
                const output = typeof tr.output === 'string'
                  ? tr.output : JSON.stringify(tr.output);
                await vcpLog(options.cwd, {
                  source: logSource, event: 'step_tool_result', decision: 'info',
                  details: `step=${step.stepNumber} tool=${tr.toolName} `
                    + `output=${sanitize(output, 500)}`,
                }, true);
              }

              if (step.text) {
                await vcpLog(options.cwd, {
                  source: logSource, event: 'step_text', decision: 'info',
                  details: `step=${step.stepNumber} text=${sanitize(step.text, 500)}`,
                }, true);
              }
            } catch {
              // Never let debug logging break execution
            }
          }
        : undefined;

      // Caller-driven step loop: compaction runs before every inner streamText.
      // Each outer iteration runs one inner step (stopWhen: stepCountIs(1)) so
      // that we can re-run compaction between model calls. agentool 1.3's
      // compactMessages returns the same `messages` reference (===) when the
      // conversation is under the auto-compact threshold — no cost when idle.
      let messages: ModelMessage[] = [{ role: 'user', content: task }];
      let lastText = '';
      let lastFinishReason: string | undefined;
      let lastUsage: unknown = undefined;
      const allSteps: any[] = [];

      try {
        for (let outer = 0; outer < MAX_AGENT_STEPS; outer++) {
          messages = await compactMessages({
            messages,
            summaryModel: model,
            maxContextTokens,
            autoCompactThresholdPct: 0.80,
            summaryTargetTokens,
            reservedOutputTokens,
            onCompactionFailure: 'passthrough',
          });

          const stream = this.streamTextFn({
            model,
            tools,
            stopWhen: stepCountIs(1),
            system: options.systemPromptContent,
            messages,
            maxOutputTokens,
            abortSignal: abortController.signal,
            ...(this.preset.reasoning_effort && {
              providerOptions: { openai: { reasoningEffort: this.preset.reasoning_effort } },
            }),
            ...(onStepFinish && { onStepFinish }),
          });

          const [text, steps, response, finishReason, usage] = await Promise.all([
            stream.text, stream.steps, stream.response, stream.finishReason, stream.usage,
          ]);

          lastText = text;
          lastFinishReason = finishReason;
          lastUsage = usage;
          if (Array.isArray(steps)) allSteps.push(...steps);
          const responseMessages = (response?.messages ?? []) as ModelMessage[];
          if (responseMessages.length > 0) {
            messages = [...messages, ...responseMessages];
          }

          // Only 'tool-calls' requires another round — the model wants tool
          // execution results fed back in. Every other finish reason ('stop',
          // 'length', 'content-filter', 'error', 'other') is terminal.
          if (finishReason !== 'tool-calls') break;
          // Defensive: a tool-calls finish with zero response messages means
          // nothing to feed back — bail rather than spin.
          if (responseMessages.length === 0) break;
        }

        // Always log response shape — critical for diagnosing empty-response issues.
        const stepDetails = allSteps.map((s, i) =>
          `${i}:text=${s.text.length}ch/tools=${s.toolCalls?.length ?? 0}/finish=${s.finishReason}`
        ).join(' ');
        const accumulatedResponseMessages = Math.max(0, messages.length - 1);
        await vcpLog(options.cwd, {
          source: logSource, event: 'response_shape', decision: 'info',
          details: `text=${lastText.length}ch steps=${allSteps.length} finish=${lastFinishReason} `
            + `tokens=${JSON.stringify(lastUsage)} msgs=${accumulatedResponseMessages} [${stepDetails}]`,
        }, options.debugEnabled);

        // lastText only contains the FINAL inner step's text. If that step was a
        // tool call with no accompanying text, lastText is empty even though
        // intermediate steps contain the actual response.
        const stepsText = allSteps.map(s => s.text).filter(Boolean).join('\n\n').trim();

        if (lastText || stepsText) {
          return { result: lastText || stepsText, error: null, timedOut: false };
        }

        // Fallback: extract text content directly from accumulated response
        // messages. The SDK's .text/.steps[].text can miss content when
        // OpenAI-protocol gateways return it in a shape the accumulator
        // doesn't recognize. Skip the leading user message (messages[0]).
        const messagesText = messages
          .slice(1)
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
            source: logSource, event: 'response_fallback', decision: 'info',
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

  /**
   * Resolve the max context window for compaction. Falls back to DEFAULT_CONTEXT_TOKENS
   * when the preset's value is missing, non-numeric, or non-positive.
   */
  private resolveMaxContextTokens(): number {
    const v = this.preset.max_context_tokens;
    return typeof v === 'number' && v > 0 ? v : DEFAULT_CONTEXT_TOKENS;
  }

  /**
   * Clamp reservedOutputTokens for compactMessages so it stays below the context
   * window. Matches prior middleware wiring: use max_output_tokens if it fits,
   * otherwise fall back to min(16384, 10% of context).
   */
  private resolveReservedOutputTokens(maxContextTokens: number): number {
    const maxOutput = this.resolveMaxOutputTokens();
    if (maxOutput && maxOutput < maxContextTokens) return maxOutput;
    return Math.min(16384, Math.floor(maxContextTokens * 0.1));
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
