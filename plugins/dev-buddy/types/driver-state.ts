/**
 * Pipeline driver state model.
 *
 * `pipeline-state.json` is driver-internal. Hooks NEVER read it.
 * `pipeline-tasks.json` is the external hook contract — always updated FIRST.
 *
 * Imports only from stage-definitions.ts (no circular deps).
 */

import type { StageType } from './stage-definitions.ts';
import type { PipelineCommand, TerminalState } from './commands.ts';

// ─── Stage Runtime State ─────────────────────────────────────────────────────

/** Per-stage runtime metadata. Superset of pipeline-tasks.json stage data. */
export interface StageState {
  index: number;
  type: StageType;
  provider: string;
  model: string;
  providerType: 'subscription' | 'api' | 'cli';
  output_file: string;
  parallel_group_id: number | null;
  /** Artifact version (v1, v2, ...). Incremented on re-review. */
  current_version: number;
  status: 'pending' | 'in_progress' | 'completed' | 'needs_changes' | 'rejected' | 'failed';
  /** Count of needs_changes fix/re-review iterations for this stage. */
  iteration_count: number;
}

// ─── Parallel Group Tracking ─────────────────────────────────────────────────

export interface ParallelGroupState {
  group_id: string;
  /** Stage indices belonging to this group. */
  member_indices: number[];
  /** Stage indices whose dispatch sub-commands have completed. */
  completed_member_indices: number[];
  /** Maps dispatch sub-command ID → stage index (for spawn_agent/spawn_background only). */
  dispatch_cmd_to_stage: Record<string, number>;
  /** Stage indices of API members that need wait_for_task before read_file. */
  api_members_pending_wait: number[];
  /** Per-member results for aggregated enrichment. */
  results: Record<string, {
    status: string;
    output_file: string;
    /** Summary for aggregated enrichment (max 250 chars). */
    summary: string;
  }>;
}

// ─── Phased Review State ─────────────────────────────────────────────────────

export interface PhasedReviewState {
  /** Index of the implementation stage driving phased reviews. */
  impl_stage_index: number;
  current_step: number;
  total_steps: number;
  last_reviewed_step: number;
  review_interval: number;
  /** Current batch boundaries (1-based step numbers). */
  batch_start: number;
  batch_end: number;
  /** Steps that have passed review and are complete. */
  completed_steps: number[];
  /** Current batch fix/re-review iteration count. */
  iteration_count: number;
  max_iterations: number;
  /** Per-reviewer version counters for re-review versioning. Key: "provider-model". */
  per_reviewer_versions: Record<string, number>;
  /** Tracks whether the last batch of reviews all approved. Set by read_file report handler. */
  last_review_approved?: boolean;
}

// ─── Background Task Tracking ────────────────────────────────────────────────

export interface BackgroundTaskState {
  command_id: string;
  /** Pipeline stage this background task belongs to (null for non-stage tasks). */
  stage_index: number | null;
  started_at: string;
  timeout_ms: number;
  poll_attempts: number;
  last_poll_result: string | null;
  /** ISO8601 deadline. */
  deadline: string;
}

// ─── Specialist Team State ───────────────────────────────────────────────────

export interface SpecialistEntry {
  name: string;
  /** e.g., "technical-analyst", "security-analyst" */
  type: string;
  expected_analysis_file: string;
  status: 'spawned' | 'completed' | 'shutdown' | 'failed';
  /** Set when specialist sends completion while Q&A questions are still pending. */
  deferred_completion?: boolean;
}

export interface SpecialistTeamState {
  approved_specialists: SpecialistEntry[];
  /** Specialist names that failed to spawn. */
  spawn_failures: string[];
  interactive_loop_active: boolean;
  /** Q&A relay queue — all [QUESTION]s appended here, processed FIFO. */
  pending_questions: Array<{ specialist_name: string; question: string }>;
  /** Currently being relayed (populated when ask_user emitted, cleared after send_message reported). */
  active_relay?: {
    specialist_name: string;
    question: string;
    answer?: string;
  };
  /** Persisted transcript for synthesis prompt. */
  qa_transcript: Array<{
    specialist_name: string;
    question: string;
    answer: string;
  }>;
}

// ─── VCP Detection State ─────────────────────────────────────────────────────

export interface VcpDetectionState {
  detected: boolean;
  /** Path to .vcp/config.json or .vcp.json (fallback). Null if not detected. */
  source_config_path: string | null;
  /** Whether VCP standards were injected into security analyst prompt. */
  context_injected: boolean;
}

// ─── RCA Consolidation State ─────────────────────────────────────────────────

