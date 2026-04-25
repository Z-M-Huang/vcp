/**
 * Dev-buddy api-task-runner CLI shim — delegates to @vcp-lib/llm-runner.
 *
 * The plugin keeps this file at its historical path because pipeline runners
 * (one-shot-runner.ts, stage-runner.ts) and SKILL.md prose invoke it as
 * `bun "<pluginRoot>/scripts/api-task-runner.ts"`. The module re-export preserves
 * the historical import surface used by tests and other dev-buddy scripts.
 *
 * Prompt and stage directories live in dev-buddy (system-prompts/built-in/, stages/);
 * the shim resolves them once at CLI invocation and passes them as overrides to
 * the lib's CLI orchestrator.
 */

import path from 'path';
import { runCliWithFatalHandler } from '@vcp-lib/llm-runner/cli';

export * from '@vcp-lib/llm-runner';

if (import.meta.main) {
  const PLUGIN_ROOT = path.join(import.meta.dir, '..');
  await runCliWithFatalHandler({
    promptsDir: path.join(PLUGIN_ROOT, 'system-prompts', 'built-in'),
    stagesDir: path.join(PLUGIN_ROOT, 'stages'),
  });
}
