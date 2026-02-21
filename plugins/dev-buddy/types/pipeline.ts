/**
 * Pipeline configuration types for dev-buddy.
 *
 * Provider references are string names (not imported Preset types) — C21.
 * Zero imports from other type modules.
 */

export interface StageConfig {
  /** Name of the preset to use for this pipeline stage */
  provider: string;
}

export interface PipelineStages {
  requirements: StageConfig;
  planning: StageConfig;
  plan_review_sonnet: StageConfig;
  plan_review_opus: StageConfig;
  plan_review_codex: StageConfig;
  implementation: StageConfig;
  code_review_sonnet: StageConfig;
  code_review_opus: StageConfig;
  code_review_codex: StageConfig;
}

export interface PipelineConfig {
  version: '2.0';
  pipeline: {
    stages: PipelineStages;
    max_iterations: number;
    team_name_pattern: string;
  };
}

export interface ResolvedStage {
  /** The preset name used for this stage */
  provider_name: string;
  /** The type of the resolved provider */
  provider_type: 'subscription' | 'api' | 'cli';
}

export interface SessionPortMapping {
  /** The preset name this session manager is serving */
  preset_name: string;
  /** The port the session manager HTTP server is listening on */
  port: number;
  /** The bearer token for authenticating to this session manager */
  token: string;
  /** The PID of the session manager process */
  pid: number;
}
