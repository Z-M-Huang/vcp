/**
 * Pipeline configuration types for dev-buddy.
 *
 * Provider references are string names (not imported Preset types) — C21.
 * Import StageType from './stage-definitions.ts' — no circular dependency
 * because stage-definitions.ts has zero imports from pipeline.ts.
 */

import type { StageType } from './stage-definitions.ts';

// ─── Pipeline Types ──────────────────────────────────────────────────────────

/**
 * A single phased review entry for per-step implementation reviews.
 * Configured on implementation stage entries only.
 */
export interface PhasedReviewEntry {
  /** The preset name to use for this phased reviewer (references ~/.vcp/ai-presets.json). */
  provider: string;
  /** Model name. Required. Validated against /^[a-zA-Z0-9._-]+$/. */
  model: string;
  /** When true, this reviewer runs in parallel with adjacent phased reviewers that also have parallel: true. */
  parallel?: boolean;
}

/**
 * A single stage entry in a pipeline array.
 * Both provider and model are required — no defaults.
 */
export interface StageEntry {
  /** The stage type (one of 6 predefined types). */
  type: StageType;
  /** The preset name to use for this stage (references ~/.vcp/ai-presets.json). */
  provider: string;
  /** Model name. Required. Validated against /^[a-zA-Z0-9._-]+$/. */
  model: string;
  /** When true, this review stage runs in parallel with adjacent same-type parallel stages. Only applies to plan-review and code-review. */
  parallel?: boolean;
  /**
   * Phased review entries for per-step implementation reviews.
   * Only valid on implementation stages.
   * Each step is reviewed by these agents before the next step begins.
   */
  phased_reviews?: PhasedReviewEntry[];
}

/**
 * Pipeline configuration format.
 * Ordered arrays of stages for feature and bug-fix pipelines.
 */
export interface PipelineConfig {
  /** Ordered array of stages for the feature development pipeline. */
  feature_pipeline: StageEntry[];
  /** Ordered array of stages for the bug-fix pipeline. */
  bugfix_pipeline: StageEntry[];
  /** Maximum fix/re-review iterations per pipeline execution. Default: 10. */
  max_iterations: number;
  /**
   * Maximum fix/re-review iterations per implementation step during phased reviews.
   * Default: 3. Resolved at config load time — consumers must not apply their own fallback.
   */
  max_phased_iterations?: number;
  /** Team name pattern with {BASENAME} and {HASH} placeholders. */
  team_name_pattern: string;
}

/**
 * A stage entry resolved to its provider type.
 * Used internally after loading the pipeline config.
 * Output file is derived from stage definitions — not stored in config.
 */
export interface ResolvedStage extends StageEntry {
  /** The type of the resolved provider preset. */
  provider_type: 'subscription' | 'api' | 'cli';
  /** The 1-based index of this stage among stages of the same type in the pipeline. */
  stage_index: number;
}
