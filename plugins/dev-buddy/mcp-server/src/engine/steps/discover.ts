import type { StepHandler } from "./types.ts";

/**
 * Discover — surface the project's structure and identify the goal's
 * surface area. The legacy v0.5.x prose lives in
 * plugins/dev-buddy/stages/discovery.md and the role lives in
 * system-prompts/built-in/discoverer.md.
 *
 * v0.6.0 status: SKELETON. State transitions are wired through the
 * dispatcher but the LLM-driven code-walk is not yet ported. Lands in
 * a subsequent commit alongside @vcp-lib/llm-runner integration into
 * the MCP server.
 */
export const runDiscoverStep: StepHandler = async (_deps) => {
  return {
    ok: true,
    patch: { status: "complete" },
    summary: "discover: skeleton handler advanced state; LLM-driven discovery to be ported in Phase 5c follow-up",
    output: { ported_in_followup: true, step: "discover" },
  };
};
