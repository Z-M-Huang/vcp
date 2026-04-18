import * as path from 'path';
import type {
  MechanicalContext, AttemptRecord, LatestAttemptState,
  ComposeBuildDispatchOutput, RecordAttemptInput, RecordAttemptOutput,
  RecordReviewInput, RecordReviewOutput,
} from './types.ts';
import { parseUnitPlan } from './parsers.ts';
import {
  readUnitState, ensurePlanStateSeeded, ensureUnitStateSeeded,
  reserveAttempt, commitAttemptResult, setReviewFeedback,
  markUnitDone, markUnitFailed, hashUnitFile, getUnitBuildContext,
  isReservationStale, abandonReservation,
} from './unit-state.ts';
import { splitUnitFile } from './unit-file.ts';
import { composeBuildDispatchPrompt } from './prompt-assembly.ts';
import { loadDevBuddyConfig } from '../pipeline-config.ts';
import { vcpLog, capLogPayload } from '../vcp-logger.ts';

/**
 * True when the unit-review stage has at least one executor configured.
 * When false, recordAttemptResultAction short-circuits mechanical_pass to
 * unit_done without dispatching a review stage. Defaults to false on config
 * read failure so we never dispatch a stage that would crash on zero executors.
 */
function isUnitReviewEnabled(): boolean {
  try {
    const config = loadDevBuddyConfig();
    const stage = config.stages['unit-review'];
    return !!stage && Array.isArray(stage.executors) && stage.executors.length > 0;
  } catch {
    return false;
  }
}

// ─── STUCK DETECTION (§4) ───────────────────────────────────────────────────

/**
 * Normalize stderr for stuck-detection comparison. Strips volatile byte-level
 * variance (timestamps, PIDs, memory addresses, line numbers, temp paths) so
 * that two attempts with the same root-cause failure produce the same hash
 * even when noisy details differ.
 *
 * Conservative: false negatives cost one wasted retry; false positives would
 * kill a unit that could recover. Add new patterns only from observed misses.
 */
