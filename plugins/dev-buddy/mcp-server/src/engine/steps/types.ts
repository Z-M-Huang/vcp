import type { RunState } from "../state-store.ts";

/**
 * Inputs every step receives. The state machine constructs a fresh
 * StepDeps for each call; a step handler should treat it as immutable.
 */
export interface StepDeps {
  projectRoot: string;
  /** Set when the state machine acquired a lease for the caller. */
  leaseOwnerId: string;
  /** Current state, already loaded by the dispatcher. */
  state: RunState;
}

/**
 * Step handlers describe the change to apply to state. The state
 * machine commits the patch (via withLock + writeState) — handlers
 * never write state directly. This lets us layer atomicity, validation,
 * and the lease lifecycle in one place.
 */
export interface StepResult {
  ok: boolean;
  /** Optional patch to merge into the run state on success. */
  patch?: Partial<Omit<RunState, "schema_version" | "run_id" | "created_at">>;
  /** Human-readable summary, copied into state.summary on success. */
  summary?: string;
  /** Optional error reason when ok=false. */
  reason?: string;
  /** Optional structured payload returned to the MCP caller. */
  output?: Record<string, unknown>;
}

export type StepHandler = (deps: StepDeps) => Promise<StepResult>;
