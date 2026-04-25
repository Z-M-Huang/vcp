import {
  readState, writeState, withLock,
  tryAcquireLease, releaseLease,
  type RunState,
} from "./state-store.ts";
import { logEvent } from "./event-log.ts";
import { logPath } from "./state-store.ts";
import { nextStep, STEP_ORDER, type StepName } from "./dispatcher.ts";
import { STEP_HANDLERS } from "./steps/index.ts";

const LEASE_TTL_MS = 60_000;

export interface AdvanceResult {
  ok: boolean;
  run_id: string;
  step_run: StepName | null;
  next_step: StepName | null;
  status: RunState["status"];
  summary?: string;
  output?: Record<string, unknown>;
  reason?: string;
}

/**
 * Run exactly one step's worth of work and commit the resulting state.
 *
 * Order: load → dispatch next → acquire lease → run handler → withLock
 * (read-merge-write state) → release lease.
 *
 * The lease prevents two concurrent ralph_next calls from each picking
 * the same step. The withLock window guarantees the state read+merge
 * happens atomically vs. any other in-flight mutation (e.g. lease
 * reclamation from another caller).
 */
export async function advance(projectRoot: string, runId: string): Promise<AdvanceResult> {
  const state = readState(projectRoot, runId);
  if (!state) {
    return {
      ok: false,
      run_id: runId,
      step_run: null,
      next_step: null,
      status: "failed",
      reason: `run ${runId} has no state.json under ${projectRoot}; was it created via ralph_start?`,
    };
  }

  const step = nextStep(state);
  if (!step) {
    return {
      ok: true,
      run_id: runId,
      step_run: null,
      next_step: null,
      status: state.status,
      summary: state.summary,
    };
  }

  const lease = tryAcquireLease(projectRoot, runId, step, LEASE_TTL_MS);
  if (!lease.ok) {
    return {
      ok: false,
      run_id: runId,
      step_run: step,
      next_step: step,
      status: state.status,
      reason: `another caller holds the lease (owner ${lease.owner_id}, last heartbeat ${lease.heartbeat_at})`,
    };
  }

  const handler = STEP_HANDLERS[step];
  if (!handler) {
    releaseLease(projectRoot, runId, lease.owner_id);
    return {
      ok: false,
      run_id: runId,
      step_run: step,
      next_step: step,
      status: state.status,
      reason: `no handler registered for step '${step}'`,
    };
  }

  let result;
  try {
    result = await handler({ projectRoot, leaseOwnerId: lease.owner_id, state });
  } catch (err) {
    releaseLease(projectRoot, runId, lease.owner_id);
    logEvent(logPath(projectRoot, runId), {
      event: "step_threw", run_id: runId, step, error: (err as Error).message,
    });
    return {
      ok: false,
      run_id: runId,
      step_run: step,
      next_step: step,
      status: state.status,
      reason: `step '${step}' threw: ${(err as Error).message}`,
    };
  }

  // Compute the new state under withLock to serialize against any
  // concurrent reclaim.
  const committed = withLock(projectRoot, runId, () => {
    const fresh = readState(projectRoot, runId);
    if (!fresh) return null;

    const now = new Date().toISOString();
    const isLastStep = STEP_ORDER.indexOf(step) === STEP_ORDER.length - 1;
    const handlerStatus = result.patch?.status;

    let nextStatus: RunState["status"];
    if (!result.ok) {
      nextStatus = "failed";
    } else if (handlerStatus === "complete" && !isLastStep) {
      // Step handler signaled "this step is done" — advance to the
      // next step but keep the run going.
      nextStatus = "running";
    } else if (handlerStatus === "complete" && isLastStep) {
      nextStatus = "complete";
    } else {
      nextStatus = handlerStatus ?? "running";
    }

    const advanceStep = result.ok && handlerStatus === "complete";
    const newStep = advanceStep
      ? STEP_ORDER[STEP_ORDER.indexOf(step) + 1] ?? step
      : step;

    const merged: RunState = {
      ...fresh,
      ...(result.patch ?? {}),
      step: advanceStep && nextStatus !== "complete" ? newStep : (advanceStep ? step : step),
      status: nextStatus,
      updated_at: now,
      summary: result.summary ?? fresh.summary,
    };
    writeState(projectRoot, merged);
    return merged;
  });

  releaseLease(projectRoot, runId, lease.owner_id);

  if (!committed) {
    return {
      ok: false,
      run_id: runId,
      step_run: step,
      next_step: step,
      status: state.status,
      reason: "state.json disappeared mid-step (run dir was cleaned up?)",
    };
  }

  return {
    ok: result.ok,
    run_id: runId,
    step_run: step,
    next_step: nextStep(committed),
    status: committed.status,
    summary: committed.summary,
    output: result.output,
    reason: result.reason,
  };
}
