// ─── STATE MACHINE TYPES & CONSTANTS ────────────────────────────────────────
// Centralized type definitions and constant maps for the Ralph pipeline
// state machine. Precondition logic originally ported from hooks/ralph-stage-gate.ts (removed in v0.5.0).

/**
 * Ordered plan statuses representing the Ralph pipeline stages.
 * Extended with `plan_lint` and `failed_irrecoverable` for the v2 per-unit-file
 * layout (see PlanState).
 */
export type PlanStatus =
  | 'discover' | 'discover-review'
  | 'requirements' | 'requirements-review'
  | 'decompose' | 'decompose-review'
  | 'plan_lint'
  | 'build'
  | 'review'
  | 'uat'
  | 'done'
  | 'failed_irrecoverable';

/**
 * LEGACY per-unit state that was embedded in the monolithic
 * `.state/ralph-{slug}.json`'s `units[]` array. Retained for the migrator and
 * the legacy code paths still wired into ralph-state-machine.ts. New code goes
 * through UnitState (v2) below, persisted per-unit at
 * `.state/ralph-{slug}/units/unit-N.json`.
 */
export interface LegacyUnitState {
  id: number;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
}

/**
 * LEGACY full state of the Ralph pipeline state machine. One giant JSON at
 * `.state/ralph-{slug}.json`. Replaced by PlanState + per-unit UnitState files.
 * Retained until the migrator lands (Commit 2/3).
 */
export interface StateMachineState {
  slug: string;
  status: PlanStatus;
  outerIteration: number;
  reviewIteration: number;
  units: LegacyUnitState[];
  lastAction: string;
  lastTimestamp: string;
  taskIds: Record<string, string>;
  /**
   * Ref→[ref] map mirroring the unit DAG: `blockedBy["unit:3"] = ["unit:1", "unit:2"]`.
   * Populated by `registerTaskGraph`; compared against `listUnits()` output by `verify-task-graph`.
   * Execution order is already enforced from unit-file `dependsOn`; this is the task-board projection.
   */
  blockedBy: Record<string, string[]>;
}

// ─── V2 PER-UNIT-FILE STATE LAYOUT ──────────────────────────────────────────
// `.state/ralph-{slug}/plan.json`  (plan-level)
// `.state/ralph-{slug}/units/unit-N.json` (one per unit)
// `.state/ralph-{slug}/progress/stage-progress-{stageType}-{pid}.json`

/** Hard caps enforced on write by ralph/unit-state.ts (closes §1.3). */
export const REVIEW_FEEDBACK_MAX_BYTES = 16 * 1024;
export const STDERR_TAIL_MAX_BYTES = 4 * 1024;
export const STDOUT_TAIL_MAX_BYTES = 4 * 1024;
export const ATTEMPT_HISTORY_MAX_ENTRIES = 10;
/** Soft cap on the Implementation Files blob injected into the unit-review stage task. */
export const UNIT_REVIEW_FILES_MAX_BYTES = 128 * 1024;
/** How long a reservation may remain open before the lease is considered stale and can be abandoned. */
export const MAX_DISPATCH_MS = 30 * 60 * 1000; // 30 min

/**
 * Plan-level state at `.state/ralph-{slug}/plan.json`. Small — holds DAG, status,
 * completion anchor. Rewritten only on plan-level transitions (status change,
 * decompose re-run, terminal completion). Retention-anchor via `completedAt`.
 */
export interface PlanState {
  slug: string;
  /** Schema bumped from legacy (implicit v1) — migrator asserts. */
  schemaVersion: 2;
  /** ULID — new value on every decompose run. Triggers per-unit reconciliation on mismatch. */
  decomposeRunId: string;
  status: PlanStatus;
  /**
   * Set by markPlanComplete. Retention safeguard: sweep skips plans where this
   * is not 'state-machine' even if status + completedAt are set.
   */
  completionSource?: 'state-machine' | 'manual';
  outerIteration: number;
  reviewIteration: number;
  taskIds: Record<string, string>;
  /** DAG edges — read for ready-set computation. */
  blockedBy: Record<string, string[]>;
  /** Declared unit IDs for the current plan. Source of truth for the ready-set. */
  unitIds: number[];
  /** sha1(unit-N.md) as of last decompose — version anchor for §12. */
  unitFileHashes: Record<number, string>;
  startedAt: string;
  /** Set only on terminal transition. The retention trigger. */
  completedAt?: string;
  lastAction: string;
  lastTimestamp: string;
}

/**
 * Per-unit state at `.state/ralph-{slug}/units/unit-N.json`. Rewritten on each
 * attempt. Atomic tmp+rename + generation CAS — see ralph/unit-state.ts.
 */
