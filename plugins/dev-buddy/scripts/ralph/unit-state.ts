/**
 * Per-unit and plan-level state accessors for the v2 state layout.
 *
 * Writes a tree under `.vcp/plan/.state/ralph-{slug}/`:
 *   plan.json                  (PlanState)
 *   units/unit-N.json          (UnitState, one file per unit)
 *   progress/stage-progress-*  (StageProgress, scoped by slug in stage-runner.ts)
 *
 * Two invariants are enforced at the write boundary:
 *   1. Status transitions that require a context (markUnitDone needs a
 *      passing review; markUnitFailed needs an exhausted budget;
 *      markPlanComplete needs a terminal status) throw if the caller cannot
 *      supply that context.
 *   2. Concurrent writers are detected by a monotonic `generation` counter.
 *      Every writer reads-then-mutates-then-writes with `generation + 1`; a
 *      reader that raced the writer sees the bumped generation and must retry.
 *
 * All writes are atomic via tmp-file + rename, one small file at a time.
 * A crash mid-write leaves either the old file intact (pre-rename) or the new
 * one in full (post-rename) — never a partial.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AttemptRecord,
  MechanicalContext,
  PlanState,
  PlanStatus,
  UnitState,
} from './types.ts';
import {
  ATTEMPT_HISTORY_MAX_ENTRIES,
  MAX_DISPATCH_MS,
  REVIEW_FEEDBACK_MAX_BYTES,
  STDERR_TAIL_MAX_BYTES,
  STDOUT_TAIL_MAX_BYTES,
} from './types.ts';

// ─── PATH HELPERS ───────────────────────────────────────────────────────────

/** Root of a plan's v2 state directory. */
export function planRoot(projectDir: string, slug: string): string {
  return path.join(projectDir, '.vcp', 'plan', '.state', `ralph-${slug}`);
}

export function planJsonPath(projectDir: string, slug: string): string {
  return path.join(planRoot(projectDir, slug), 'plan.json');
}

export function unitJsonPath(projectDir: string, slug: string, unitId: number): string {
  return path.join(planRoot(projectDir, slug), 'units', `unit-${unitId}.json`);
}

export function unitsDirPath(projectDir: string, slug: string): string {
  return path.join(planRoot(projectDir, slug), 'units');
}

export function progressDirPath(projectDir: string, slug: string): string {
  return path.join(planRoot(projectDir, slug), 'progress');
}

// ─── ATOMIC FILE I/O ────────────────────────────────────────────────────────

function atomicWriteJson<T>(filePath: string, value: T): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

function readJsonIfExists<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// ─── HASHING & BOUNDS ───────────────────────────────────────────────────────

