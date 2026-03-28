/**
 * Stage type registry for the configurable pipeline architecture.
 *
 * Defines the 6 fixed stage types, their constraints, and helper functions
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
  /** The agent type key used to spawn this stage. */
  agent_type: string;
  /**
   * Output file name pattern (v2 format).
   * Singletons: exact file name (e.g. 'user-story.json').
   * Multi-instance: pattern with {provider}, {model}, {index} placeholders.
   * Reviews omit {version} (overwrite in place, track revision_number in JSON).
   * RCA includes {version} for versioned files.
   */
  output_file_pattern: string;
  /**
   * v3 output file name pattern including {system_prompt} for traceability.
   * Only present on multi-instance stages.
   * Reviews: '{stage}-{system_prompt}-{provider}-{model}-{index}.json'
   * RCA: '{stage}-{system_prompt}-{provider}-{model}-{index}-v{version}.json'
   */
  v3_output_file_pattern?: string;
  /** Maximum number of executors allowed for this stage. undefined = unlimited. */
  max_executors?: number;
}

// ─── Stage Registry ───────────────────────────────────────────────────────────

/**
 * Static registry of all 6 stage types.
 * Plain Record<StageType, StageDefinition> for O(1) lookup with zero overhead.
 */
export const STAGE_DEFINITIONS: Record<StageType, StageDefinition> = {
  requirements: {
    singleton: true,
    agent_type: 'requirements-gatherer',
    output_file_pattern: 'user-story/manifest.json',
  },
  planning: {
    singleton: true,
    agent_type: 'planner',
    output_file_pattern: 'plan/manifest.json',
  },
  'plan-review': {
    singleton: false,
    agent_type: 'plan-reviewer',
    output_file_pattern: 'plan-review-{provider}-{model}-{index}.json',
    /** v3 output pattern includes system prompt name for traceability. */
    v3_output_file_pattern: 'plan-review-{system_prompt}-{provider}-{model}-{index}.json',
  },
  implementation: {
    singleton: true,
    agent_type: 'implementer',
    output_file_pattern: 'impl-result.json',
    max_executors: 1,
  },
  'code-review': {
    singleton: false,
    agent_type: 'code-reviewer',
    output_file_pattern: 'code-review-{provider}-{model}-{index}.json',
    v3_output_file_pattern: 'code-review-{system_prompt}-{provider}-{model}-{index}.json',
  },
  rca: {
    singleton: false,
    agent_type: 'root-cause-analyst',
    output_file_pattern: 'rca-{provider}-{model}-{index}-v{version}.json',
    v3_output_file_pattern: 'rca-{system_prompt}-{provider}-{model}-{index}-v{version}.json',
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
 * Compute the output file name for a v3 stage entry (includes executor name).
 * Falls back to v2 pattern if no v3 pattern defined (singletons).
 *
 * @param type - The stage type.
 * @param systemPromptName - The system prompt name (for traceability in filename).
 * @param index - The 1-based index (ignored for singletons).
 * @param provider - The provider/preset name (sanitized).
 * @param model - The model name (sanitized).
 * @param version - The version number (starts at 1).
 */
export function getV3OutputFileName(
  type: StageType,
  systemPromptName: string,
  index: number,
  provider: string,
  model: string,
  version: number,
): string {
  const def = STAGE_DEFINITIONS[type];
  if (def.singleton) {
    return def.output_file_pattern;
  }
  const pattern = def.v3_output_file_pattern ?? def.output_file_pattern;
  return pattern
    .replace('{system_prompt}', sanitizeForFilename(systemPromptName))
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
export const SAFE_PATH_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.json$/;

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