export function normalizeStderr(s: string): string {
  return s
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<TS>')
    .replace(/\bpid[=: ]+\d+\b/gi, '<PID>')
    .replace(/\b0x[0-9a-f]{8,16}\b/gi, '<ADDR>')
    .replace(/\/tmp\/[^\s]+/g, '<TMP>')
    .replace(/\bline\s*\d+\b/gi, '<LN>')
    .replace(/:\d+:\d+/g, ':<L>:<C>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect whether the current mechanical failure is identical to the previous
 * one after normalization. Returns true when the same root failure repeated
 * (same command, same exit code, same normalized stderr).
 */
export function detectStuck(
  prev: MechanicalContext | undefined,
  curr: MechanicalContext,
): boolean {
  if (!prev) return false;
  if (prev.command !== curr.command || prev.exitCode !== curr.exitCode) return false;
  const prevStderr = (prev.stderrHead ?? '') + (prev.stderrTail ?? '');
  const currStderr = (curr.stderrHead ?? '') + (curr.stderrTail ?? '');
  return normalizeStderr(prevStderr) === normalizeStderr(currStderr);
}

// ─── SM BUILD ACTIONS (§2, §3 — single-attempt orchestration) ───────────────
// Three actions that move the retry loop out of BLR and into CC-driven SM calls:
//   compose_build_dispatch  — compose prompt, reserve attempt, return {prompt, lease}
//   record_attempt_result   — commit outcome, decide retry/stuck/fail/review
//   record_review_result    — commit review, mark done/retry/fail

/**
 * Compose the dispatch prompt for a build attempt and reserve the attempt slot.
 * Reads unit-N.md (static plan) + units/unit-N.json (feedback, mechanical ctx).
 * Seeds state if missing. Throws if unit is done/failed/exhausted.
 */
export function composeBuildDispatch(
  projectDir: string,
  slug: string,
  unitId: number,
): ComposeBuildDispatchOutput {
  const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
  const unitPath = path.join(unitsDir, `unit-${unitId}.md`);

  const ctx = getUnitBuildContext(projectDir, slug, unitId);
  if (!ctx) throw new Error(`composeBuildDispatch: unit ${unitId} file not found`);

  if (!ctx.state) {
    const parsed = parseUnitPlan(ctx.staticPlan, unitId);
    let maxAttempts = parsed.maxAttempts;
    try {
      const cfg = loadDevBuddyConfig();
      maxAttempts = Math.min(maxAttempts, cfg.max_build_attempts);
    } catch { /* keep parsed value */ }
    const plan = ensurePlanStateSeeded(projectDir, slug, 'build', 'sm-compose');
    ensureUnitStateSeeded(projectDir, slug, unitId, plan.decomposeRunId, maxAttempts, {
      status: parsed.status as 'pending' | 'done' | 'failed',
      attempts: parsed.attempts,
    });
  }

  let state = readUnitState(projectDir, slug, unitId)!;

  // §1.1 crash recovery: if a previous dispatch reserved an attempt but never
  // committed (CC crashed mid-dispatch), the reservation is stale. Abandon it
  // so a fresh attempt can proceed — the budget stays burned (attempts was
  // already incremented by the prior reserveAttempt).
  if (state.reservedAttempt && isReservationStale(state)) {
    abandonReservation(projectDir, slug, unitId, state.reservedAttempt.lease, 'stale_reservation');
    state = readUnitState(projectDir, slug, unitId)!;
  }

  if (state.status === 'done' || state.status === 'failed') {
    throw new Error(`composeBuildDispatch: unit ${unitId} is in terminal status '${state.status}'`);
  }
  if (state.attempts >= state.maxAttempts) {
    throw new Error(
      `composeBuildDispatch: unit ${unitId} has exhausted budget (${state.attempts}/${state.maxAttempts})`,
    );
  }

  let previousAttempt: LatestAttemptState | null = null;
  if (state.lastMechanicalContext) {
    previousAttempt = {
      attempt: state.attempts,
      dispatchEvent: null,
      dispatchError: null,
      backpressure: [],
      outcome: 'retry',
      mechanicalContext: state.lastMechanicalContext,
    };
  }

  const { staticPlan } = splitUnitFile(ctx.staticPlan);
  const reviewFeedback = state.reviewFeedback ?? '';
  const composed = composeBuildDispatchPrompt(staticPlan, reviewFeedback, previousAttempt, unitPath);

  const reservation = reserveAttempt(projectDir, slug, unitId, state.generation);

  return {
    prompt: composed.prompt,
    lease: reservation.lease,
    attempt: reservation.attempt,
    unitId,
    unitPath,
    priority: composed.priority,
    generation: reservation.newGeneration,
  };
}

/**
 * Record the outcome of a single build attempt. Commits to unit-N.json and
 * decides the next action for CC:
 *   mechanical_pass → dispatch_unit_review (reservation stays open)
 *   mechanical_fail → retry_unit | escalate_stuck | unit_failed
 *   dispatch_error  → retry_unit | unit_failed
 */
export function recordAttemptResultAction(
  projectDir: string,
  slug: string,
  data: RecordAttemptInput,
): RecordAttemptOutput {
  const unitState = readUnitState(projectDir, slug, data.unitId);
  if (!unitState) throw new Error(`recordAttemptResult: no state for unit ${data.unitId}`);

  if (data.outcome === 'mechanical_pass') {
    // If unit-review is disabled (no executors configured), skip straight to
    // marking the unit done. Otherwise dispatch the review stage.
    const unitReviewEnabled = isUnitReviewEnabled();
    if (!unitReviewEnabled) {
      const record: AttemptRecord = {
        attempt: unitState.attempts,
        timestamp: new Date().toISOString(),
        outcome: 'done',
        reviewPassed: true,
      };
      commitAttemptResult(projectDir, slug, data.unitId, data.lease, record, {
        identicalFailure: false,
        reviewFeedbackAfter: '',
      });
      markUnitDone(projectDir, slug, data.unitId, {
        passed: true,
        review: { ok: true },
      });
      return { nextAction: 'unit_done', unitId: data.unitId };
    }
    return {
      nextAction: 'dispatch_unit_review',
      unitId: data.unitId,
      lease: data.lease,
    };
  }

  const currMech = data.mechanicalContext ?? undefined;
  const prevMech = unitState.lastMechanicalContext;
  const identicalFailure = !!(currMech && prevMech && detectStuck(prevMech, currMech));
  const newIdenticalCount = identicalFailure ? unitState.identicalFailureCount + 1 : 0;
  const isStuck = newIdenticalCount >= 2;
  const isExhausted = unitState.attempts >= unitState.maxAttempts;

  const recordOutcome: AttemptRecord['outcome'] = isExhausted ? 'failed'
    : isStuck ? 'stuck'
    : 'retry';

  const record: AttemptRecord = {
    attempt: unitState.attempts,
    timestamp: new Date().toISOString(),
    outcome: recordOutcome,
    mechanicalContext: currMech,
  };

  commitAttemptResult(projectDir, slug, data.unitId, data.lease, record, {
    identicalFailure,
    mechanicalContextAfter: currMech,
  });

  if (isExhausted) {
    markUnitFailed(projectDir, slug, data.unitId, {
      attempts: unitState.attempts,
      maxAttempts: unitState.maxAttempts,
      reason: `attempt ${unitState.attempts}/${unitState.maxAttempts} exhausted`,
    });
    return { nextAction: 'unit_failed', unitId: data.unitId };
  }

  if (isStuck) {
    return {
      nextAction: 'escalate_stuck',
      unitId: data.unitId,
      identicalFailureCount: newIdenticalCount,
    };
  }

  return { nextAction: 'retry_unit', unitId: data.unitId };
}

/**
 * Record the outcome of a per-unit semantic review. Handles both pass (mark
 * done) and fail (persist feedback, check budget) paths. §11 log points for
 * review.feedback.cleared and review.needs_changes live here — the SM is the
 * single writer, so the log captures happen at the write boundary.
 */
export async function recordReviewResultAction(
  projectDir: string,
  slug: string,
  data: RecordReviewInput,
  debugEnabled: boolean,
): Promise<RecordReviewOutput> {
  const SRC = 'ralph-state-machine';
  const unitState = readUnitState(projectDir, slug, data.unitId);
  if (!unitState) throw new Error(`recordReviewResult: no state for unit ${data.unitId}`);

  if (data.passed) {
    if (unitState.reviewFeedback) {
      await vcpLog(projectDir, {
        source: SRC,
        event: 'review.feedback.cleared',
        decision: 'info',
        fsync: true,
        details: `slug=${slug} unit=${data.unitId} attempt=${unitState.attempts} ` +
          `reason=unit_passed_review\ncleared.tail: ${capLogPayload(unitState.reviewFeedback, 4 * 1024)}`,
      }, debugEnabled);
    }

    const record: AttemptRecord = {
      attempt: unitState.attempts,
      timestamp: new Date().toISOString(),
      outcome: 'done',
      reviewPassed: true,
    };
    commitAttemptResult(projectDir, slug, data.unitId, data.lease, record, {
      identicalFailure: false,
      reviewFeedbackAfter: '',
    });

    markUnitDone(projectDir, slug, data.unitId, {
      passed: true,
      review: { ok: true },
    });

    return { nextAction: 'unit_done', unitId: data.unitId };
  }

  // Review failed
  await vcpLog(projectDir, {
    source: SRC,
    event: 'review.needs_changes',
    decision: 'info',
    fsync: true,
    details: `slug=${slug} unit=${data.unitId} attempt=${unitState.attempts} ` +
      `feedbackBytes=${data.feedback.length}\nfeedback: ${capLogPayload(data.feedback)}`,
  }, debugEnabled);

  const unitFileHash = hashUnitFile(projectDir, slug, data.unitId) ?? '';
  setReviewFeedback(projectDir, slug, data.unitId, data.feedback, unitFileHash);

  const isExhausted = unitState.attempts >= unitState.maxAttempts;
  const record: AttemptRecord = {
    attempt: unitState.attempts,
    timestamp: new Date().toISOString(),
    outcome: isExhausted ? 'failed' : 'retry',
    reviewPassed: false,
  };
  commitAttemptResult(projectDir, slug, data.unitId, data.lease, record, {
    identicalFailure: false,
    reviewFeedbackAfter: data.feedback,
  });

  if (isExhausted) {
    markUnitFailed(projectDir, slug, data.unitId, {
      attempts: unitState.attempts,
      maxAttempts: unitState.maxAttempts,
      reason: `review failed, attempt ${unitState.attempts}/${unitState.maxAttempts} exhausted`,
    });
    return { nextAction: 'unit_failed', unitId: data.unitId };
  }

  return { nextAction: 'retry_unit', unitId: data.unitId };
}
