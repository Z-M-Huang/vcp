/**
 * System prompt discovery, management, and stage definition loading.
 *
 * Discovers system prompts (role definitions) from two sources:
 * 1. Built-in: plugins/dev-buddy/system-prompts/built-in/*.md (read-only)
 * 2. Custom: ~/.vcp/system-prompts/*.md (user-created)
 *
 * Loads stage definitions from:
 *   plugins/dev-buddy/stages/*.md (read-only, one per StageType)
 *
 * Role prompt frontmatter (YAML between --- delimiters):
 *   name: planner
 *   description: Senior software architect...
 *   tools: Read, Write, Glob, Grep, LSP   (optional — defaults to [])
 *   disallowedTools: Bash                  (optional)
 *
 * Stage definition frontmatter:
 *   stage: plan-review
 *   description: Review implementation plans...
 *   tools: Read, Write, Glob, Grep, LSP
 *   disallowedTools: Edit, Bash
 *
 * Name collision between custom and built-in role prompts is an error.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SystemPrompt {
  /** Unique name from frontmatter. */
  name: string;
  /** Description from frontmatter. */
  description: string;
  /** Allowed tools (normalized from comma-separated string to array). */
  tools: string[];
  /** Disallowed tools (normalized, optional). */
  disallowedTools?: string[];
  /** Full markdown body (everything after the closing ---). */
  content: string;
  /** Whether this prompt is built-in or user-created. */
  source: 'built-in' | 'custom';
  /** Absolute path to the .md file. */
  filePath: string;
}

/** Stage definition loaded from stages/{stage-type}.md. */
export interface StagePrompt {
  /** Stage type from frontmatter (must match a StageType). */
  stage: string;
  /** Description from frontmatter. */
  description: string;
  /** Allowed tools for this stage. */
  tools: string[];
  /** Disallowed tools for this stage (optional). */
  disallowedTools?: string[];
  /** Full markdown body (everything after the closing ---). */
  content: string;
  /** Absolute path to the .md file. */
  filePath: string;
}

// ─── Stage-Rule Markers for Legacy Detection ────────────────────────────────

/** Patterns that indicate a role prompt still contains stage rules. */
const STAGE_RULE_MARKERS = [
  '## Output Format',
  '## Output Contract',
  '"fix_type"',
  'must_fix|advisory',
  '## Completion Requirements',
  '## Pre-Write Verification',
];

// ─── Frontmatter Parsing ────────────────────────────────────────────────────

/**
 * Split a comma-separated string into a trimmed array.
 * Handles both array and scalar YAML forms.
 * "Read, Write, Glob" → ["Read", "Write", "Glob"]
 */
function parseCommaSeparated(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Parse YAML frontmatter from a markdown file's content.
 * Returns null if no valid frontmatter found.
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  if (!raw.startsWith('---')) return null;

  const endIndex = raw.indexOf('\n---', 3);
  if (endIndex === -1) return null;

  const yamlBlock = raw.slice(4, endIndex).trim();
  const body = raw.slice(endIndex + 4).trim();
  const meta: Record<string, string> = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) {
      meta[key] = value;
    }
  }

  return { meta, body };
}

/**
 * Parse a single .md file into a SystemPrompt.
 * Throws on missing required fields (name, description).
 * tools defaults to [] if not specified (role-only prompts).
 */
function parseSystemPromptFile(filePath: string, source: 'built-in' | 'custom'): SystemPrompt {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFrontmatter(raw);

  if (!parsed) {
    throw new Error(`System prompt file has no valid frontmatter: ${filePath}`);
  }

  const { meta, body } = parsed;

  if (!meta.name) {
    throw new Error(`System prompt file missing 'name' in frontmatter: ${filePath}`);
  }
  if (!meta.description) {
    throw new Error(`System prompt file missing 'description' in frontmatter: ${filePath}`);
  }

  return {
    name: meta.name,
    description: meta.description,
    tools: meta.tools ? parseCommaSeparated(meta.tools) : [],
    disallowedTools: meta.disallowedTools ? parseCommaSeparated(meta.disallowedTools) : undefined,
    content: body,
    source,
    filePath,
  };
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/** Directory for user-created system prompts. */
const CUSTOM_PROMPTS_DIR = path.join(os.homedir(), '.vcp', 'system-prompts');

/**
 * Read all .md files from a directory. Returns empty array if directory doesn't exist.
 */
function readMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(dir, f))
    .sort();
}

/**
 * Discover all system prompts from built-in agents and user-created custom prompts.
 *
 * @param builtInDir - Path to the agents directory (plugins/dev-buddy/agents/)
 * @returns Array of SystemPrompt objects
 * @throws If a custom prompt name collides with a built-in name
 */