export function sha1Hex(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

export function hashUnitFile(projectDir: string, slug: string, unitId: number): string | null {
  const unitMdPath = path.join(projectDir, '.vcp', 'plan', 'ralph', slug, `unit-${unitId}.md`);
  try {
    return sha1Hex(fs.readFileSync(unitMdPath, 'utf-8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function capUtf8Tail(s: string | undefined, maxBytes: number): string {
  if (!s) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  return buf.slice(buf.byteLength - maxBytes).toString('utf8');
}

function boundMechanicalContext(ctx: MechanicalContext | undefined): MechanicalContext | undefined {
  if (!ctx) return undefined;
  return {
    source: ctx.source,
    command: ctx.command,
    exitCode: ctx.exitCode,
    stdoutHead: ctx.stdoutHead,
    stdoutTail: capUtf8Tail(ctx.stdoutTail, STDOUT_TAIL_MAX_BYTES),
    stderrHead: ctx.stderrHead,
    stderrTail: capUtf8Tail(ctx.stderrTail, STDERR_TAIL_MAX_BYTES),
  };
}

function boundReviewFeedback(feedback: string): string {
  return capUtf8Tail(feedback, REVIEW_FEEDBACK_MAX_BYTES);
}

function trimAttemptHistory(history: AttemptRecord[]): AttemptRecord[] {
  if (history.length <= ATTEMPT_HISTORY_MAX_ENTRIES) return history;
  return history.slice(history.length - ATTEMPT_HISTORY_MAX_ENTRIES);
}

// ─── PLAN-LEVEL READS/WRITES ────────────────────────────────────────────────

export function readPlanState(projectDir: string, slug: string): PlanState | null {
  return readJsonIfExists<PlanState>(planJsonPath(projectDir, slug));
}

export function writePlanState(projectDir: string, slug: string, plan: PlanState): void {
  if (plan.slug !== slug) {
    throw new Error(`writePlanState: slug mismatch — arg ${slug} vs state ${plan.slug}`);
  }
  if (plan.schemaVersion !== 2) {
    throw new Error(`writePlanState: schemaVersion must be 2 (got ${plan.schemaVersion})`);
  }
  // Invariant: completedAt ↔ completionSource coherence (Risk §9 "retention race").
  if (plan.completedAt && !plan.completionSource) {
    throw new Error(`writePlanState: completedAt set without completionSource`);
  }
  if (plan.completionSource === 'state-machine' && plan.status !== 'done' && plan.status !== 'failed_irrecoverable') {
    throw new Error(`writePlanState: completionSource='state-machine' requires terminal status`);
  }
  plan.lastTimestamp = new Date().toISOString();
  atomicWriteJson(planJsonPath(projectDir, slug), plan);
}

/**
 * Marks a plan as complete. The only sanctioned path to set completedAt +
 * completionSource='state-machine'. Sweep uses this marker to decide archivability.
 */
export function markPlanComplete(
  projectDir: string,
  slug: string,
  status: 'done' | 'failed_irrecoverable',
  reason: string,
): void {
  const plan = readPlanState(projectDir, slug);
  if (!plan) throw new Error(`markPlanComplete: no plan.json for ${slug}`);
  if (plan.status === 'done' || plan.status === 'failed_irrecoverable') {
    // Idempotent: already complete — refuse silently so double-calls from
    // two paths don't move completedAt forward.
    return;
  }
  plan.status = status;
  plan.completedAt = new Date().toISOString();
  plan.completionSource = 'state-machine';
  plan.lastAction = `markPlanComplete:${reason}`;
  writePlanState(projectDir, slug, plan);
}

// ─── UNIT-LEVEL READS/WRITES ────────────────────────────────────────────────

export function readUnitState(projectDir: string, slug: string, unitId: number): UnitState | null {
  return readJsonIfExists<UnitState>(unitJsonPath(projectDir, slug, unitId));
}

/**
 * List all unit state files under `.state/ralph-{slug}/units/`. Does not throw
 * if the directory doesn't exist — returns []. Order is numeric by unit id.
 */
export function listUnitStates(projectDir: string, slug: string): UnitState[] {
  const dir = unitsDirPath(projectDir, slug);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => /^unit-\d+\.json$/.test(f));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries: UnitState[] = [];
  for (const f of files) {
    const id = parseInt(f.match(/unit-(\d+)\.json/)![1], 10);
    const state = readUnitState(projectDir, slug, id);
    if (state) entries.push(state);
  }
  entries.sort((a, b) => a.id - b.id);
  return entries;
}

/**
 * CAS-guarded write. Reads the current generation (or -1 if file absent),
 * asserts it matches `expectedGeneration`, bumps to `expectedGeneration + 1`,
 * atomically writes. Throws on mismatch (lost-update detection).
 */
function writeUnitStateCAS(
  projectDir: string,
  slug: string,
  unitId: number,
  expectedGeneration: number,
  mutator: (prev: UnitState | null) => UnitState,
): UnitState {
  const filePath = unitJsonPath(projectDir, slug, unitId);
  const current = readUnitState(projectDir, slug, unitId);
  const currentGen = current?.generation ?? -1;
  if (currentGen !== expectedGeneration) {
    throw new Error(
      `writeUnitStateCAS: generation mismatch for unit ${unitId} — expected ${expectedGeneration}, found ${currentGen}`,
    );
  }
  const next = mutator(current);
  if (next.id !== unitId) {
    throw new Error(`writeUnitStateCAS: mutator returned id=${next.id} for unit ${unitId}`);
  }
  next.generation = expectedGeneration + 1;
  atomicWriteJson(filePath, next);
  return next;
}

// ─── RESERVATION PROTOCOL (§1.1) ────────────────────────────────────────────

/**
 * Reserve an attempt PRE-dispatch. Increments `attempts` and stores a
 * `reservedAttempt` lease token that must be echoed back on
 * commitAttemptResult or abandonReservation. Enforces:
 *   - status must be in {pending, reviewing, building}
 *   - attempts must be < maxAttempts
 *   - generation CAS must match `expectedGeneration`
 */
export function reserveAttempt(
  projectDir: string,
  slug: string,
  unitId: number,
  expectedGeneration: number,
): { attempt: number; lease: string; newGeneration: number } {
  const lease = crypto.randomBytes(12).toString('hex');
  const next = writeUnitStateCAS(projectDir, slug, unitId, expectedGeneration, (prev) => {
    if (!prev) throw new Error(`reserveAttempt: unit ${unitId} has no state`);
    if (prev.reservedAttempt) {
      throw new Error(
        `reserveAttempt: unit ${unitId} already has an open reservation (lease ${prev.reservedAttempt.lease})`,
      );
    }
    if (prev.status !== 'pending' && prev.status !== 'reviewing' && prev.status !== 'building') {
      throw new Error(`reserveAttempt: unit ${unitId} is in terminal status '${prev.status}'`);
    }
    if (prev.attempts >= prev.maxAttempts) {
      throw new Error(
        `reserveAttempt: unit ${unitId} has exhausted budget (${prev.attempts}/${prev.maxAttempts})`,
      );
    }
    const nextAttempt = prev.attempts + 1;
    return {
      ...prev,
      attempts: nextAttempt,
      status: 'building',
      reservedAttempt: {
        attempt: nextAttempt,
        reservedAt: new Date().toISOString(),
        lease,
      },
    };
  });
  return { attempt: next.attempts, lease, newGeneration: next.generation };
}

/**
 * Commit the outcome of a reserved attempt. Appends to attemptHistory (bounded
 * at ATTEMPT_HISTORY_MAX_ENTRIES), clears reservedAttempt, updates
 * identicalFailureCount if stuck detection matched.
 *
 * Throws if:
 *   - no reservation open
 *   - lease doesn't match
 *   - record.attempt doesn't match reservation.attempt
 */
export function commitAttemptResult(
  projectDir: string,
  slug: string,
  unitId: number,
  lease: string,
  record: AttemptRecord,
  opts: { identicalFailure: boolean; mechanicalContextAfter?: MechanicalContext; reviewFeedbackAfter?: string } = { identicalFailure: false },
): UnitState {
  const current = readUnitState(projectDir, slug, unitId);
  if (!current) throw new Error(`commitAttemptResult: no state for unit ${unitId}`);
  const expectedGen = current.generation;

  return writeUnitStateCAS(projectDir, slug, unitId, expectedGen, (prev) => {
    if (!prev) throw new Error(`commitAttemptResult: unit ${unitId} disappeared mid-commit`);
    if (!prev.reservedAttempt) throw new Error(`commitAttemptResult: unit ${unitId} has no open reservation`);
    if (prev.reservedAttempt.lease !== lease) {
      throw new Error(
        `commitAttemptResult: lease mismatch for unit ${unitId} (got ${lease}, expected ${prev.reservedAttempt.lease})`,
      );
    }
    if (prev.reservedAttempt.attempt !== record.attempt) {
      throw new Error(
        `commitAttemptResult: attempt number mismatch for unit ${unitId} (record ${record.attempt} vs reservation ${prev.reservedAttempt.attempt})`,
      );
    }

    const boundedRecord: AttemptRecord = {
      ...record,
      mechanicalContext: boundMechanicalContext(record.mechanicalContext),
    };

    // commitAttemptResult is the attempt-history writer, NOT the terminal-transition
    // writer. Terminal statuses ('done'/'failed') are owned exclusively by
    // markUnitDone / markUnitFailed so their invariants (passing review; budget
    // exhausted) gate every transition. All outcomes here leave status non-terminal:
    // 'done' → 'reviewing' (SM dispatches unit-review or calls markUnitDone next),
    // everything else → 'pending' (SM decides retry / stuck / exhausted next).
    const nextStatus: UnitState['status'] = record.outcome === 'done' ? 'reviewing' : 'pending';

    const nextIdenticalFailureCount = opts.identicalFailure
      ? prev.identicalFailureCount + 1
      : (record.outcome === 'retry' ? 0 : prev.identicalFailureCount);

    return {
      ...prev,
      status: nextStatus,
      reservedAttempt: undefined,
      attemptHistory: trimAttemptHistory([...prev.attemptHistory, boundedRecord]),
      lastMechanicalContext: opts.mechanicalContextAfter
        ? boundMechanicalContext(opts.mechanicalContextAfter)
        : prev.lastMechanicalContext,
      reviewFeedback: opts.reviewFeedbackAfter !== undefined
        ? boundReviewFeedback(opts.reviewFeedbackAfter)
        : prev.reviewFeedback,
      identicalFailureCount: nextIdenticalFailureCount,
    };
  });
}

/**
 * Abandon a stale reservation. Used by the crash-recovery sweep: if a
 * reservation is older than MAX_DISPATCH_MS and the owning process is gone,
 * record the attempt as 'abandoned' and clear the reservation so a new
 * attempt can proceed. The budget stays burned (attempts was already
 * incremented by reserveAttempt).
 */
export function abandonReservation(
  projectDir: string,
  slug: string,
  unitId: number,
  lease: string,
  reason: string,
): UnitState {
  const current = readUnitState(projectDir, slug, unitId);
  if (!current) throw new Error(`abandonReservation: no state for unit ${unitId}`);
  const expectedGen = current.generation;

  return writeUnitStateCAS(projectDir, slug, unitId, expectedGen, (prev) => {
    if (!prev) throw new Error(`abandonReservation: unit ${unitId} disappeared`);
    if (!prev.reservedAttempt) throw new Error(`abandonReservation: no reservation to abandon`);
    if (prev.reservedAttempt.lease !== lease) {
      throw new Error(
        `abandonReservation: lease mismatch (got ${lease}, expected ${prev.reservedAttempt.lease})`,
      );
    }
    void reason; // documentary for callers; log.info(retention.abandoned, {reason}) at call site
    const abandonedRecord: AttemptRecord = {
      attempt: prev.reservedAttempt.attempt,
      timestamp: new Date().toISOString(),
      outcome: 'abandoned',
    };
    return {
      ...prev,
      status: 'pending',
      reservedAttempt: undefined,
      attemptHistory: trimAttemptHistory([...prev.attemptHistory, abandonedRecord]),
    };
  });
}

/**
 * Returns true if the reservation is older than MAX_DISPATCH_MS. Used by the
 * orphan-recovery path in ralph-state-machine.ts.
 */
export function isReservationStale(state: UnitState, nowMs: number = Date.now()): boolean {
  if (!state.reservedAttempt) return false;
  const reservedMs = Date.parse(state.reservedAttempt.reservedAt);
  return nowMs - reservedMs > MAX_DISPATCH_MS;
}

// ─── INVARIANT-GUARDED TERMINAL TRANSITIONS ─────────────────────────────────

/**
 * Mark a unit done. Requires a passing review context and a valid lease.
 * Throws if:
 *   - ctx.review.ok is not true
 *   - lease does not match the open reservation (if any)
 *   - status is already terminal
 */
export function markUnitDone(
  projectDir: string,
  slug: string,
  unitId: number,
  ctx: { passed: true; review: { ok: true }; lease?: string },
): UnitState {
  if (!ctx.passed || !ctx.review?.ok) {
    throw new Error(`markUnitDone: invariant — passing review context required`);
  }
  const current = readUnitState(projectDir, slug, unitId);
  if (!current) throw new Error(`markUnitDone: no state for unit ${unitId}`);
  if (current.status === 'done' || current.status === 'failed') {
    throw new Error(`markUnitDone: unit ${unitId} already in terminal status '${current.status}'`);
  }
  if (ctx.lease && current.reservedAttempt && current.reservedAttempt.lease !== ctx.lease) {
    throw new Error(`markUnitDone: lease mismatch for unit ${unitId}`);
  }
  return writeUnitStateCAS(projectDir, slug, unitId, current.generation, (prev) => {
    if (!prev) throw new Error(`markUnitDone: unit ${unitId} disappeared`);
    return {
      ...prev,
      status: 'done',
      reservedAttempt: undefined,
    };
  });
}

/**
 * Mark a unit failed. Requires attempts exhausted OR an explicit permanent
 * failure reason (e.g., plan-lint rejected the unit).
 */
export function markUnitFailed(
  projectDir: string,
  slug: string,
  unitId: number,
  ctx: { attempts: number; maxAttempts: number; reason: string; lease?: string },
): UnitState {
  const current = readUnitState(projectDir, slug, unitId);
  if (!current) throw new Error(`markUnitFailed: no state for unit ${unitId}`);
  if (ctx.attempts !== current.attempts) {
    throw new Error(
      `markUnitFailed: attempts mismatch — ctx ${ctx.attempts} vs state ${current.attempts}`,
    );
  }
  const budgetExhausted = ctx.attempts >= ctx.maxAttempts;
  const permanentReason = ctx.reason.startsWith('permanent:');
  if (!budgetExhausted && !permanentReason) {
    throw new Error(
      `markUnitFailed: invariant — attempts (${ctx.attempts}) must equal maxAttempts (${ctx.maxAttempts}) unless reason is prefixed 'permanent:'`,
    );
  }
  if (current.status === 'done' || current.status === 'failed') {
    throw new Error(`markUnitFailed: unit ${unitId} already in terminal status '${current.status}'`);
  }
  if (ctx.lease && current.reservedAttempt && current.reservedAttempt.lease !== ctx.lease) {
    throw new Error(`markUnitFailed: lease mismatch for unit ${unitId}`);
  }
  return writeUnitStateCAS(projectDir, slug, unitId, current.generation, (prev) => {
    if (!prev) throw new Error(`markUnitFailed: unit ${unitId} disappeared`);
    return {
      ...prev,
      status: 'failed',
      reservedAttempt: undefined,
    };
  });
}

// ─── REVIEW FEEDBACK PERSISTENCE ────────────────────────────────────────────

/**
 * Stash review feedback for the next attempt's dispatch prompt. Captures the
 * current unit-N.md hash as `unitFileHashAtReview` so prompt assembly can
 * detect if the user edited the unit file after the review (and demote/drop
 * the feedback if so — §12).
 */
export function setReviewFeedback(
  projectDir: string,
  slug: string,
  unitId: number,
  feedback: string,
  unitFileHashAtReview: string,
): UnitState {
  const current = readUnitState(projectDir, slug, unitId);
  if (!current) throw new Error(`setReviewFeedback: no state for unit ${unitId}`);
  return writeUnitStateCAS(projectDir, slug, unitId, current.generation, (prev) => {
    if (!prev) throw new Error(`setReviewFeedback: unit ${unitId} disappeared`);
    return {
      ...prev,
      reviewFeedback: boundReviewFeedback(feedback),
      unitFileHashAtReview,
    };
  });
}

/**
 * Read the static unit-N.md content and the per-unit dynamic context needed
 * to compose a dispatch prompt. Read-only; safe for prompt-assembly.ts to
 * call on every compose. Returns null if the unit file is missing.
 */
export function getUnitBuildContext(
  projectDir: string,
  slug: string,
  unitId: number,
): {
  staticPlan: string;
  unitFileHash: string;
  reviewFeedback?: string;
  reviewFeedbackHashAtReview?: string;
  lastMechanicalContext?: MechanicalContext;
  state: UnitState | null;
} | null {
  const unitMdPath = path.join(projectDir, '.vcp', 'plan', 'ralph', slug, `unit-${unitId}.md`);
  let staticPlan: string;
  try {
    staticPlan = fs.readFileSync(unitMdPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const state = readUnitState(projectDir, slug, unitId);
  return {
    staticPlan,
    unitFileHash: sha1Hex(staticPlan),
    reviewFeedback: state?.reviewFeedback,
    reviewFeedbackHashAtReview: state?.unitFileHashAtReview,
    lastMechanicalContext: state?.lastMechanicalContext,
    state,
  };
}

// ─── INITIAL STATE SEEDING ──────────────────────────────────────────────────

/**
 * Create a fresh unit state file. Strict — throws if the file exists.
 * Use ensureUnitStateSeeded for idempotent seeding.
 */
export function seedUnitState(
  projectDir: string,
  slug: string,
  unitId: number,
  decomposeRunId: string,
  maxAttempts: number,
): UnitState {
  const existing = readUnitState(projectDir, slug, unitId);
  if (existing) {
    throw new Error(`seedUnitState: unit ${unitId} already has state (generation ${existing.generation})`);
  }
  const state: UnitState = {
    id: unitId,
    decomposeRunId,
    generation: 0,
    status: 'pending',
    attempts: 0,
    maxAttempts,
    attemptHistory: [],
    identicalFailureCount: 0,
  };
  atomicWriteJson(unitJsonPath(projectDir, slug, unitId), state);
  return state;
}

/**
 * Idempotent seed. Returns existing state if present, otherwise creates a
 * fresh one. Used by BLR at unit entry and by the SM's build-phase reader
 * when a unit-N.md has no corresponding units/unit-N.json yet (fresh plans
 * that never went through the migrator).
 *
 * `initial` carries the markdown-encoded status+attempts snapshot so
 * pre-migration fixtures (unit-N.md with `**Status:** done` / `**Attempts:** N`
 * and no unit-N.json) are honored on first seed. Defaults to pending/0 for
 * truly new units.
 */
export function ensureUnitStateSeeded(
  projectDir: string,
  slug: string,
  unitId: number,
  decomposeRunId: string,
  maxAttempts: number,
  initial?: { status?: 'pending' | 'done' | 'failed'; attempts?: number },
): UnitState {
  const existing = readUnitState(projectDir, slug, unitId);
  if (existing) return existing;
  const status = initial?.status ?? 'pending';
  const attempts = initial?.attempts ?? 0;
  const state: UnitState = {
    id: unitId,
    decomposeRunId,
    generation: 0,
    status,
    attempts,
    maxAttempts,
    attemptHistory: [],
    identicalFailureCount: 0,
  };
  atomicWriteJson(unitJsonPath(projectDir, slug, unitId), state);
  return state;
}

/**
 * Ensure plan.json exists for a slug. If missing, seed with a fresh
 * decomposeRunId so unit states can be seeded coherently. Returns the plan.
 * Safe to call on every `--action next` — idempotent when plan.json exists.
 */
export function ensurePlanStateSeeded(
  projectDir: string,
  slug: string,
  status: PlanStatus,
  lastAction: string,
): PlanState {
  const existing = readPlanState(projectDir, slug);
  if (existing) return existing;
  const now = new Date().toISOString();
  const plan: PlanState = {
    slug,
    schemaVersion: 2,
    decomposeRunId: `seed-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    status,
    outerIteration: 0,
    reviewIteration: 0,
    taskIds: {},
    blockedBy: {},
    unitIds: [],
    unitFileHashes: {},
    startedAt: now,
    lastAction,
    lastTimestamp: now,
  };
  atomicWriteJson(planJsonPath(projectDir, slug), plan);
  return plan;
}

/**
 * Reset unit state after a decompose re-run (decomposeRunId mismatch) or a
 * unit-file hash change. Clears transient fields but keeps the file present.
 * Used by the SM on `--action next` when reconciliation detects drift.
 */
export function resetUnitStateForDecompose(
  projectDir: string,
  slug: string,
  unitId: number,
  newDecomposeRunId: string,
  maxAttempts: number,
): UnitState {
  const current = readUnitState(projectDir, slug, unitId);
  const prevGen = current?.generation ?? -1;
  const next: UnitState = {
    id: unitId,
    decomposeRunId: newDecomposeRunId,
    generation: prevGen + 1,
    status: 'pending',
    attempts: 0,
    maxAttempts,
    attemptHistory: [],
    identicalFailureCount: 0,
  };
  atomicWriteJson(unitJsonPath(projectDir, slug, unitId), next);
  return next;
}

/**
 * Clear review feedback + mechanical context + hashes when the user edits
 * unit-N.md mid-build. Preserves attempts and attemptHistory so the past is
 * visible in diagnostics. §12 pre-clear event logging is the caller's job.
 */
export function clearStaleFeedback(
  projectDir: string,
  slug: string,
  unitId: number,
): UnitState | null {
  const current = readUnitState(projectDir, slug, unitId);
  if (!current) return null;
  return writeUnitStateCAS(projectDir, slug, unitId, current.generation, (prev) => {
    if (!prev) throw new Error(`clearStaleFeedback: unit ${unitId} disappeared`);
    const cleared = { ...prev };
    delete cleared.reviewFeedback;
    delete cleared.unitFileHashAtReview;
    delete cleared.lastMechanicalContext;
    return cleared;
  });
}

// ─── RETENTION — AUTO-ARCHIVE COMPLETED PLANS (§9) ─────────────────────────

export interface SweepCandidate {
  slug: string;
  completedAt: string;
  stateDir: string;
  planDir: string;
  topLevelMd: string;
}

export interface SweepReport {
  skipped?: string;
  candidates: SweepCandidate[];
  archived: Array<{ slug: string; target: string }>;
}

const DEFAULT_RETENTION_DAYS = 7;

function renameIfExists(src: string, dst: string): boolean {
  try {
    fs.renameSync(src, dst);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Sweep completed plans older than retentionDays into `.archive/`. Moves
 * (never deletes) the state dir, plan dir, and top-level plan .md.
 *
 * Only acts on plans whose completedAt was set by markPlanComplete
 * (completionSource === 'state-machine'). Manual edits are excluded.
 *
 * Each candidate is archived in a single rename to prevent half-moved plans
 * from being visible. On crash, the staging dir is left in `.archive/.staging/`
 * for manual inspection.
 */
export function sweepCompletedPlans(
  projectDir: string,
  opts?: { dryRun?: boolean; retentionDays?: number },
): SweepReport {
  const days = opts?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (days === 0) return { skipped: 'retention_disabled', candidates: [], archived: [] };

  const stateRoot = path.join(projectDir, '.vcp', 'plan', '.state');
  const planRoot = path.join(projectDir, '.vcp', 'plan', 'ralph');
  const planParent = path.join(projectDir, '.vcp', 'plan');
  const archiveRoot = path.join(projectDir, '.vcp', 'plan', '.archive');
  const stagingRoot = path.join(archiveRoot, '.staging');
  const cutoff = Date.now() - days * 86_400_000;

  let stateDirs: string[];
  try {
    stateDirs = fs.readdirSync(stateRoot).filter(n => n.startsWith('ralph-'));
  } catch {
    return { candidates: [], archived: [] };
  }

  const candidates: SweepCandidate[] = [];
  for (const dir of stateDirs) {
    const pjPath = path.join(stateRoot, dir, 'plan.json');
    const plan = readJsonIfExists<PlanState>(pjPath);
    if (!plan?.completedAt) continue;
    if (plan.completionSource !== 'state-machine') continue;
    if (Date.parse(plan.completedAt) > cutoff) continue;
    candidates.push({
      slug: plan.slug,
      completedAt: plan.completedAt,
      stateDir: path.join(stateRoot, dir),
      planDir: path.join(planRoot, plan.slug),
      topLevelMd: path.join(planParent, `ralph-${plan.slug}.md`),
    });
  }

  if (opts?.dryRun) return { candidates, archived: [] };
  if (candidates.length === 0) return { candidates, archived: [] };

  fs.mkdirSync(stagingRoot, { recursive: true });

  const archived: Array<{ slug: string; target: string }> = [];
  for (const c of candidates) {
    const safeName = `ralph-${c.slug}-${c.completedAt.replace(/[:.]/g, '-')}`;
    const txnId = crypto.randomUUID();
    const staged = path.join(stagingRoot, txnId, safeName);
    fs.mkdirSync(staged, { recursive: true });

    renameIfExists(c.stateDir, path.join(staged, 'state'));
    renameIfExists(c.planDir, path.join(staged, 'plan'));
    renameIfExists(c.topLevelMd, path.join(staged, `ralph-${c.slug}.md`));

    const target = path.join(archiveRoot, safeName);
    try {
      fs.renameSync(path.join(stagingRoot, txnId, safeName), target);
    } catch {
      continue;
    }

    // Clean up the txnId shell
    try { fs.rmdirSync(path.join(stagingRoot, txnId)); } catch { /* may not be empty */ }

    archived.push({ slug: c.slug, target });
  }

  // Write sweep marker
  const markerPath = path.join(stateRoot, '.sweep.marker');
  try {
    fs.writeFileSync(markerPath, JSON.stringify({ lastSweptAt: new Date().toISOString() }));
  } catch { /* non-fatal */ }

  return { candidates, archived };
}

/** Read the sweep marker to determine when the last sweep ran. */
export function readSweepMarker(projectDir: string): { lastSweptAt: string } | null {
  const markerPath = path.join(projectDir, '.vcp', 'plan', '.state', '.sweep.marker');
  return readJsonIfExists<{ lastSweptAt: string }>(markerPath);
}
