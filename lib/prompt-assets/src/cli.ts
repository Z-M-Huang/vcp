/**
 * Prompt-assets CLI — list/get/discover system prompts.
 *
 * Has no `if (import.meta.main)` block: invoked exclusively by a host
 * shim (e.g. plugins/dev-buddy/scripts/system-prompts.ts) which knows
 * the absolute path of its plugin-local prompts directory.
 */

import { listSystemPromptNames, getSystemPrompt, discoverSystemPrompts } from './index.ts';

export interface PromptsCliOverrides {
  /** Absolute path to the host's built-in prompts directory. Required. */
  promptsDir: string;
}

export async function runCli(overrides: PromptsCliOverrides): Promise<void> {
  const command = process.argv[2];
  const builtInDir = process.argv.includes('--agents-dir')
    ? process.argv[process.argv.indexOf('--agents-dir') + 1]
    : overrides.promptsDir;

  if (!builtInDir) {
    console.error('No prompts directory configured. Pass --agents-dir <path> or invoke via the dev-buddy shim.');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'list': {
        const names = listSystemPromptNames(builtInDir);
        console.log(JSON.stringify(names, null, 2));
        break;
      }
      case 'get': {
        const name = process.argv[3];
        if (!name) { console.error('Usage: system-prompts.ts get <name>'); process.exit(1); }
        const prompt = getSystemPrompt(name, builtInDir);
        if (!prompt) { console.error(`System prompt '${name}' not found`); process.exit(1); }
        console.log(JSON.stringify({ name: prompt.name, description: prompt.description, tools: prompt.tools, source: prompt.source }, null, 2));
        break;
      }
      case 'discover': {
        const all = discoverSystemPrompts(builtInDir);
        console.log(JSON.stringify(all.map(p => ({ name: p.name, description: p.description, source: p.source })), null, 2));
        break;
      }
      default:
        console.error('Usage: system-prompts.ts <list|get|discover> [args]');
        process.exit(1);
    }
  } catch (err) {
    console.error(`[System Prompts] Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
