import type { StepHandler } from "./types.ts";

/**
 * Requirements — refine goal into testable acceptance criteria. Legacy
 * prose: plugins/dev-buddy/stages/ralph-requirements.md +
 * system-prompts/built-in/ralph-requirements-analyst.md.
 *
 * v0.6.0 status: SKELETON. Same shape as discover.ts.
 */
export const runRequirementsStep: StepHandler = async (_deps) => {
  return {
    ok: true,
    patch: { status: "complete" },
    summary: "requirements: skeleton handler advanced state; LLM port pending",
    output: { ported_in_followup: true, step: "requirements" },
  };
};
