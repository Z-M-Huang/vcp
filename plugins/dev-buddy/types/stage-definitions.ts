/**
 * Stage type registry for the Ralph loop architecture (v0.4.0).
 *
 * Defines the 6 Ralph stage types and their constraints.
 * Zero imports from other type modules.
 */

// ─── Stage Type ──────────────────────────────────────────────────────────────

/** The 6 Ralph pipeline stage types + optional per-unit review. */
export type StageType =
  | 'discovery'
  | 'ralph-requirements'
  | 'decomposition'
  | 'ralph-build'
  | 'ralph-code-review'
  | 'ralph-uat'
  | 'unit-review';

/**
 * Legacy stage types from v2/v3/v4 — only used by migration code.
 * @deprecated
 */
export type LegacyStageType =
  | 'requirements'
  | 'planning'
  | 'plan-review'
  | 'implementation'
  | 'code-review'
  | 'rca';

// ─── Stage Definition ─────────────────────────────────────────────────────────

/** Static metadata for a stage type. */
export interface StageDefinition {
  /** If true, the stage may have at most 1 executor. */
  singleton: boolean;
  /** The agent type key (system prompt name) used to spawn this stage. */
  agent_type: string;
  /** Maximum number of executors allowed for this stage. undefined = unlimited. */
  max_executors?: number;
  /** If true, stage is not required in config — empty executors = disabled. */
  optional?: boolean;
}

// ─── Stage Registry ───────────────────────────────────────────────────────────

/**
 * Static registry of all 6 Ralph stage types.
 * Plain Record<StageType, StageDefinition> for O(1) lookup with zero overhead.
 */
export const STAGE_DEFINITIONS: Record<StageType, StageDefinition> = {
  discovery: {
    singleton: false,
    agent_type: 'discoverer',
  },
  'ralph-requirements': {
    singleton: false,
    agent_type: 'ralph-requirements-analyst',
  },
  decomposition: {
    singleton: false,
    agent_type: 'decomposer',
  },
  'ralph-build': {
    singleton: true,
    agent_type: 'unit-builder',
    max_executors: 1,
  },
  'ralph-code-review': {
    singleton: false,
    agent_type: 'ralph-code-reviewer',
  },
  'ralph-uat': {
    singleton: true,
    agent_type: 'uat-evaluator',
    max_executors: 1,
  },
  'unit-review': {
    singleton: false,
    agent_type: 'unit-reviewer',
    optional: true,
  },
};

// ─── Legacy Stage Mappings (for migration) ──────────────────────────────────

/**
 * Maps legacy stage types to their Ralph equivalents.
 * Used by migration functions to convert v2/v3/v4 configs to v5.
 * @deprecated Only used by migration code.
 */
export const LEGACY_STAGE_MAPPING: Record<LegacyStageType, StageType> = {
  requirements: 'ralph-requirements',
  planning: 'decomposition',
  'plan-review': 'discovery',
  implementation: 'ralph-build',
  'code-review': 'ralph-code-review',
  rca: 'discovery',
};

/**
 * Maps legacy stage types to their agent_type values.
 * Used by migration functions that need to resolve old agent types.
 * @deprecated Only used by migration code.
 */
export const LEGACY_AGENT_TYPES: Record<LegacyStageType, string> = {
  requirements: 'requirements-gatherer',
  planning: 'planner',
  'plan-review': 'plan-reviewer',
  implementation: 'implementer',
  'code-review': 'code-reviewer',
  rca: 'root-cause-analyst',
};


// ─── Validation ───────────────────────────────────────────────────────────────

/** Runtime set of valid stage type strings (derived from STAGE_DEFINITIONS keys). */
export const VALID_STAGE_TYPES: ReadonlySet<string> = new Set(Object.keys(STAGE_DEFINITIONS));

/** Runtime set of optional stage types (derived from STAGE_DEFINITIONS). Empty executors = disabled. */
export const OPTIONAL_STAGE_TYPES: ReadonlySet<string> = new Set(
  Object.entries(STAGE_DEFINITIONS)
    .filter(([, def]) => def.optional)
    .map(([key]) => key)
);

/** Runtime set of legacy stage type strings (for migration detection). */
export const VALID_LEGACY_STAGE_TYPES: ReadonlySet<string> = new Set(Object.keys(LEGACY_STAGE_MAPPING));

/**
 * Regex for validating model names.
 * Allows letters, digits, dots, and hyphens only.
 * Prevents shell metacharacter injection (CWE-78).
 */
export const MODEL_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
