/**
 * Build-dispatch prompt composition for the Ralph pipeline.
 *
 * Per plan §13 and §14: prompt assembly is owned by ralph/prompt-assembly.ts,
 * not build-loop-runner.ts. BLR becomes a pure dispatcher (stdin → executor →
 * JSON out); this module owns the template and the review-first ordering.
 *
 * Ordering rule (§13):
 *   1. Header (runner ownership rules)
 *   2. PRIOR REVIEW FEEDBACK — rendered first when present, under a
 *      "MUST ADDRESS" heading. The review finding is why the last attempt was
 *      rejected, so the builder reads it first regardless of whether a new
 *      mechanical failure landed this iteration.
 *   3. PRIOR MECHANICAL FAILURE — below the review block (or alone when no
 *      review feedback exists). Labeled "address alongside the review
 *      feedback" so the builder addresses both, not just one.
 *   4. STATIC UNIT PLAN — authoritative contract, always last so it stays
 *      on-screen as the builder reads down.
 *
 * The legacy `mechanical_first` priority (and the "ADDRESS AFTER MECHANICAL
 * IS GREEN" demotion copy) is removed: it caused the builder to defer review
 * findings as "later work" and loop on the same unaddressed rejection.
 */
import type { MechanicalContext, LatestAttemptState } from './types.ts';
import { splitUnitFile } from './unit-file.ts';

/** Which prior-context block (if any) occupies the priority slot. */
export type DispatchPriority = 'review_first' | 'mechanical_only' | 'none';

export interface ComposeBuildDispatchPromptResult {
  prompt: string;
  staticPlanChars: number;
  feedbackChars: number;
  mechanicalChars: number;
  priority: DispatchPriority;
}

/**
 * Format a {@link MechanicalContext} into a prompt-ready text block. Empty
 * channels are skipped. Head and tail are labelled so the executor can tell
 * which came from where.
 */
export function renderMechanicalBlock(ctx: MechanicalContext): string {
  const lines: string[] = [];
  lines.push(`Source: ${ctx.source}`);
  lines.push(`Command: ${ctx.command}`);
  lines.push(`Exit code: ${ctx.exitCode}`);
  if (ctx.stdoutHead) lines.push('', 'stdout (head):', ctx.stdoutHead);
  if (ctx.stdoutTail) lines.push('', 'stdout (tail):', ctx.stdoutTail);
  if (ctx.stderrHead) lines.push('', 'stderr (head):', ctx.stderrHead);
  if (ctx.stderrTail) lines.push('', 'stderr (tail):', ctx.stderrTail);
  return lines.join('\n');
}

/**
 * Compose the build-stage executor prompt from a static unit plan and the
 * prior-attempt context. See module-level docstring for the ordering rules.
 */
export function composeBuildDispatchPrompt(
  staticPlan: string,
  reviewFeedback: string,
  previousAttempt: LatestAttemptState | null,
  unitPath: string,
): ComposeBuildDispatchPromptResult {
  const feedback = (reviewFeedback ?? '').trim();
  const hasFeedback = feedback.length > 0;
  const hasMechanical =
    previousAttempt !== null &&
    previousAttempt.outcome === 'retry' &&
    previousAttempt.mechanicalContext !== null;
  const mechanicalBlock = hasMechanical
    ? renderMechanicalBlock(previousAttempt!.mechanicalContext!)
    : '';

  const priority: DispatchPriority = hasFeedback
    ? 'review_first'
    : hasMechanical ? 'mechanical_only' : 'none';

  const header = [
    'Orchestrated single-unit build.',
    `Unit plan path: ${unitPath}`,
    'Do NOT write **Status:** or decide pass/fail — the outer runner handles that.',
    'Do NOT modify the unit plan file itself.',
  ];

  const reviewSection = hasFeedback ? [
    '',
    '--- PRIOR REVIEW FEEDBACK (MUST ADDRESS — this is why the last attempt was rejected) ---',
    feedback,
  ] : [];

  const mechanicalHeading = hasFeedback
    ? '--- PRIOR MECHANICAL FAILURE (address alongside the review feedback) ---'
    : '--- PRIOR MECHANICAL FAILURE ---';
  const mechanicalSection = hasMechanical ? [
    '',
    mechanicalHeading,
    mechanicalBlock,
  ] : [];

  const staticBlock = [
    '',
    '--- STATIC UNIT PLAN (authoritative contract — ACs and UATs) ---',
    staticPlan,
  ];

  const instruction = hasFeedback ? [
    '',
    '--- INSTRUCTION ---',
    'Address every review finding above before adding unrelated work. If a mechanical failure is also shown, address it alongside the review findings — both must be green before the unit can pass.',
  ] : hasMechanical ? [
    '',
    '--- INSTRUCTION ---',
    'Restore the green mechanical state (fix compile/test failures). The static plan below is the authoritative contract — implement it fully once mechanical is green.',
  ] : [
    '',
    '--- INSTRUCTION ---',
    'First attempt for this unit. Implement the static plan below. No prior feedback to address.',
  ];

  const prompt = [
    ...header,
    ...reviewSection,
    ...mechanicalSection,
    ...staticBlock,
    ...instruction,
  ].join('\n');

  return {
    prompt,
    staticPlanChars: staticPlan.length,
    feedbackChars: feedback.length,
    mechanicalChars: mechanicalBlock.length,
    priority,
  };
}

/**
 * Convenience wrapper: split unit file content into static plan + review
 * feedback, then compose the dispatch prompt with the supplied prior-attempt
 * context. Used by the legacy read-from-unit-file path; new callers should
 * assemble review feedback from units/unit-N.json.reviewFeedback and call
 * {@link composeBuildDispatchPrompt} directly.
 */
export function composeBuildDispatchPromptFromUnitFile(
  unitContent: string,
  unitPath: string,
  previousAttempt: LatestAttemptState | null,
): ComposeBuildDispatchPromptResult {
  const { staticPlan, reviewFeedback } = splitUnitFile(unitContent);
  return composeBuildDispatchPrompt(staticPlan, reviewFeedback, previousAttempt, unitPath);
}
