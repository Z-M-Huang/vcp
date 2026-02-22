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
   * Multi-instance: pattern with {index} placeholder (e.g. 'plan-review-{index}.json').
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
    output_file_pattern: 'user-story.json',
  },
  planning: {
    singleton: true,
    allowed_pipelines: ['feature'],
    agent_type: 'planner',
    output_file_pattern: 'plan-refined.json',
  },
  'plan-review': {
    singleton: false,
    allowed_pipelines: ['feature', 'bugfix'],
    agent_type: 'plan-reviewer',
    output_file_pattern: 'plan-review-{index}.json',
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
    output_file_pattern: 'code-review-{index}.json',
  },
  rca: {
    singleton: false,
    allowed_pipelines: ['bugfix'],
    agent_type: 'root-cause-analyst',
    output_file_pattern: 'rca-{index}.json',
  },
};

// ─── Output File Naming ───────────────────────────────────────────────────────

/**
 * Compute the output file name for a stage entry.
 *
 * @param type - The stage type.
 * @param index - The 1-based index of this stage within its type (ignored for singletons).
 * @returns The output file name (e.g. 'plan-review-1.json', 'impl-result.json').
 */
export function getOutputFileName(type: StageType, index: number): string {
  const def = STAGE_DEFINITIONS[type];
  if (def.singleton) {
    // Singleton stages use canonical file names — index is ignored
    return def.output_file_pattern;
  }
  // Multi-instance stages use type-indexed names
  return def.output_file_pattern.replace('{index}', String(index));
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Regex for validating model names.
 * Allows lowercase letters, digits, dots, and hyphens only.
 * Prevents shell metacharacter injection (CWE-78).
 */
export const MODEL_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
