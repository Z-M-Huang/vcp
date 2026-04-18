import type { UnitListEntry, TaskOperation } from './types.ts';

/** Structured diff between expected and actual task-graph edges. */
export interface TaskGraphDiff {
  /** Unit refs missing entirely from state.blockedBy. */
  missingRefs: string[];
  /** Refs present in state.blockedBy but absent from the current unit list. */
  extraRefs: string[];
  /** Refs where state.blockedBy[ref] does not match the expected edges. */
  mismatchedEdges: Array<{ ref: string; expected: string[]; actual: string[] }>;
}

/** Pure-function core of verify-task-graph. Compares expected edges to state. */
export function verifyTaskGraph(
  expected: UnitListEntry[],
  stateBlockedBy: Record<string, string[]>,
): { ok: boolean; diff: TaskGraphDiff } {
  const missingRefs: string[] = [];
  const mismatchedEdges: Array<{ ref: string; expected: string[]; actual: string[] }> = [];
  const expectedRefs = new Set(expected.map(e => e.ref));

  for (const entry of expected) {
    const actual = stateBlockedBy[entry.ref];
    if (actual === undefined) {
      missingRefs.push(entry.ref);
      continue;
    }
    const expectedSorted = [...entry.blockedByRefs].sort();
    const actualSorted = [...actual].sort();
    if (JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)) {
      mismatchedEdges.push({
        ref: entry.ref,
        expected: entry.blockedByRefs,
        actual,
      });
    }
  }

  const extraRefs = Object.keys(stateBlockedBy).filter(ref =>
    ref.startsWith('unit:') && !expectedRefs.has(ref),
  );

  const ok = missingRefs.length === 0 && extraRefs.length === 0 && mismatchedEdges.length === 0;
  return { ok, diff: { missingRefs, extraRefs, mismatchedEdges } };
}

/**
 * Derive `set_blocked_by` operations from a persisted task graph so Claude Code
 * can execute them mechanically via the existing update_tasks handler, instead
 * of re-deriving the ref→taskId mapping by hand. Emits one op per unit that
 * has a non-empty dependency list, plus one op for `stage:build` covering all
 * units when the stage task is registered. Unit refs are sorted numerically so
 * output is stable for tests and diff-friendly log lines. Callers should omit
 * the `actions` wrapper entirely when this returns `[]`.
 */
export function computeBlockedByOperations(
  taskIds: Record<string, string>,
  blockedBy: Record<string, string[]>,
): TaskOperation[] {
  const ops: TaskOperation[] = [];
  const unitRefs = Object.keys(taskIds)
    .filter(r => r.startsWith('unit:'))
    .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
  for (const ref of unitRefs) {
    const deps = blockedBy[ref] ?? [];
    if (deps.length > 0) ops.push({ action: 'set_blocked_by', ref, blockedBy: deps });
  }
  if (taskIds['stage:build'] && unitRefs.length > 0) {
    ops.push({ action: 'set_blocked_by', ref: 'stage:build', blockedBy: unitRefs });
  }
  return ops;
}