export interface UnitState {
  id: number;
  /** Must match PlanState.decomposeRunId; else stale — record is reset on reconcile. */
  decomposeRunId: string;
  /** Hash of unit-N.md at the moment setReviewFeedback captured reviewFeedback. */
  unitFileHashAtReview?: string;
  /** Monotonic CAS counter. Incremented on every write; mismatch → writer must retry. */
  generation: number;
  status: 'pending' | 'building' | 'reviewing' | 'done' | 'failed';
  /** Attempts committed; incremented PRE-dispatch via reserveAttempt. */
  attempts: number;
  maxAttempts: number;
  /**
   * Crash-safe reservation token held by a live dispatcher. Cleared on
   * commitAttemptResult or abandonReservation. If non-null and stale
   * (reservedAt older than MAX_DISPATCH_MS), the next `--action next`
   * abandons it so a new attempt can proceed.
   */
  reservedAttempt?: {
    attempt: number;
    reservedAt: string;
    lease: string;
  };
  /** Bounded at REVIEW_FEEDBACK_MAX_BYTES. Survives crashes (persisted on disk). */
  reviewFeedback?: string;
  /** stderr/stdout tails bounded at STDERR_TAIL_MAX_BYTES / STDOUT_TAIL_MAX_BYTES. */
  lastMechanicalContext?: MechanicalContext;
  /** Bounded to the last ATTEMPT_HISTORY_MAX_ENTRIES entries. */
  attemptHistory: AttemptRecord[];
  /** For stuck detection: consecutive attempts where normalizeStderr(context) matches the prior attempt. */
  identicalFailureCount: number;
}

/**
 * Frozen snapshot of one build attempt. Appended to UnitState.attemptHistory on
 * commitAttemptResult. Last N entries kept.
 */
export interface AttemptRecord {
  attempt: number;
  timestamp: string;
  outcome: 'done' | 'retry' | 'failed' | 'stuck' | 'abandoned';
  mechanicalContext?: MechanicalContext;
  reviewPassed?: boolean;
  /** normalizeStderr(stderrTail) hash — used for identical-failure comparison in detectStuck. */
  stderrNormalizedHash?: string;
}

// ─── ACTION OUTPUT TYPES ───────────────────────────────────────────────────
// Structured actions returned by the state machine. Each action type maps to
// a concrete orchestrator instruction (invoke skill, checkpoint, task mgmt, etc.).

/** Discriminant for all action types. */
export type ActionType = 'invoke_skill' | 'run_backpressure' | 'user_checkpoint' | 'write_plan' | 'update_tasks' | 'done' | 'error' | 'blocked';

export interface SkillAction {
  type: 'invoke_skill';
  skill: string;
  stageType: string;
  slug: string;
  unitId?: number;
  unitPath?: string;
}

export interface BackpressureAction {
  type: 'run_backpressure';
  commands: string[];
}

/**
 * Ready-to-pass payload for the AskUserQuestion tool. Schema mirrors the tool's
 * `questions` parameter exactly — the orchestrator forwards this verbatim with
 * no rewording or interpretation.
 */
