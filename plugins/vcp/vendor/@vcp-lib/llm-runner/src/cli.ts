/**
 * LLM runner CLI — argv → preset/model resolution → run → JSON output.
 *
 * Has no `if (import.meta.main)` block: invoked exclusively by a host
 * shim (e.g. plugins/dev-buddy/scripts/api-task-runner.ts) which knows
 * the absolute path of its plugin-local prompts/stages directories.
 */

import { createLogger, isDebugEnabled } from '@vcp-lib/logging';
import { parseArgs, createRunner } from './runner.ts';
import type { ParsedArgs } from './runner.ts';
import { readPresets } from './presets.ts';
import type { ApiPreset } from './types.ts';

const vcpLog = createLogger('dev-buddy.log');

export interface CliOverrides {
  /** Absolute path to the host's built-in role-prompt directory. Required when --system-prompt is used. */
  promptsDir?: string;
  /** Absolute path to the host's stage-definitions directory. Required when --stage-type is used. */
  stagesDir?: string;
}

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

export async function runCli(overrides: CliOverrides = {}): Promise<void> {
  const debugEnabled = await isDebugEnabled();

  // Parse args — no session yet, emitAndExit is safe
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    emitAndExit({ event: 'error', phase: 'validation', error: (err as Error).message }, 1);
  }

  // Read task from stdin if --task-stdin was set (avoids argv size limits + ps exposure)
  if (args!.taskFromStdin) {
    try {
      args!.task = await new Response(Bun.stdin.stream()).text();
      if (!args!.task.trim()) {
        emitAndExit({ event: 'error', phase: 'validation', error: 'No task provided on stdin' }, 1);
      }
    } catch (err) {
      emitAndExit({ event: 'error', phase: 'validation', error: `Failed to read task from stdin: ${(err as Error).message}` }, 1);
    }
  }

  // Resolve --system-prompt role name to prompt content
  let systemPromptContent: string | undefined;
  if (args!.systemPrompt) {
    if (!overrides.promptsDir) {
      emitAndExit({ event: 'error', phase: 'validation', error: '--system-prompt requires the host shim to supply a promptsDir override' }, 1);
    }
    const { getSystemPrompt, discoverSystemPrompts } = await import('@vcp-lib/prompt-assets');
    const rolePrompt = getSystemPrompt(args!.systemPrompt, overrides.promptsDir!);
    if (!rolePrompt) {
      const available = discoverSystemPrompts(overrides.promptsDir!).map(p => p.name);
      emitAndExit({ event: 'error', phase: 'validation', error: `--system-prompt role '${args!.systemPrompt}' not found. Available: ${available.join(', ')}` }, 1);
    }
    systemPromptContent = rolePrompt!.content;
  }

  // Auto-resolve stage definition and compose with system prompt if --stage-type provided
  if (args!.stageType) {
    if (!overrides.stagesDir) {
      emitAndExit({ event: 'error', phase: 'validation', error: '--stage-type requires the host shim to supply a stagesDir override' }, 1);
    }
    const { loadStageDefinition } = await import('@vcp-lib/prompt-assets');
    const stageDef = loadStageDefinition(args!.stageType, overrides.stagesDir!);
    if (!stageDef) {
      emitAndExit({ event: 'error', phase: 'validation', error: `Stage definition not found for type '${args!.stageType}' in ${overrides.stagesDir}` }, 1);
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
    const p = presets.presets[args!.preset];
    if (!p) {
      const available = Object.keys(presets.presets).join(', ');
      emitAndExit({ event: 'error', phase: 'validation', error: `Preset '${args!.preset}' not found. Available: ${available}` }, 1);
    }
    if (p.type !== 'api') {
      emitAndExit({ event: 'error', phase: 'validation', error: `Preset '${args!.preset}' is type '${p.type}', expected 'api'` }, 1);
    }
    preset = p as ApiPreset;
  } catch (err) {
    emitAndExit({ event: 'error', phase: 'validation', error: `Failed to read presets: ${(err as Error).message}` }, 1);
  }

  // Validate model against preset — no session yet, emitAndExit is safe
  if (!preset!.models.includes(args!.model)) {
    emitAndExit({
      event: 'error', phase: 'validation',
      error: `Model '${args!.model}' not in preset's models: [${preset!.models.join(', ')}]`,
    }, 1);
  }

  // Apply working directory so sessions operate in the target project
  try {
    process.chdir(args!.cwd);
  } catch (err) {
    emitAndExit({ event: 'error', phase: 'validation', error: `Failed to change to working directory '${args!.cwd}': ${(err as Error).message}` }, 1);
  }

  // Create runner based on protocol and execute task
  const runner = createRunner(preset!);
  const result = await runner.run(args!.task, {
    model: args!.model,
    systemPromptContent,
    timeoutMs: args!.taskTimeoutMs,
    cwd: args!.cwd,
    debugEnabled,
    presetName: args!.preset,
    allowedTools: args!.allowedTools,
  });

  // Stream mode: plain text to stdout, errors to stderr (for one-shot / stdio:inherit)
  if (args!.stream) {
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
      provider: args!.preset,
      model: args!.model,
      result: result.result || 'Task completed successfully',
    };
    exitCode = 0;
  }

  emitAndExit(output, exitCode);
}

/** Top-level fatal handler used by the host shim. */
export async function runCliWithFatalHandler(overrides: CliOverrides = {}): Promise<void> {
  try {
    await runCli(overrides);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const debug = await isDebugEnabled().catch(() => false);
    await vcpLog(process.cwd(), {
      source: 'api-task-runner', event: 'fatal', decision: 'error', details: msg,
    }, debug).catch(() => {});
    console.error(`[api-task-runner] Fatal: ${msg}`);
    process.exit(2);
  }
}
