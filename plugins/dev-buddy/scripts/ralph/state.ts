import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { PlanState, PlanStatus, StateMachineState } from './types.ts';
import { planJsonPath, planRoot, readPlanState, writePlanState } from './unit-state.ts';

// ─── STATE PROJECTION (v2 plan.json → legacy StateMachineState) ─────────────
//
// Post-migration the runner keeps plan-level state in the v2 per-unit tree at
// `.state/ralph-{slug}/plan.json`. The legacy monolith at
// `.state/ralph-{slug}.json` is gone. The public contract of this module is
// unchanged — callers still see `StateMachineState` — but reads and writes
// are routed through the v2 plan.json via the `unit-state.ts` accessors.
//
// Vestigial fields that the legacy shape carried (`units: []`) are
// synthesized on read and dropped on write.

function projectPlanToStateMachine(plan: PlanState): StateMachineState {
  return {
    slug: plan.slug,
    status: plan.status,
    outerIteration: plan.outerIteration,
    reviewIteration: plan.reviewIteration,
    units: [], // vestigial — v2 stores per-unit state in units/unit-N.json
    lastAction: plan.lastAction,
    lastTimestamp: plan.lastTimestamp,
    taskIds: plan.taskIds ?? {},
    blockedBy: plan.blockedBy ?? {},
  };
}

/**
 * New-plan seed. Used only when no v2 plan.json exists and no legacy monolith
 * exists either — i.e. the very first `--action next` on a never-started slug.
 * The migrator covers the legacy-monolith case on its own.
 */
function initialPlanState(slug: string, status: PlanStatus, lastAction: string): PlanState {
  const now = new Date().toISOString();
  return {
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
}

// ─── STATE FILE I/O ─────────────────────────────────────────────────────────

/**
 * Load persisted state from `.vcp/plan/.state/ralph-{slug}/plan.json`.
 * Returns null if no plan state exists yet. Throws SyntaxError on malformed JSON.
 *
 * Fallback path: if plan.json is missing but the legacy monolith
 * `.state/ralph-{slug}.json` still exists (pre-migration), read it directly so
 * pre-migration test fixtures keep working. Post-migration the legacy file is
 * gone and we only see plan.json.
 */
export function loadState(projectDir: string, slug: string): StateMachineState | null {
  const plan = readPlanState(projectDir, slug);
  if (plan) return projectPlanToStateMachine(plan);

  const legacyPath = path.join(projectDir, '.vcp', 'plan', '.state', `ralph-${slug}.json`);
  try {
    const raw = fs.readFileSync(legacyPath, 'utf-8');
    const parsed = JSON.parse(raw) as StateMachineState;
    if (!parsed.blockedBy) parsed.blockedBy = {};
    return parsed;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Persist state. Writes to `.state/ralph-{slug}/plan.json` via the invariant-
 * guarded v2 accessor. Creates the file on first write. The caller-supplied
 * `StateMachineState` is projected onto the existing `PlanState` — v2-only
 * fields (decomposeRunId, unitIds, unitFileHashes, completedAt, …) are
 * preserved when they already exist.
 */
export function saveState(projectDir: string, slug: string, state: StateMachineState): void {
  const base = ensurePlanStateForMutation(projectDir, slug, state.lastAction);
  const now = new Date().toISOString();
  const merged: PlanState = {
    ...base,
    status: state.status,
    outerIteration: state.outerIteration,
    reviewIteration: state.reviewIteration,
    taskIds: state.taskIds ?? {},
    blockedBy: state.blockedBy ?? {},
    lastAction: state.lastAction,
    lastTimestamp: state.lastTimestamp || now,
  };
  writePlanState(projectDir, slug, merged);
}

// ─── INTERNAL: SEED OR UPDATE PLAN STATE ────────────────────────────────────

/**
 * Returns a PlanState for mutation. Resolution order:
 *   1. v2 plan.json if present
 *   2. Legacy monolith (projected to PlanState) if present — preserves
 *      taskIds, blockedBy, status, iterations across the first mutation that
 *      lands before the migrator runs.
 *   3. Fresh seed with status='discover'.
 */
function ensurePlanStateForMutation(
  projectDir: string,
  slug: string,
  lastAction: string,
): PlanState {
  const existing = readPlanState(projectDir, slug);
  if (existing) return existing;

  const legacy = loadLegacyMonolith(projectDir, slug);
  if (legacy) {
    const seeded = initialPlanState(slug, legacy.status, lastAction);
    return {
      ...seeded,
      outerIteration: legacy.outerIteration,
      reviewIteration: legacy.reviewIteration,
      taskIds: legacy.taskIds ?? {},
      blockedBy: legacy.blockedBy ?? {},
    };
  }
  return initialPlanState(slug, 'discover', lastAction);
}

function loadLegacyMonolith(projectDir: string, slug: string): StateMachineState | null {
  const legacyPath = path.join(projectDir, '.vcp', 'plan', '.state', `ralph-${slug}.json`);
  try {
    const raw = fs.readFileSync(legacyPath, 'utf-8');
    const parsed = JSON.parse(raw) as StateMachineState;
    if (!parsed.blockedBy) parsed.blockedBy = {};
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// ─── TASK ID PERSISTENCE ────────────────────────────────────────────────────

/**
 * Register a task ID in plan.json under taskIds[ref]. Creates plan.json if
 * absent. Preserves all v2-only fields (decomposeRunId, unitIds, etc.).
 */
export function registerTaskId(
  projectDir: string,
  slug: string,
  ref: string,
  taskId: string,
): void {
  const plan = ensurePlanStateForMutation(projectDir, slug, 'register-task');
  const next: PlanState = {
    ...plan,
    taskIds: { ...plan.taskIds, [ref]: taskId },
    lastAction: 'register-task',
    lastTimestamp: new Date().toISOString(),
  };
  writePlanState(projectDir, slug, next);
}

/**
 * Bulk-register a task graph: merges `taskIds` and replaces `blockedBy` in one
 * atomic read-modify-write. Reduces the race window vs. N per-ref calls.
 *
 * `blockedBy` is authoritative — the input map replaces any prior edges for
 * the refs it mentions. Refs not in the input keep their existing edges.
 */
export function registerTaskGraph(
  projectDir: string,
  slug: string,
  payload: { taskIds: Record<string, string>; blockedBy: Record<string, string[]> },
): void {
  const plan = ensurePlanStateForMutation(projectDir, slug, 'register-task-graph');
  const next: PlanState = {
    ...plan,
    taskIds: { ...plan.taskIds, ...payload.taskIds },
    blockedBy: { ...plan.blockedBy, ...payload.blockedBy },
    lastAction: 'register-task-graph',
    lastTimestamp: new Date().toISOString(),
  };
  writePlanState(projectDir, slug, next);
}

// ─── INTROSPECTION ──────────────────────────────────────────────────────────

/** Used by tests to assert the v2 layout was written (plan.json exists). */
export function planStatePath(projectDir: string, slug: string): string {
  return planJsonPath(projectDir, slug);
}

/** Used by tests to assert the v2 layout was written (ralph-{slug}/ exists). */
export function planStateRoot(projectDir: string, slug: string): string {
  return planRoot(projectDir, slug);
}
