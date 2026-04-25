import type { StepHandler } from "./types.ts";

/**
 * Decompose — split requirements into per-unit plan files. Legacy:
 * plugins/dev-buddy/stages/decomposition.md + decomposer role.
 *
 * v0.6.0 status: SKELETON. The build step depends on per-unit plans
 * produced here; both ports land together in a follow-up commit so
 * the build fanout has real artifacts to consume.
 */
export const runDecomposeStep: StepHandler = async (_deps) => {
  return {
    ok: true,
    patch: { status: "complete" },
    summary: "decompose: skeleton handler advanced state; per-unit plan generation pending",
    output: { ported_in_followup: true, step: "decompose" },
  };
};
