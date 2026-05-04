import type { StepHandler } from "./types.ts";

/**
 * UAT — verify the merged work satisfies the original goal. Legacy:
 * plugins/dev-buddy/stages/ralph-uat.md + uat-evaluator role.
 *
 * v0.6.0 status: SKELETON. Final step; on success the run transitions
 * to status='complete'.
 */
export const runUatStep: StepHandler = async (_deps) => {
  return {
    ok: true,
    patch: { status: "complete" },
    summary: "uat: skeleton handler completed run; UAT-evaluator LLM port pending",
    output: { ported_in_followup: true, step: "uat" },
  };
};
