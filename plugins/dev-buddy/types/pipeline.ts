/**
 * Pipeline configuration types for dev-buddy (v5 Ralph loop format).
 *
 * Import StageType from './stage-definitions.ts' — no circular dependency
 * because stage-definitions.ts has zero imports from pipeline.ts.
 */

import type { StageType } from './stage-definitions.ts';

// ─── v5 Config Types (Ralph loop) ───────────────────────────────────────────

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
 * v5 configuration format for dev-buddy (Ralph loop).
 * Single 'ralph' pipeline. Stages are the 6 Ralph stage types.
 */
export interface DevBuddyConfig {
  /** Config format version. Must be '5.0'. */
  version: '5.0';
  /** Per-stage executor assignments. All 6 StageType keys required. */
  stages: Record<StageType, StageConfig>;
  /** Pipeline definition. Only 'ralph' pipeline supported. */
  pipelines: Record<string, StageType[]>;
  /** Maximum fix/re-review iterations per code review stage. Default: 10. */
  max_iterations: number;
  /** Maximum build attempts per unit of work. Default: 3. */
  max_build_attempts: number;
  /** Maximum outer (UAT → build → review → UAT) loop iterations. Default: 3. */
  max_outer_iterations: number;
  /** Maximum internal adversarial validation iterations for discovery stage. Default: 3. */
  max_discovery_iterations: number;
  /** Maximum internal adversarial validation iterations for requirements stage. Default: 3. */
  max_requirements_iterations: number;
  /** Maximum internal adversarial validation iterations for decomposition stage. Default: 2. */
  max_decomposition_iterations: number;
  /** Config portal port. If undefined, OS assigns a random port. */
  config_port?: number;
  /** UI theme preference. Saved in config for persistence across browsers. */
  theme?: 'light' | 'dark';
}

// ─── Legacy v3 types (kept only for migration) ──────────────────────────────

/** @deprecated v3 config — only used by migration code. */
export interface DevBuddyConfigV3 {
  version: '3.0';
  stages: Record<string, StageConfig>;
  feature_pipeline: string[];
  bugfix_pipeline: string[];
  max_iterations: number;
  max_tdd_iterations: number;
  theme?: 'light' | 'dark';
}

// ─── Legacy v2 types (kept only for migrateV2ToV3) ──────────────────────────

/** @deprecated v2 stage entry — only used by migration code. */
export interface StageEntry {
  type: string;
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
