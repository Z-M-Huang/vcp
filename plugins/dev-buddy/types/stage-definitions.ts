/**
 * Stage type registry for the configurable pipeline architecture.
 *
 * Defines the 6 fixed stage types, their constraints, and a helper function
 * for computing output file names. Zero imports from other type modules.
 */

// ─── Stage Type ──────────────────────────────────────────────────────────────

/** The 6 fixed stage types supported by the pipeline architecture. */
export type StageType =
  | 'requirements'
  | 'planning'
  | 'plan-review'
  | 'implementation'
  | 'code-review'
  | 'rca';

// ─── Stage Definition ─────────────────────────────────────────────────────────

/** Static metadata for a stage type. */
export interface StageDefinition {
  /** If true, the stage may appear at most once per pipeline. */
  singleton: boolean;
  /** Which pipeline types this stage type is allowed in. */
  allowed_pipelines: ('feature' | 'bugfix')[];
  /** The agent type key used to spawn this stage. */
  agent_type: string;
  /**
   * Output file name pattern.
   * Singletons: exact file name (e.g. 'user-story.json').
   * Multi-instance: pattern with {provider}, {model}, {index}, and {version} placeholders
   * (e.g. 'plan-review-{provider}-{model}-{index}-v{version}.json').
   */
  output_file_pattern: string;
}

// ─── Stage Registry ───────────────────────────────────────────────────────────

/**
 * Static registry of all 6 stage types.
 * Plain Record<StageType, StageDefinition> for O(1) lookup with zero overhead.
 */
export const STAGE_DEFINITIONS: Record<StageType, StageDefinition> = {
  requirements: {
    singleton: true,
    allowed_pipelines: ['feature'],
    agent_type: 'requirements-gatherer',
    output_file_pattern: 'user-story/manifest.json',
  },
  planning: {
    singleton: true,
    allowed_pipelines: ['feature'],
    agent_type: 'planner',
    output_file_pattern: 'plan/manifest.json',
  },
  'plan-review': {
    singleton: false,
    allowed_pipelines: ['feature', 'bugfix'],
    agent_type: 'plan-reviewer',
    output_file_pattern: 'plan-review-{provider}-{model}-{index}-v{version}.json',
  },
  implementation: {
    singleton: true,
    allowed_pipelines: ['feature', 'bugfix'],
    agent_type: 'implementer',
    output_file_pattern: 'impl-result.json',
  },
  'code-review': {
    singleton: false,
    allowed_pipelines: ['feature', 'bugfix'],
    agent_type: 'code-reviewer',
    output_file_pattern: 'code-review-{provider}-{model}-{index}-v{version}.json',
  },
  rca: {
    singleton: false,
    allowed_pipelines: ['bugfix'],
    agent_type: 'root-cause-analyst',
    output_file_pattern: 'rca-{provider}-{model}-{index}-v{version}.json',
  },
};

// ─── Filename Sanitization ────────────────────────────────────────────────────

/**
 * Sanitize a string for safe use in filenames.
 * Lowercase, replace spaces/underscores with hyphens, strip unsafe chars.
 * Throws on empty or dangerous results (empty, '.', '..').
 */
export function sanitizeForFilename(input: string): string {
  const result = input
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!result || result === '.' || result === '..') {
    throw new Error(`Cannot sanitize '${input}' to a valid filename component`);
  }
  return result;
}

// ─── Output File Naming ───────────────────────────────────────────────────────

/**
 * Compute the output file name for a stage entry.
 *
 * @param type - The stage type.
 * @param index - The 1-based index of this stage within its type (ignored for singletons).
 * @param provider - The provider/preset name (required for multi-instance, sanitized for filename safety).
 * @param model - The model name (required for multi-instance, sanitized for filename safety).
 * @param version - The version/round number (required for multi-instance, starts at 1).
 * @returns The output file name (e.g. 'code-review-anthropic-subscription-sonnet-1-v1.json').
 */
export function getOutputFileName(
  type: StageType,
  index: number,
  provider: string,
  model: string,
  version: number,
): string {
  const def = STAGE_DEFINITIONS[type];
  if (def.singleton) {
    return def.output_file_pattern;
  }
  return def.output_file_pattern
    .replace('{index}', String(index))
    .replace('{provider}', sanitizeForFilename(provider))
    .replace('{model}', sanitizeForFilename(model))
    .replace('{version}', String(version));
}

// ─── Stages Array Validation ─────────────────────────────────────────────────

/** Runtime set of valid stage type strings (derived from STAGE_DEFINITIONS keys). */
export const VALID_STAGE_TYPES: ReadonlySet<string> = new Set(Object.keys(STAGE_DEFINITIONS));

/**
 * Output filenames must be safe paths: no traversal, each segment starts with alphanumeric.
 * Allows paths like 'user-story/manifest.json' but rejects '../evil.json'.
 */
const SAFE_PATH_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.json$/;

/** Validate a single stages[] entry from pipeline-tasks.json.
 *  Checks: type is a known StageType, output_file is a safe JSON basename. */
export function isValidStageEntry(entry: unknown): entry is { type: string; output_file: string } {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.type === 'string' &&
    VALID_STAGE_TYPES.has(e.type) &&
    typeof e.output_file === 'string' &&
    SAFE_PATH_RE.test(e.output_file)
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Regex for validating model names.
 * Allows lowercase letters, digits, dots, and hyphens only.
 * Prevents shell metacharacter injection (CWE-78).
 */
export const MODEL_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
