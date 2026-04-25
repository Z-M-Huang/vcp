import type { RunState } from "./state-store.ts";

/**
 * Canonical Ralph step order. ralph_next walks this list one step at a
 * time. Each name corresponds to engine/steps/<name>.ts.
 */
export const STEP_ORDER = [
  "discover",
  "requirements",
  "decompose",
  "build",
  "code-review",
  "uat",
] as const;

export type StepName = typeof STEP_ORDER[number];

/**
 * Decide which step to run next given the current run state.
 *
 * Returns null when the run is already complete or has no further
 * steps. When status is 'failed' or 'interrupted', the dispatcher
 * returns the SAME step rather than advancing — the caller should
 * abort or explicitly mark the run as ready before retrying.
 */
export function nextStep(state: RunState): StepName | null {
  if (state.status === "complete") return null;
  // state.step is always "the step to run next" — the state machine
  // commits it that way after every advance(). For pending, running,
  // failed, and interrupted, we return state.step as-is. The caller
  // decides whether to retry (failed/interrupted) or proceed.
  return STEP_ORDER.includes(state.step as StepName) ? (state.step as StepName) : null;
}

/** First step in the canonical order (`discover`). */
export const FIRST_STEP: StepName = STEP_ORDER[0];
