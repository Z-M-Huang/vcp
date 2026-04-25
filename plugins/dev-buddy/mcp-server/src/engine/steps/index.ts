/**
 * Step handler registry.
 *
 * Each step exports a default `runStep` async function with the
 * StepHandler signature. The dispatcher imports lazily so the cost of
 * heavy per-step deps (prompt-assets, llm-runner, agentool) is paid
 * only when that step actually runs.
 *
 * Phase 5c (this commit): each step is a SKELETON that advances state
 * with a `ported_in_followup: true` flag in its summary. The state
 * machine, lease lifecycle, and dispatcher are real and tested; the
 * LLM-driven domain work for each step lands in subsequent commits.
 */

import type { StepHandler } from "./types.ts";
import { runDiscoverStep } from "./discover.ts";
import { runRequirementsStep } from "./requirements.ts";
import { runDecomposeStep } from "./decompose.ts";
import { runBuildStep } from "./build.ts";
import { runCodeReviewStep } from "./code-review.ts";
import { runUatStep } from "./uat.ts";

export const STEP_HANDLERS: Record<string, StepHandler> = {
  "discover": runDiscoverStep,
  "requirements": runRequirementsStep,
  "decompose": runDecomposeStep,
  "build": runBuildStep,
  "code-review": runCodeReviewStep,
  "uat": runUatStep,
};
