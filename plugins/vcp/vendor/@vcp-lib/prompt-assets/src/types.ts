/**
 * Prompt-asset types — role-prompt + stage-definition shapes.
 * Zero runtime imports.
 */

/** A role/system prompt parsed from a markdown file with YAML frontmatter. */
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