export interface AskUserQuestionPayload {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export interface CheckpointAction {
  type: 'user_checkpoint';
  stage: string;
  sectionHeading: string;
  /**
   * Exact payload the orchestrator passes to the AskUserQuestion tool.
   * Schema mirrors the tool's `questions` parameter so it can be forwarded
   * verbatim. The pre-shaped payload keeps the call site obvious; actual
   * invocation of AskUserQuestion still depends on the orchestrator
   * following the action.
   */
  askUserQuestion: AskUserQuestionPayload;
  /** Plan status to write on `approve`. */
  approveStatus: PlanStatus;
  /** Plan status to write on `request changes` (resets to the pre-review stage). */
  rejectStatus: PlanStatus;
  /**
   * Follow-up AskUserQuestion payload for the `request changes` branch.
   *
   * AskUserQuestion always exposes an implicit free-text `Other` option that
   * does NOT appear in `options[]` — users type specific feedback there. The
   * orchestrator writes whatever the tool returns (the typed free-text OR a
   * selected preset label like `abort pipeline`) to the plan's `## Feedback`
   * section before re-running the stage. `stage-runner.ts` reads `## Feedback`
   * as executor context on the re-run.
   */
  feedbackQuestion: AskUserQuestionPayload;
}

export interface WritePlanAction {
  type: 'write_plan';
  edits: Array<{ old_string: string; new_string: string }>;
}

/** Single operation within a TaskAction — discriminated on `action`. */
export type TaskOperation =
  | {
      action: 'update';
      ref: string;
      status: 'in_progress' | 'completed';
    }
  | {
      action: 'set_blocked_by';
      ref: string;
      blockedBy: string[];
    };

export interface TaskAction {
  type: 'update_tasks';
  operations: TaskOperation[];
}

export interface DoneAction { type: 'done'; summary: string; }
export interface ErrorAction { type: 'error'; message: string; }
export interface BlockedAction { type: 'blocked'; reason: string; preconditionError: string; }

/** Union of all possible actions the state machine can emit. */
export type Action = SkillAction | BackpressureAction | CheckpointAction | WritePlanAction | TaskAction | DoneAction | ErrorAction | BlockedAction;

/** Bundled output from a single state machine evaluation. */
export interface StateMachineOutput {
  actions: Action[];
  state: StateMachineState;
}

/** Data extracted from a plan file's content via regex parsing. */
export interface PlanFileData {
  status: PlanStatus | null;
  hasDiscovery: boolean;
  hasRequirements: boolean;
  hasACs: boolean;
  hasUATs: boolean;
  hasVerdict: boolean;
  verdictValue: string | null;
  unitCount: number;
  definedUATIds: string[];
  passedUATIds: string[];
}

// ─── CONTRACT MANIFEST ─────────────────────────────────────────────────────
// Machine-readable contract block embedded in unit-N.md under
// `### Contract Manifest`. Lists every cross-module symbol the unit promises to
// expose and every cross-module symbol the unit's source code will import. The
// plan-lint stage uses these to verify wiring across units; the build-loop
// runner's contract-verifier uses them to prove (via tsc) that promised
// exports actually carry the `export` keyword.

/** Single entry in `Contract Manifest.exports[]`. */
export interface ContractExport {
  /** Exact identifier as it must appear in source. */
  symbol: string;
  /** Project-relative path of the file that must export this symbol. */
  module: string;
  /** Defaults to 'named' when omitted in the JSON. */
  kind: 'named' | 'type' | 'default';
}

/** Single entry in `Contract Manifest.consumes[]`. */
export interface ContractConsumes {
  /** Exact identifier the unit's source will `import`. */
  symbol: string;
  /** Project-relative module path of the import source. */
  from: string;
}

/** Parsed Contract Manifest block from a unit-N.md file. */
export interface ContractManifest {
  exports: ContractExport[];
  consumes: ContractConsumes[];
}

/** Discriminated result from extractContractManifest(). */
export type ContractManifestExtractResult =
  | { kind: 'ok'; manifest: ContractManifest }
  | { kind: 'missing' }
  | { kind: 'malformed'; error: string };

/** Data extracted from an individual unit plan file. */
export interface UnitPlanData {
  id: number;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  maxAttempts: number;
  dependsOn: number[];
  backpressureCommands: string[];
}

/** Structured entry returned by listUnits(). */
export interface UnitListEntry {
  id: number;
  title: string;
  status: 'pending' | 'done' | 'failed';
  dependsOn: number[];
  /** Stable ref used in the state file's taskIds/blockedBy maps: `"unit:${id}"`. */
  ref: string;
  /** Human-readable task subject: `"Unit ${id}: ${title}"`. */
  subject: string;
  /** Refs of blocking units, mirroring dependsOn: `dependsOn.map(id => "unit:"+id)`. */
  blockedByRefs: string[];
}

/** Result of running a single backpressure command. */
export interface BackpressureResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}

// ─── BUILD LOOP RUNNER TYPES ────────────────────────────────────────────────
// Types for the single-unit build executor (build-loop-runner.ts).

/** Result of dispatching one build unit via stage-runner.ts. */
export interface UnitBuildDispatchResult {
  event: 'complete' | 'error';
  stage: 'ralph-build';
  synthesis?: string | null;
  workerOutputs?: Array<{
    executor_index: number;
    preset: string;
    model: string;
    system_prompt: string;
    result: string;
  }>;
  phase?: string;
  error?: string;
  /**
   * Captured when the dispatch subprocess exited non-zero or stage-runner
   * returned an error event. Null otherwise. Contains raw stdout/stderr
   * head+tail excerpts — not redacted.
   */
  mechanicalContext?: MechanicalContext | null;
}


/** Result of a single-unit build invocation (single-unit-per-invocation model). */
export interface SingleUnitResult {
  event: 'unit_done' | 'unit_failed' | 'unit_error';
  unitId: number;
  unitPath: string;
  attempt: number;
  maxAttempts: number;
  outcome: 'done' | 'failed';
  summary: string;
  error?: string;
}

/**
 * Outcome from a single build attempt. Returned by BLR's runSingleAttempt (§2).
 * BLR writes NOTHING — this JSON is all the SM receives. CC forwards it to the
 * SM via `record_attempt_result` for persistence and next-action computation.
 */
export interface AttemptOutcome {
  event: 'attempt_complete';
  unitId: number;
  unitPath: string;
  outcome: 'mechanical_pass' | 'mechanical_fail' | 'dispatch_error';
  mechanicalContext: MechanicalContext | null;
  backpressureResults: BackpressureResult[];
  synthesis: string | null;
  lease: string | null;
}

