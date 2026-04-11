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
// Types for the mechanical build loop (build-loop-runner.ts).

/** A single task update operation for the Ralph orchestrator to replay. */
export interface TaskProjectionOp {
  ref: string;
  status: 'in_progress' | 'completed' | 'failed';
  note?: string;
}

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

/** Outcome of a single unit build attempt. */
export interface UnitBuildOutcome {
  unitId: number;
  unitPath: string;
  attempt: number;
  maxAttempts: number;
  dispatch: UnitBuildDispatchResult;
  backpressure: BackpressureResult[];
  outcome: 'done' | 'retry' | 'failed';
}

/** Terminal result returned by build-loop-runner.ts to the Ralph orchestrator. */
export interface BuildLoopRunnerResult {
  event: 'build_loop_complete' | 'build_loop_blocked' | 'build_loop_error';
  slug: string;
  terminalPlanStatus: PlanStatus;
  nextStep: 'requery_state_machine' | 'report_blocked' | 'report_error';
  taskOperations: TaskProjectionOp[];
  units: UnitBuildOutcome[];
  summary: string;
  blocked?: { reason: string; preconditionError?: string };
  error?: { message: string };
}

/** Patch applied to a unit plan file's metadata by the build loop runner. */
export interface UnitStatusPatch {
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  appendResult: string;
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
