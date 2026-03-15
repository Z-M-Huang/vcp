/**
 * Pipeline configuration types for dev-buddy (v3 inline executor format).
 *
 * Import StageType from './stage-definitions.ts' — no circular dependency
 * because stage-definitions.ts has zero imports from pipeline.ts.
 */

import type { StageType } from './stage-definitions.ts';

// ─── v3 Config Types (inline executors) ─────────────────────────────────────

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
 * v3 configuration format for dev-buddy (inline executor variant).
 * No top-level "executors" key — executor definitions are inline in each stage.
 */
export interface DevBuddyConfig {
  /** Config format version. Must be '3.0'. */
  version: '3.0';
  /** Per-stage executor assignments. All 6 StageType keys required. */
  stages: Record<StageType, StageConfig>;
  /** User-configurable ordered list of stages for the feature pipeline. */
  feature_pipeline: StageType[];
  /** User-configurable ordered list of stages for the bugfix pipeline. */
  bugfix_pipeline: StageType[];
  /** Maximum fix/re-review iterations per review stage (plan-review, code-review). Each stage gets its own budget. Default: 10. */
  max_iterations: number;
  /** Maximum TDD loop iterations per implementation step. Default: 5. */
  max_tdd_iterations: number;
  /** UI theme preference. Saved in config for persistence across browsers. */
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
