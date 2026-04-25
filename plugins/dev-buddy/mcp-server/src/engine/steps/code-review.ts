import type { StepHandler } from "./types.ts";

/**
 * Code review — diff-aware review of all build outputs. Legacy:
 * plugins/dev-buddy/stages/ralph-code-review.md + ralph-code-reviewer
 * role.
 *
 * v0.6.0 status: SKELETON. Same shape as discover.ts.
 */
export const runCodeReviewStep: StepHandler = async (_deps) => {
  return {
    ok: true,
    patch: { status: "complete" },
    summary: "code-review: skeleton handler advanced state; reviewer LLM port pending",
    output: { ported_in_followup: true, step: "code-review" },
  };
};
