import type { StepHandler } from "./types.ts";

/**
 * Build — per-unit plan execution with worker-pool fanout. Legacy:
 * plugins/dev-buddy/stages/ralph-build.md + unit-builder role +
 * scripts/ralph/build-actions.ts.
 *
 * v0.6.0 status: SKELETON. The full port needs the staged-commit
 * protocol (stage -> validate -> conflict-check -> promote), the
 * cross-process rate limiter, the cancellation tree, and the
 * per-unit JSON-schema validator. Each piece is non-trivial; they
 * land together in a follow-up commit because the build step is
 * the integration point that exercises all of them.
 */
export const runBuildStep: StepHandler = async (_deps) => {
  return {
    ok: true,
    patch: { status: "complete" },
    summary: "build: skeleton handler advanced state; per-unit fanout + commit protocol pending",
    output: { ported_in_followup: true, step: "build" },
  };
};
