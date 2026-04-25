/**
 * Dev-buddy system-prompts CLI shim — delegates to @vcp-lib/prompt-assets.
 *
 * The plugin keeps this file at its historical path so:
 *   1. `import { ... } from './system-prompts.ts'` from sibling scripts and tests
 *      continues to resolve via the re-export.
 *   2. `bun "<pluginRoot>/scripts/system-prompts.ts" list|get|discover`
 *      keeps working — the shim resolves the dev-buddy-local prompts dir and
 *      hands it to the lib's CLI.
 *
 * Built-in role prompts live at `<pluginRoot>/system-prompts/built-in/*.md`;
 * the lib loader is unchanged in shape (takes the dir as argument).
 */

import path from 'path';
import { runCli } from '@vcp-lib/prompt-assets/cli';

export * from '@vcp-lib/prompt-assets';

if (import.meta.main) {
  const PLUGIN_ROOT = path.join(import.meta.dir, '..');
  await runCli({ promptsDir: path.join(PLUGIN_ROOT, 'system-prompts', 'built-in') });
}