/** Output from SM action `compose_build_dispatch`. */
export interface ComposeBuildDispatchOutput {
  prompt: string;
  lease: string;
  attempt: number;
  unitId: number;
  unitPath: string;
  priority: string;
  generation: number;
}

/** Input to SM action `record_attempt_result`. */
export interface RecordAttemptInput {
  unitId: number;
  lease: string;
  outcome: 'mechanical_pass' | 'mechanical_fail' | 'dispatch_error';
  mechanicalContext?: MechanicalContext | null;
}

/** Output from SM action `record_attempt_result`. */
export interface RecordAttemptOutput {
  nextAction: 'dispatch_unit_review' | 'retry_unit' | 'escalate_stuck' | 'unit_failed' | 'unit_done';
  unitId: number;
  lease?: string;
  identicalFailureCount?: number;
}

/** Input to SM action `record_review_result`. */
export interface RecordReviewInput {
  unitId: number;
  lease: string;
  passed: boolean;
  feedback: string;
}

/** Output from SM action `record_review_result`. */
export interface RecordReviewOutput {
  nextAction: 'unit_done' | 'retry_unit' | 'unit_failed';
  unitId: number;
}

/** Result of per-unit semantic review (optional step after mechanical backpressure). */
export interface UnitReviewResult {
  /** True if unit-review not configured (empty executors). */
  skipped: boolean;
  /** True if review passed or was skipped. */
  passed: boolean;
  /** Reviewer findings (empty if passed/skipped). */
  feedback: string;
}

// ─── MECHANICAL FAILURE CONTEXT ─────────────────────────────────────────────
// Captured when a build attempt fails (dispatch subprocess non-zero exit, or a
// backpressure command fails). Persisted in units/unit-N.json.lastMechanicalContext
// so the next attempt's dispatch prompt shows the previous failure context even
// across process restarts.

/**
 * Compile/test failure details captured from a non-zero exit. Sources:
 *   - 'dispatch'           executor dispatch itself errored out
 *   - 'backpressure'       a unit backpressure command (tsc/lint/test) failed
 *   - 'contract-verifier'  the Contract Manifest probe-file typecheck failed:
 *                          a promised export cannot be resolved under the
 *                          project's tsconfig. Catches the Class-A bug where
 *                          a producer unit declares a symbol but forgot the
 *                          `export` keyword, which backpressure misses
 *                          because nothing in the tree imports it yet.
 *
 * Head + tail excerpts survive truncation on either edge of a long output
 * stream. Bodies are persisted verbatim into the prompt — if a build tool
 * echoes secrets to stdout/stderr those secrets land in the prompt.
 */
export interface MechanicalContext {
  source: 'dispatch' | 'backpressure' | 'contract-verifier';
  command: string;
  exitCode: number;
  stdoutHead: string;
  stdoutTail: string;
  stderrHead: string;
  stderrTail: string;
}

/**
 * Snapshot of a build attempt, passed from one iteration of the runSingleUnit
 * retry loop into the next. `null` on the first attempt.
 */
export interface LatestAttemptState {
  attempt: number;
  dispatchEvent: 'complete' | 'error' | 'cancelled' | null;
  dispatchError: string | null;
  backpressure: Array<{ name: string; exitCode: number }>;
  outcome: 'done' | 'retry' | 'failed';
  /** Compile/test failure context. `null` when outcome is 'done' or dispatch succeeded. */
  mechanicalContext: MechanicalContext | null;
}

/** Pipeline stages in execution order (10 entries, including 3 review gates). */
export const STATUS_ORDER: readonly PlanStatus[] = [
  'discover',
  'discover-review',
  'requirements',
  'requirements-review',
  'decompose',
  'decompose-review',
  'build',
  'review',
  'uat',
  'done',
] as const;

/** Map plan status → skill name (7 active statuses; 'done' has no skill). */
export const STATUS_TO_SKILL: Record<string, string> = {
  discover: 'dev-buddy-discover',
  requirements: 'dev-buddy-requirements',
  decompose: 'dev-buddy-decompose',
  plan_lint: 'dev-buddy-plan-lint',
  build: 'dev-buddy-build',
  review: 'dev-buddy-code-review',
  uat: 'dev-buddy-uat',
};

/** Map plan status → stage-type identifier for one-shot-runner (7 active statuses). */
export const STATUS_TO_STAGE_TYPE: Record<string, string> = {
  discover: 'discovery',
  requirements: 'ralph-requirements',
  decompose: 'decomposition',
  plan_lint: 'plan-lint',
  build: 'ralph-build',
  review: 'ralph-code-review',
  uat: 'ralph-uat',
};
