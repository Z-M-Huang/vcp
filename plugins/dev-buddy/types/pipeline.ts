/**
 * Pipeline configuration types for dev-buddy (v4 custom pipelines format).
 *
 * Import StageType from './stage-definitions.ts' — no circular dependency
 * because stage-definitions.ts has zero imports from pipeline.ts.
 */

import type { StageType } from './stage-definitions.ts';

// ─── v4 Config Types (custom pipelines) ──────────────────────────────────────

/**
 * An inline executor within a stage.
 * Combines system prompt + AI preset + model in one object.
 */
export interface StageExecutor {
  /** Name of the system prompt (resolved from system-prompts/built-in/ or ~/.vcp/system-prompts/). */
  system_prompt: string;
  /** The preset name (references ~/.vcp/ai-presets.json). */
  preset: string;
  /** Model name. Validated against /^[a-zA-Z0-9._-]+$/. */
  model: string;
  /** When true, this executor runs in parallel with adjacent parallel executors. Default: false. */
  parallel?: boolean;
}

/**
 * Per-stage configuration: which executors to run and how.
 */
export interface StageConfig {
  /** Ordered list of inline executors for this stage. */
  executors: StageExecutor[];
}

/**
 * v4 configuration format for dev-buddy (custom pipelines).
 * No top-level "executors" key — executor definitions are inline in each stage.
 * Pipelines are user-defined with arbitrary names (replaces fixed feature_pipeline/bugfix_pipeline).
 */
export interface DevBuddyConfig {
  /** Config format version. Must be '4.0'. */
  version: '4.0';
  /** Per-stage executor assignments. All 6 StageType keys required. */
  stages: Record<StageType, StageConfig>;
  /** User-defined pipelines. Keys are pipeline names, values are ordered stage lists. */
  pipelines: Record<string, StageType[]>;
  /** Maximum fix/re-review iterations per review stage (plan-review, code-review). Each stage gets its own budget. Default: 10. */
  max_iterations: number;
  /** Maximum TDD loop iterations per implementation step. Default: 5. */
  max_tdd_iterations: number;
  /** UI theme preference. Saved in config for persistence across browsers. */
  theme?: 'light' | 'dark';
}

// ─── Legacy v3 types (kept only for migration) ──────────────────────────────

/** @deprecated v3 config — only used by migration code. */
export interface DevBuddyConfigV3 {
  version: '3.0';
  stages: Record<StageType, StageConfig>;
  feature_pipeline: StageType[];
  bugfix_pipeline: StageType[];
  max_iterations: number;
  max_tdd_iterations: number;
  theme?: 'light' | 'dark';
}

// ─── Legacy v2 types (kept only for migrateV2ToV3) ──────────────────────────

/** @deprecated v2 stage entry — only used by migration code. */
export interface StageEntry {
  type: StageType;
  provider: string;
  model: string;
  parallel?: boolean;
}

/** @deprecated v2 pipeline config — only used by migration code. */
export interface PipelineConfig {
  feature_pipeline: StageEntry[];
  bugfix_pipeline: StageEntry[];
  max_iterations: number;
  max_phased_iterations?: number;
  review_interval?: number;
  team_name_pattern: string;
}