export interface RcaConsolidationState {
  /** Indices of RCA stages in the pipeline. */
  rca_stage_indices: number[];
  all_complete: boolean;
  disagreement_detected: boolean;
  /** Which RCA's diagnosis was selected (null if no disagreement or not yet decided). */
  chosen_diagnosis_source: string | null;
  consolidation_complete: boolean;
  /** Whether user-story + plan multi-file artifacts have been written. */
  artifacts_written: boolean;
}

// ─── Pending User Decision ───────────────────────────────────────────────────

export interface PendingUserDecision {
  question: string;
  options: string[];
  context: string;
}

// ─── Command History Entry ───────────────────────────────────────────────────

export interface CommandHistoryEntry {
  command_id: string;
  action: string;
  timestamp: string;
  acknowledged: boolean;
}

// ─── Pipeline State (Root) ───────────────────────────────────────────────────

/**
 * Full pipeline driver state. Persisted to `.vcp/task/pipeline-state.json`.
 *
 * Sync invariants:
 * 1. `pipeline-tasks.json` is ALWAYS updated BEFORE `pipeline-state.json`
 * 2. Hooks read ONLY `pipeline-tasks.json` — never this file
 * 3. This file ALWAYS contains a superset of pipeline-tasks.json stage data
 * 4. `state_version` increments on every `next` call
 * 5. If `pending_command` is non-null, `next` re-emits it (replay semantics)
 */
export interface PipelineState {
  // ─── Identity ───
  pipeline: 'feature' | 'bugfix';
  team_name: string;
  config_hash: string;
  /** User's feature/bug description passed via --description-file. */
  description?: string;
  /** Monotonic counter. Increments on every `next` call. */
  state_version: number;

  // ─── Phase ───
  /** Phase token (e.g., 'requirements', 'planning', 'code_review_2'). */
  phase: string;
  /** Step within current phase. */
  step: number;

  // ─── Command Tracking ───
  /** Unacknowledged command. `next` re-emits this until acknowledged. */
  pending_command: PipelineCommand | null;
  command_history: CommandHistoryEntry[];

  // ─── Full Stage Metadata ───
  stages: StageState[];

  // ─── Parallel Group Tracking ───
  active_parallel_group: ParallelGroupState | null;

  // ─── Phased Review State ───
  phased_state: PhasedReviewState | null;

  // ─── Background Task Tracking ───
  background_tasks: Record<string, BackgroundTaskState>;

  // ─── Specialist Team (Feature Pipeline Only) ───
  specialists: SpecialistTeamState | null;

  // ─── VCP Detection State ───
  vcp_detection: VcpDetectionState;

  // ─── RCA Consolidation State (Bug-Fix Only) ───
  rca_consolidation: RcaConsolidationState | null;

  // ─── Main Loop Dispatch Tracking ───
  /** Index of stage currently being dispatched/executed in main loop. */
  current_dispatch_index: number | null;
  /** Sub-step within the current dispatch. See DISPATCH_STEP constants. */
  dispatch_step: number;

  // ─── Pause / Interruption ───
  paused: boolean;
  pause_reason: string | null;
  pending_user_decision: PendingUserDecision | null;

  // ─── Terminal State ───
  terminal_state: TerminalState | null;
  terminal_reason: string | null;

  // ─── Batch Command Mapping ───
  /** Maps parallel_batch sub-command ID → stage index (for batch task creation/dependency wiring). */
  batch_cmd_to_stage?: Record<string, number>;

  // ─── Manifest Retry Tracking ───
  /** Retry counter for requirements manifest validation (step 7). */
  manifest_retry_count?: number;
  /** Which kind of manifest failure occurred (for escalation terminal selection). */
  manifest_failure_kind?: 'missing' | 'invalid';
  /** Human-readable reason for the manifest failure. */
  manifest_failure_reason?: string;

  // ─── Global Iteration Counters ───
  /** Per-stage iteration counters. Key: "{stage_type}_{index}". */
  global_iteration_counters: Record<string, number>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** Create an initial empty pipeline state. */
export function createInitialState(
  pipeline: 'feature' | 'bugfix',
  team_name: string,
  config_hash: string,
): PipelineState {
  return {
    pipeline,
    team_name,
    config_hash,
    state_version: 0,
    phase: 'init',
    step: 0,
    pending_command: null,
    command_history: [],
    stages: [],
    active_parallel_group: null,
    phased_state: null,
    background_tasks: {},
    specialists: null,
    vcp_detection: { detected: false, source_config_path: null, context_injected: false },
    rca_consolidation: null,
    current_dispatch_index: null,
    dispatch_step: 0,
    paused: false,
    pause_reason: null,
    pending_user_decision: null,
    terminal_state: null,
    terminal_reason: null,
    global_iteration_counters: {},
  };
}
