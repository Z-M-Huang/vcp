// ─── STATE MACHINE TYPES & CONSTANTS ────────────────────────────────────────
// Centralized type definitions and constant maps for the Ralph pipeline
// state machine. Precondition logic originally ported from hooks/ralph-stage-gate.ts (removed in v0.5.0).

/** Ordered plan statuses representing the Ralph pipeline stages. */
export type PlanStatus = 'discover' | 'discover-review' | 'requirements' | 'requirements-review' | 'decompose' | 'decompose-review' | 'build' | 'review' | 'uat' | 'done';

/** Tracks the state of a single unit within the plan. */
export interface UnitState {
  id: number;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
}

/** Full state of the Ralph pipeline state machine. */
export interface StateMachineState {
  slug: string;
  status: PlanStatus;
  outerIteration: number;
  reviewIteration: number;
  units: UnitState[];
  lastAction: string;
  lastTimestamp: string;
  taskIds: Record<string, string>;
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

export interface CheckpointAction {
  type: 'user_checkpoint';
  stage: string;
  sectionHeading: string;
  present: string;
  question: string;
  options: string[];
  approveStatus: PlanStatus;
}

export interface WritePlanAction {
  type: 'write_plan';
  edits: Array<{ old_string: string; new_string: string }>;
}

export interface TaskAction {
  type: 'update_tasks';
  operations: Array<{
    action: 'update';
    ref: string;
    status: 'in_progress' | 'completed';
  }>;
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
}

/** Patch applied to a unit plan file's metadata by the build loop runner. */
export interface UnitStatusPatch {
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  appendResult: string;
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

/** Result of per-unit semantic review (optional step after mechanical backpressure). */
export interface UnitReviewResult {
  /** True if unit-review not configured (empty executors). */
  skipped: boolean;
  /** True if review passed or was skipped. */
  passed: boolean;
  /** Reviewer findings (empty if passed/skipped). */
  feedback: string;
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

/** Map plan status → skill name (6 active statuses; 'done' has no skill). */
export const STATUS_TO_SKILL: Record<string, string> = {
  discover: 'dev-buddy-discover',
  requirements: 'dev-buddy-requirements',
  decompose: 'dev-buddy-decompose',
  build: 'dev-buddy-build',
  review: 'dev-buddy-code-review',
  uat: 'dev-buddy-uat',
};

/** Map plan status → stage-type identifier for one-shot-runner (6 active statuses). */
export const STATUS_TO_STAGE_TYPE: Record<string, string> = {
  discover: 'discovery',
  requirements: 'ralph-requirements',
  decompose: 'decomposition',
  build: 'ralph-build',
  review: 'ralph-code-review',
  uat: 'ralph-uat',
};