export function discoverSystemPrompts(builtInDir: string): SystemPrompt[] {
  const prompts: SystemPrompt[] = [];
  const nameToSource: Map<string, string> = new Map();

  // 1. Load built-in prompts
  for (const filePath of readMdFiles(builtInDir)) {
    try {
      const prompt = parseSystemPromptFile(filePath, 'built-in');
      if (nameToSource.has(prompt.name)) {
        throw new Error(
          `Duplicate built-in system prompt name '${prompt.name}' in ${filePath} ` +
          `(already defined in ${nameToSource.get(prompt.name)})`
        );
      }
      nameToSource.set(prompt.name, filePath);
      prompts.push(prompt);
    } catch (err) {
      // Skip files that can't be parsed (e.g., README.md in agents dir)
      if (err instanceof Error && err.message.includes('missing')) {
        continue;
      }
      throw err;
    }
  }

  // 2. Load custom prompts
  for (const filePath of readMdFiles(CUSTOM_PROMPTS_DIR)) {
    const prompt = parseSystemPromptFile(filePath, 'custom');

    // Fail on name collision with built-in
    if (nameToSource.has(prompt.name)) {
      const existingSource = nameToSource.get(prompt.name)!;
      throw new Error(
        `Custom system prompt name '${prompt.name}' in ${filePath} ` +
        `collides with built-in prompt in ${existingSource}. ` +
        `Custom prompts must have unique names.`
      );
    }

    nameToSource.set(prompt.name, filePath);
    prompts.push(prompt);
  }

  return prompts;
}

/**
 * Get a system prompt by name.
 *
 * @param name - The prompt name to look up
 * @param builtInDir - Path to the agents directory
 * @returns The SystemPrompt or null if not found
 */
export function getSystemPrompt(name: string, builtInDir: string): SystemPrompt | null {
  const all = discoverSystemPrompts(builtInDir);
  return all.find(p => p.name === name) ?? null;
}

/**
 * List all available system prompt names grouped by source.
 */
export function listSystemPromptNames(builtInDir: string): { builtIn: string[]; custom: string[] } {
  const all = discoverSystemPrompts(builtInDir);
  return {
    builtIn: all.filter(p => p.source === 'built-in').map(p => p.name),
    custom: all.filter(p => p.source === 'custom').map(p => p.name),
  };
}

// ─── Custom Prompt CRUD ─────────────────────────────────────────────────────

/**
 * Write a custom system prompt to ~/.vcp/system-prompts/.
 * Validates name doesn't collide with built-in prompts.
 *
 * @param name - The prompt name (used as filename: {name}.md)
 * @param content - Full file content including frontmatter
 * @param builtInDir - Path to agents directory for collision check
 */
export function writeCustomPrompt(name: string, content: string, builtInDir: string): void {
  // Validate the content parses correctly
  const parsed = parseFrontmatter(content);
  if (!parsed || !parsed.meta.name) {
    throw new Error('Custom prompt must have valid frontmatter with a name field');
  }
  if (parsed.meta.name !== name) {
    throw new Error(`Frontmatter name '${parsed.meta.name}' does not match filename '${name}'`);
  }

  // Check for collision with built-in
  const builtInNames = readMdFiles(builtInDir)
    .map(f => {
      try { return parseSystemPromptFile(f, 'built-in').name; }
      catch { return null; }
    })
    .filter((n): n is string => n !== null);

  if (builtInNames.includes(name)) {
    throw new Error(`Cannot create custom prompt '${name}': collides with built-in prompt`);
  }

  // Write file
  fs.mkdirSync(CUSTOM_PROMPTS_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(CUSTOM_PROMPTS_DIR, `${name}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Delete a custom system prompt. Only custom prompts can be deleted.
 */
export function deleteCustomPrompt(name: string): void {
  const filePath = path.join(CUSTOM_PROMPTS_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Custom prompt '${name}' not found`);
  }
  fs.unlinkSync(filePath);
}

// ─── Stage Definition Loading ───────────────────────────────────────────────

/**
 * Load a stage definition by stage type.
 *
 * @param stageType - The stage type to load (e.g., 'plan-review', 'code-review')
 * @param stagesDir - Path to the stages directory (plugins/dev-buddy/stages/)
 * @returns The StagePrompt or null if not found / invalid
 */
export function loadStageDefinition(stageType: string, stagesDir: string): StagePrompt | null {
  const filePath = path.join(stagesDir, `${stageType}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;

  const { meta, body } = parsed;

  // Validate stage field matches requested type
  if (!meta.stage || meta.stage !== stageType) return null;
  if (!meta.description) return null;
  if (!meta.tools) return null;

  return {
    stage: meta.stage,
    description: meta.description,
    tools: parseCommaSeparated(meta.tools),
    disallowedTools: meta.disallowedTools ? parseCommaSeparated(meta.disallowedTools) : undefined,
    content: body,
    filePath,
  };
}

/**
 * Compose a full prompt from a stage definition and a role prompt.
 * Stage definition goes first (establishes the output contract),
 * role prompt follows (adds perspective and expertise).
 *
 * Emits a warning to stderr if the role prompt contains stage-rule markers,
 * indicating it may be a legacy combined prompt that should be stripped.
 */
export function composePrompt(stage: StagePrompt, role: SystemPrompt): string {
  // Check for legacy stage-rule markers in the role prompt
  for (const marker of STAGE_RULE_MARKERS) {
    if (role.content.includes(marker)) {
      console.error(
        `[system-prompts] WARNING: Role prompt '${role.name}' contains stage-rule marker '${marker}'. ` +
        `This content should be in the stage definition, not the role prompt.`
      );
      break; // One warning is enough
    }
  }

  return `${stage.content}\n\n---\n\n${role.content}`;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const command = process.argv[2];
  const builtInDir = process.argv.includes('--agents-dir')
    ? process.argv[process.argv.indexOf('--agents-dir') + 1]
    : path.join(import.meta.dir, '..', 'system-prompts', 'built-in');

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
