#!/usr/bin/env bun
/**
 * Build Loop Runner — single-unit build executor for the Ralph pipeline.
 *
 * Handles one unit per invocation: dispatches the build executor via
 * stage-runner.ts, runs backpressure, retries internally up to the attempt
 * budget, and writes unit status. The Ralph orchestrator (LLM) calls this
 * once per unit via Bash and drives unit-to-unit progression via task management.
 *
 * Invariant: single-writer per pipeline. Ralph invokes one build-loop-runner at a time.
 *
 * Usage:
 *   bun build-loop-runner.ts --plan <path> --cwd <dir> --unit <id>
 *
 * Exit codes:
 *   0 - unit_done or unit_failed (structured outcome)
 *   1 - unit_error or validation error
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runBackpressure } from './ralph-state-machine.ts';
import { parseUnitPlan } from './ralph/parsers.ts';
import { loadDevBuddyConfig } from './pipeline-config.ts';
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';
import type { StageType } from '../types/stage-definitions.ts';
import type {
  BackpressureResult, UnitBuildDispatchResult, SingleUnitResult, UnitReviewResult,
  LatestAttemptState, MechanicalContext,
} from './ralph/types.ts';
import {
  RUNNER_TAIL_MARKER,
  writeRunnerTail,
  writeUnitStatus,
  splitUnitFile,
  extractBackpressureCommands,
  upsertMetadataLine,
  replaceOrAppendSection,
  demoteFeedbackHeadings,
  listDoneWhenCandidates,
} from './ralph/unit-file.ts';
import type { RunnerTailPath, RunnerTailResult } from './ralph/unit-file.ts';

// Re-export unit-file helpers so existing callers (tests, scripts) that import
// from build-loop-runner.ts keep working without path changes.
export {
  RUNNER_TAIL_MARKER,
  writeRunnerTail,
  writeUnitStatus,
  splitUnitFile,
  extractBackpressureCommands,
  upsertMetadataLine,
  replaceOrAppendSection,
  demoteFeedbackHeadings,
  listDoneWhenCandidates,
};
export type { RunnerTailPath, RunnerTailResult };

/** Maximum head/tail excerpt size per channel in a {@link MechanicalContext}. */
export const MECHANICAL_CONTEXT_EXCERPT_MAX = 1000;

/**
 * Build a {@link MechanicalContext} from raw stdout/stderr + exit code.
 * Head and tail are captured separately so both preamble (usually
 * tool-version banners) and the tail (usually the failure summary) survive
 * truncation. Excerpts are kept verbatim — if a build tool echoes secrets
 * they land in the next attempt's dispatch prompt.
 */
export function buildMechanicalContext(
  source: 'dispatch' | 'backpressure',
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): MechanicalContext {
  const MAX = MECHANICAL_CONTEXT_EXCERPT_MAX;
  const stdoutHead = stdout.length <= MAX ? stdout : stdout.slice(0, MAX);
  const stdoutTail = stdout.length <= MAX ? '' : stdout.slice(-MAX);
  const stderrHead = stderr.length <= MAX ? stderr : stderr.slice(0, MAX);
  const stderrTail = stderr.length <= MAX ? '' : stderr.slice(-MAX);
  return {
    source,
    command,
    exitCode,
    stdoutHead,
    stdoutTail,
    stderrHead,
    stderrTail,
  };
}

// ─── CLI ARG PARSING ────────────────────────────────────────────────────────

export function parseBuildLoopArgs(argv: string[]): { planPath: string; cwd: string; unitId: number } {
  const planIdx = argv.indexOf('--plan');
  if (planIdx === -1 || planIdx + 1 >= argv.length) {
    throw new Error('Missing required flag: --plan <plan-file-path>');
  }
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx === -1 || cwdIdx + 1 >= argv.length) {
    throw new Error('Missing required flag: --cwd <project-dir>');
  }
  const unitIdx = argv.indexOf('--unit');
  if (unitIdx === -1 || unitIdx + 1 >= argv.length) {
    throw new Error('Missing required flag: --unit <unit-id>');
  }
  const unitId = parseInt(argv[unitIdx + 1], 10);
  if (isNaN(unitId) || unitId < 1) {
    throw new Error(`Invalid --unit value: ${argv[unitIdx + 1]}. Must be a positive integer.`);
  }
  return { planPath: argv[planIdx + 1], cwd: argv[cwdIdx + 1], unitId };
}

/**
 * Emit observability events for a single `writeUnitStatus` call. Always emits
 * `runner_tail.write`; conditionally emits `review.feedback_preserved` when
 * the caller passed `reviewFeedback: undefined`, and `runner_tail.anchor_candidates`
 * in debug mode when the legacy Done-When fallback was used. Fire-and-forget.
 */
function logRunnerTailWrite(
  cwd: string,
  unitId: number,
  result: RunnerTailResult & { preWriteContent: string },
  debug: boolean,
): void {
  vcpLog(cwd, {
    source: 'build-loop-runner',
    event: 'runner_tail.write',
    decision: 'info',
    details:
      `unitId=${unitId} path=${result.path} ` +
      `bytesBefore=${result.bytesBefore} bytesAfter=${result.bytesAfter} ` +
      `hadExistingFeedback=${result.hadExistingFeedback} ` +
      `feedbackChars=${result.feedbackChars}`,
  }, debug).catch(() => {});

  if (result.preservedFeedback && result.preservedFeedbackReason) {
    vcpLog(cwd, {
      source: 'build-loop-runner',
      event: 'review.feedback_preserved',
      decision: 'info',
      details: `unitId=${unitId} reason=${result.preservedFeedbackReason}`,
    }, debug).catch(() => {});
  }

  if (debug && result.path === 'legacy_done_when') {
    const candidates = listDoneWhenCandidates(result.preWriteContent);
    vcpLog(cwd, {
      source: 'build-loop-runner',
      event: 'runner_tail.anchor_candidates',
      decision: 'info',
      details:
        `unitId=${unitId} candidates=${candidates.length} ` +
        `positions=[${candidates.join(',')}] ` +
        `chosen=${candidates[candidates.length - 1] ?? -1}`,
    }, debug).catch(() => {});
  }
}

// ─── UNIT PATH RESOLUTION ──────────────────────────────────────────────────

/**
 * Resolve the unit plan file path from the plan path and unit ID.
 * Plan path format: <projectDir>/.vcp/plan/ralph-<slug>.md
 * Unit path format: <projectDir>/.vcp/plan/ralph/<slug>/unit-<id>.md
 */
export function resolveUnitPath(planPath: string, unitId: number): { unitPath: string; slug: string } {
  const planBasename = path.basename(planPath);
  const slugMatch = planBasename.match(/^ralph-(.+)\.md$/);
  if (!slugMatch) {
    throw new Error(`Cannot extract slug from plan filename: ${planBasename}`);
  }
  const slug = slugMatch[1];
  const planDir = path.dirname(planPath);
  const unitPath = path.join(planDir, 'ralph', slug, `unit-${unitId}.md`);
  return { unitPath, slug };
}

// ─── STAGE-RUNNER SUBPROCESS ─────────────────────────────────────────────────

/** Raw result from spawning stage-runner.ts. */
interface StageRunnerResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Spawn stage-runner.ts as subprocess and return raw output.
 * Shared by build dispatch and review dispatch.
 */
function spawnStageRunner(
  stageType: string,
  task: string,
  planPath: string,
  cwd: string,
  debugEnabled: boolean,
): Promise<StageRunnerResult> {
  const stageRunnerPath = path.join(path.dirname(import.meta.path), 'stage-runner.ts');
  return new Promise<StageRunnerResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const proc = spawn('bun', [
      stageRunnerPath,
      '--stage-type', stageType,
      '--plan', planPath,
      '--cwd', cwd,
      '--task-stdin',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.stdin!.write(task);
    proc.stdin!.end();

    proc.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, code: null });
    });

    proc.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (stderr.trim()) {
        vcpLog(cwd, {
          source: 'build-loop-runner', event: `${stageType}_stderr`, decision: 'info',
          details: `stderr=${stderr.slice(0, 100_000)}`,
        }, debugEnabled).catch(() => {});
      }
      resolve({ stdout, stderr, code });
    });
  });
}

// ─── BUILD DISPATCH ─────────────────────────────────────────────────────────

/**
 * Format a {@link MechanicalContext} into a prompt-ready text block. Empty
 * channels are skipped. Head and tail are labelled so the executor can tell
 * which came from where.
 */
function renderMechanicalBlock(ctx: MechanicalContext): string {
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

/** Which prior-context block (if any) occupies the priority slot. */
export type DispatchPriority = 'mechanical_first' | 'review_first' | 'none';

export interface ComposeBuildDispatchPromptResult {
  prompt: string;
  staticPlanChars: number;
  feedbackChars: number;
  mechanicalChars: number;
  priority: DispatchPriority;
}

/**
 * Compose the build-stage executor prompt from a static unit plan and the
 * prior-attempt context. Layout depends on what the previous attempt left
 * behind:
 *
 *   1. **Mechanical-first** (highest priority): previous attempt ended in
 *      `outcome === 'retry'` with a `mechanicalContext`. The executor must
 *      restore a green mechanical state (compile/test passing) before
 *      pursuing deeper semantic changes.
 *   2. **Review-first**: no mechanical failure, but `reviewFeedback` is
 *      non-empty. The executor must address every finding.
 *   3. **None**: pristine unit or prior attempt was clean — only the static
 *      plan is shown.
 *
 * `previousAttempt` flows in-memory between iterations of the runSingleUnit
 * retry loop — there is no sidecar persistence. Cross-process restarts lose
 * the mechanical excerpt; the review-feedback body still survives via the
 * unit markdown.
 */
export function composeBuildDispatchPrompt(
  staticPlan: string,
  reviewFeedback: string,
  previousAttempt: LatestAttemptState | null,
  unitPath: string,
): ComposeBuildDispatchPromptResult {
  const feedback = reviewFeedback ?? '';
  const hasMechanical =
    previousAttempt !== null &&
    previousAttempt.outcome === 'retry' &&
    previousAttempt.mechanicalContext !== null;
  const mechanicalBlock = hasMechanical
    ? renderMechanicalBlock(previousAttempt!.mechanicalContext!)
    : '';

  const priority: DispatchPriority = hasMechanical
    ? 'mechanical_first'
    : feedback.trim().length > 0 ? 'review_first' : 'none';

  const header = [
    'Orchestrated single-unit build.',
    `Unit plan path: ${unitPath}`,
    'Do NOT write **Status:** or decide pass/fail — the outer runner handles that.',
    'Do NOT modify the unit plan file itself.',
  ];

  const staticBlock = ['--- STATIC UNIT PLAN ---', staticPlan];

  const mechanicalSection = hasMechanical ? [
    '',
    '--- PRIOR MECHANICAL FAILURE ---',
    mechanicalBlock,
    '',
    'The previous attempt failed a compile/test check. Restore the green mechanical state first (fix compile/test errors). Preserve any unresolved review intent, but do NOT pursue deeper semantic changes until the unit builds and tests pass.',
  ] : [];

  const reviewBlock = priority === 'review_first' ? [
    '',
    '--- PRIOR REVIEW FEEDBACK (ADDRESS EVERY FINDING) ---',
    feedback,
  ] : priority === 'mechanical_first' && feedback.trim().length > 0 ? [
    '',
    '--- PRIOR REVIEW FEEDBACK (ADDRESS AFTER MECHANICAL IS GREEN) ---',
    feedback,
  ] : priority === 'none' ? [
    '',
    '--- PRIOR REVIEW FEEDBACK (ADDRESS EVERY FINDING) ---',
    '(none — first attempt for this unit)',
  ] : [];

  const instruction = priority === 'mechanical_first' ? [
    '',
    '--- INSTRUCTION ---',
    'If review feedback and mechanical state conflict, restore mechanical first. Address every review finding once the unit compiles and tests pass. New work that does neither will fail review again.',
  ] : [
    '',
    '--- INSTRUCTION ---',
    'If prior review feedback exists above, address each finding one-by-one before adding any new code. New work that does not address the listed findings will fail review again.',
  ];

  const prompt = [
    ...header,
    '',
    ...staticBlock,
    ...mechanicalSection,
    ...reviewBlock,
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
 * context. Used by {@link dispatchBuildUnitDefault}; tests prefer the pure
 * {@link composeBuildDispatchPrompt} for predictability.
 */
export function composeBuildDispatchPromptFromUnitFile(
  unitContent: string,
  unitPath: string,
  previousAttempt: LatestAttemptState | null,
): ComposeBuildDispatchPromptResult {
  const { staticPlan, reviewFeedback } = splitUnitFile(unitContent);
  return composeBuildDispatchPrompt(staticPlan, reviewFeedback, previousAttempt, unitPath);
}

async function dispatchBuildUnitDefault(
  planPath: string,
  cwd: string,
  unitPath: string,
  debugEnabled: boolean,
  previousAttempt: LatestAttemptState | null,
): Promise<UnitBuildDispatchResult> {
  const unitContent = fs.readFileSync(unitPath, 'utf-8');
  const composed = composeBuildDispatchPromptFromUnitFile(unitContent, unitPath, previousAttempt);
  const task = composed.prompt;
  vcpLog(cwd, {
    source: 'build-loop-runner', event: 'build_dispatch.composed', decision: 'info',
    details:
      `staticPlan=${composed.staticPlanChars} feedback=${composed.feedbackChars} ` +
      `mechanical=${composed.mechanicalChars} priority=${composed.priority}`,
  }, debugEnabled).catch(() => {});

  const { stdout, stderr, code } = await spawnStageRunner('ralph-build', task, planPath, cwd, debugEnabled);

  // Only build mechanical context on genuine mechanical failures (non-zero
  // exit, unparseable stdout, or a stage-level error event). A successful
  // `event: 'complete'` path attaches `mechanicalContext: null`.
  const buildDispatchMechanical = (): MechanicalContext =>
    buildMechanicalContext('dispatch', 'stage-runner ralph-build', code ?? -1, stdout, stderr);

  if (!stdout) {
    return {
      event: 'error', stage: 'ralph-build', phase: 'dispatch_failed',
      error: `Failed to start stage-runner: ${stderr}`,
      mechanicalContext: buildDispatchMechanical(),
    };
  }

  try {
    const parsed = JSON.parse(stdout);
    if (parsed.event === 'complete') {
      return {
        event: 'complete', stage: 'ralph-build',
        synthesis: parsed.synthesis ?? null,
        workerOutputs: parsed.worker_outputs ?? [],
        mechanicalContext: null,
      };
    }
    return {
      event: 'error', stage: 'ralph-build',
      phase: parsed.phase ?? 'dispatch',
      error: parsed.error ?? 'stage-runner returned non-complete event',
      mechanicalContext: buildDispatchMechanical(),
    };
  } catch {
    const stderrExcerpt = stderr.trim() ? ` stderr=${stderr.slice(0, 500)}` : '';
    return {
      event: 'error', stage: 'ralph-build', phase: 'dispatch_failed',
      error: `stage-runner exited ${code}, stdout not parseable: ${stdout.slice(0, 500)}${stderrExcerpt}`,
      mechanicalContext: buildDispatchMechanical(),
    };
  }
}

// ─── PER-UNIT SEMANTIC REVIEW ──────────────────────────────────────────────

/** Maximum bytes of raw output retained when feedback is unparseable. */
export const UNPARSEABLE_RAW_OUTPUT_CAP = 5000;

/**
 * Parse a review verdict from synthesized review output. **Fail-closed.**
 *
 * - Verdict `PASS` → `{ passed: true, feedback: '' }`
 * - Verdict `NEEDS_CHANGES` → `{ passed: false, feedback: <captured + demoted> }`
 *   - Feedback body is the text after `## Review Feedback` heading line to EOF.
 *   - If no `## Review Feedback` heading, falls back to everything after the verdict line.
 *   - Captured body is run through {@link demoteFeedbackHeadings} so any H1/H2
 *     inside cannot break out of the runner-tail region when written.
 * - Missing or unrecognized verdict → `{ passed: false, feedback: '<error + truncated raw output>' }`.
 *   Malformed review output blocks the unit from advancing instead of silently passing.
 */
export function parseReviewVerdict(output: string): { passed: boolean; feedback: string } {
  const verdictMatch = output.match(/^##\s+Verdict:\s*(PASS|NEEDS_CHANGES)\s*$/im);
  if (!verdictMatch) {
    const truncated = output.length > UNPARSEABLE_RAW_OUTPUT_CAP
      ? output.slice(0, UNPARSEABLE_RAW_OUTPUT_CAP) + '\n\n…[truncated]'
      : output;
    return {
      passed: false,
      feedback: `Review output unparseable — no recognized verdict header. Raw output:\n\n${truncated}`,
    };
  }
  if (verdictMatch[1].toUpperCase() === 'PASS') {
    return { passed: true, feedback: '' };
  }

  // NEEDS_CHANGES — capture feedback body
  let feedback: string;
  const fbHeadingMatch = output.match(/^##\s+Review Feedback\s*$/m);
  if (fbHeadingMatch && fbHeadingMatch.index !== undefined) {
    feedback = output.slice(fbHeadingMatch.index + fbHeadingMatch[0].length).trim();
  } else {
    feedback = output.slice(verdictMatch.index! + verdictMatch[0].length).trim();
  }
  feedback = demoteFeedbackHeadings(feedback);
  return { passed: false, feedback };
}

/**
 * Read the contents of files listed in a unit plan's "Files to Touch" section.
 * Returns formatted file contents for the reviewer.
 */
export function readFilesTouched(unitContent: string, cwd: string): string {
  const section = unitContent.match(/^#{2,3}\s+Files to Touch\s*$([\s\S]*?)(?=^#{2,3}\s|$(?!\n))/im);
  if (!section) return '';

  const filePaths = [...section[1].matchAll(/[-*]\s+`([^`]+)`/g)].map(m => m[1].trim());
  if (filePaths.length === 0) return '';

  const parts: string[] = [];
  for (const fp of filePaths) {
    const fullPath = path.join(cwd, fp);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      parts.push(`### File: ${fp}\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      parts.push(`### File: ${fp} \u2014 NOT FOUND`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Dispatch per-unit semantic review via stage-runner subprocess. **Fail-closed.**
 *
 * Returns `passed: false` (with a diagnostic feedback message) when any of:
 *   - The stage-runner subprocess fails to start or returns empty stdout
 *   - The stdout is not parseable JSON
 *   - The parsed event is not `complete`
 *   - The synthesis is missing or its verdict is unrecognized (handled in `parseReviewVerdict`)
 *   - An unexpected exception bubbles up
 *
 * The configured-reviewer skip path lives outside this function — when no
 * reviewers are configured for the `unit-review` stage, the caller installs
 * a noop `reviewFn` that returns `{ skipped: true, passed: true, feedback: '' }`.
 */
async function dispatchUnitReviewDefault(
  planPath: string,
  cwd: string,
  unitPath: string,
  debugEnabled: boolean,
): Promise<UnitReviewResult> {
  try {
    const unitContent = fs.readFileSync(unitPath, 'utf-8');
    const fileContents = readFilesTouched(unitContent, cwd);

    const task = [
      'Review this unit implementation against its acceptance criteria.',
      '',
      '## Unit Plan',
      unitContent,
      '',
      '## Implemented Files',
      fileContents || '(no files found)',
      '',
      'Produce a verdict: ## Verdict: PASS or ## Verdict: NEEDS_CHANGES',
    ].join('\n');

    const { stdout, stderr } = await spawnStageRunner('unit-review', task, planPath, cwd, debugEnabled);

    if (!stdout) {
      const stderrExcerpt = stderr.trim() ? ` stderr=${stderr.slice(0, 500)}` : '';
      vcpLog(cwd, {
        source: 'build-loop-runner', event: 'unit_review_empty_stdout', decision: 'warn',
        details: `stage-runner returned no stdout.${stderrExcerpt}`,
      }, debugEnabled).catch(() => {});
      return {
        skipped: false,
        passed: false,
        feedback: `Review executor returned empty output. The unit cannot advance until the reviewer produces a verdict.${stderrExcerpt}`,
      };
    }

    let parsed: { event?: string; synthesis?: string; error?: string };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      vcpLog(cwd, {
        source: 'build-loop-runner', event: 'unit_review_parse_error', decision: 'warn',
        details: `stdout not parseable JSON: ${stdout.slice(0, 500)}`,
      }, debugEnabled).catch(() => {});
      return {
        skipped: false,
        passed: false,
        feedback: `Review executor stdout was not valid JSON. Raw output:\n\n${stdout.slice(0, UNPARSEABLE_RAW_OUTPUT_CAP)}`,
      };
    }

    if (parsed.event !== 'complete' || !parsed.synthesis) {
      vcpLog(cwd, {
        source: 'build-loop-runner', event: 'unit_review_non_complete', decision: 'warn',
        details: `event=${parsed.event} synthesis=${parsed.synthesis ? 'present' : 'missing'}`,
      }, debugEnabled).catch(() => {});
      const detail = parsed.error ? `: ${parsed.error}` : '';
      return {
        skipped: false,
        passed: false,
        feedback: `Review executor errored (event=${parsed.event ?? 'unknown'})${detail}. The unit cannot advance until a verdict is produced.`,
      };
    }

    const verdict = parseReviewVerdict(parsed.synthesis);
    vcpLog(cwd, {
      source: 'build-loop-runner', event: 'review.parse_result', decision: verdict.passed ? 'allow' : 'warn',
      details: `passed=${verdict.passed} feedbackChars=${verdict.feedback.length}`,
    }, debugEnabled).catch(() => {});
    return { skipped: false, ...verdict };
  } catch (err) {
    const msg = (err as Error).message;
    vcpLog(cwd, {
      source: 'build-loop-runner', event: 'unit_review_error', decision: 'warn',
      details: `Review dispatch threw: ${msg}`,
    }, debugEnabled).catch(() => {});
    return {
      skipped: false,
      passed: false,
      feedback: `Review dispatch threw: ${msg}. The unit cannot advance until the reviewer succeeds.`,
    };
  }
}

/** Check if unit-review stage is enabled (has executors) in the given config. */
function isUnitReviewEnabled(config: { stages: Record<string, { executors: unknown[] }> }): boolean {
  const stage = config.stages['unit-review' as StageType];
  return !!stage && stage.executors.length > 0;
}

// ─── RESULT BUILDERS ────────────────────────────────────────────────────────

/**
 * Compose a {@link LatestAttemptState} snapshot used as the in-memory carry
 * from one retry iteration to the next. Priority for `mechanicalContext`:
 *   1. `dispatch.mechanicalContext` when present (dispatch-level failure).
 *   2. Otherwise, the first failing backpressure command's stdout/stderr.
 *   3. Otherwise, null (clean attempt or review-only failure).
 */
export function buildLatestAttemptState(
  dispatch: UnitBuildDispatchResult,
  backpressure: BackpressureResult[],
  outcome: 'done' | 'retry' | 'failed',
  attempt: number,
): LatestAttemptState {
  let mechanicalContext: MechanicalContext | null = null;
  if (dispatch.mechanicalContext) {
    mechanicalContext = dispatch.mechanicalContext;
  } else {
    const firstFailure = backpressure.find(bp => !bp.passed);
    if (firstFailure) {
      mechanicalContext = buildMechanicalContext(
        'backpressure',
        firstFailure.command,
        firstFailure.exitCode,
        firstFailure.stdout,
        firstFailure.stderr,
      );
    }
  }

  return {
    attempt,
    dispatchEvent: dispatch.event ?? null,
    dispatchError: dispatch.error ?? null,
    backpressure: backpressure.map(bp => ({ name: bp.command, exitCode: bp.exitCode })),
    outcome,
    mechanicalContext,
  };
}

function renderAttemptSummary(
  dispatch: UnitBuildDispatchResult,
  backpressure: BackpressureResult[],
  outcome: 'done' | 'retry' | 'failed',
  attempt: number,
  maxAttempts: number,
): string {
  const lines: string[] = [];
  lines.push(`**Attempt:** ${attempt}/${maxAttempts}`);
  lines.push(`**Dispatch:** ${dispatch.event}`);
  if (dispatch.error) lines.push(`**Dispatch Error:** ${dispatch.error}`);
  if (backpressure.length > 0) {
    lines.push('**Backpressure:**');
    for (const bp of backpressure) {
      lines.push(`- \`${bp.command}\`: ${bp.passed ? 'PASS' : `FAIL (exit ${bp.exitCode})`}`);
    }
  }
  lines.push(`**Outcome:** ${outcome}`);
  return lines.join('\n');
}

// ─── SINGLE UNIT BUILD ─────────────────────────────────────────────────────

export interface BuildLoopOverrides {
  dispatchFn?: (planPath: string, cwd: string, unitPath: string, debug: boolean, previousAttempt: LatestAttemptState | null) => Promise<UnitBuildDispatchResult>;
  backpressureFn?: typeof runBackpressure;
  reviewFn?: (planPath: string, cwd: string, unitPath: string, debug: boolean) => Promise<UnitReviewResult>;
}

export async function runSingleUnit(
  args: { planPath: string; cwd: string; unitId: number },
  overrides?: BuildLoopOverrides,
): Promise<SingleUnitResult> {
  const debug = await isDebugEnabled();
  const dispatchFn = overrides?.dispatchFn ?? dispatchBuildUnitDefault;
  const backpressureFn = overrides?.backpressureFn ?? runBackpressure;

  // Load config once — used for attempt budget and review-enabled check
  let devBuddyConfig: ReturnType<typeof loadDevBuddyConfig>;
  try {
    devBuddyConfig = loadDevBuddyConfig();
  } catch {
    devBuddyConfig = { max_build_attempts: 3, stages: {} } as ReturnType<typeof loadDevBuddyConfig>;
  }
  const reviewEnabled = isUnitReviewEnabled(devBuddyConfig);
  const reviewFn = overrides?.reviewFn ?? (reviewEnabled
    ? dispatchUnitReviewDefault
    : async () => ({ skipped: true, passed: true, feedback: '' } as UnitReviewResult));

  // Resolve unit path
  let unitPath: string;
  try {
    ({ unitPath } = resolveUnitPath(args.planPath, args.unitId));
  } catch (err) {
    return {
      event: 'unit_error', unitId: args.unitId, unitPath: '',
      attempt: 0, maxAttempts: 0, outcome: 'failed',
      summary: `Path resolution error: ${(err as Error).message}`,
      error: (err as Error).message,
    };
  }

  // Read unit file — handles both "not found" and other read errors
  let unitContent: string;
  try {
    unitContent = fs.readFileSync(unitPath, 'utf-8');
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? `Unit file not found: ${unitPath}`
      : `Failed to read unit file: ${(err as Error).message}`;
    return {
      event: 'unit_error', unitId: args.unitId, unitPath,
      attempt: 0, maxAttempts: 0, outcome: 'failed',
      summary: msg, error: msg,
    };
  }

  const unit = parseUnitPlan(unitContent, args.unitId);

  // Eligibility guard — reject already-done or already-failed units
  if (unit.status === 'done') {
    return {
      event: 'unit_error', unitId: args.unitId, unitPath,
      attempt: unit.attempts, maxAttempts: unit.maxAttempts, outcome: 'done',
      summary: `Unit ${args.unitId} is already done.`,
      error: 'Unit already done',
    };
  }
  if (unit.status === 'failed') {
    return {
      event: 'unit_error', unitId: args.unitId, unitPath,
      attempt: unit.attempts, maxAttempts: unit.maxAttempts, outcome: 'failed',
      summary: `Unit ${args.unitId} is already failed.`,
      error: 'Unit already failed',
    };
  }

  const maxAttempts = Math.min(unit.maxAttempts, devBuddyConfig.max_build_attempts);

  // Guard: attempt budget already exhausted
  if (unit.attempts >= maxAttempts) {
    const r = writeUnitStatus(unitPath, {
      status: 'failed',
      attempts: unit.attempts,
      appendResult: `Attempt budget exhausted (${unit.attempts}/${maxAttempts}).`,
    });
    logRunnerTailWrite(args.cwd, args.unitId, r, debug);
    return {
      event: 'unit_failed', unitId: args.unitId, unitPath,
      attempt: unit.attempts, maxAttempts, outcome: 'failed',
      summary: `Unit ${args.unitId} exhausted attempt budget (${unit.attempts}/${maxAttempts}).`,
    };
  }

  let lastAttempt = unit.attempts;
  // In-memory carry: last attempt's mechanical result flows into the next
  // dispatch prompt so retry attempts see the stdout/stderr excerpts from the
  // prior failure. Reset to null on the first iteration; cross-process
  // restarts of build-loop-runner start from null again (the unit markdown
  // still carries the review-feedback body).
  let previousAttempt: LatestAttemptState | null = null;

  while (lastAttempt < maxAttempts) {
    const nextAttempt = lastAttempt + 1;

    // Crash-safe: consume attempt before dispatch
    const rStart = writeUnitStatus(unitPath, {
      status: 'pending',
      attempts: nextAttempt,
      appendResult: `Attempt ${nextAttempt}/${maxAttempts} started.`,
    });
    logRunnerTailWrite(args.cwd, args.unitId, rStart, debug);

    // Dispatch build executor — previousAttempt drives mechanical-first
    // priority in the composed prompt.
    const dispatch = await dispatchFn(args.planPath, args.cwd, unitPath, debug, previousAttempt);

    // Re-read unit file (executor may have modified project files)
    const refreshedContent = fs.readFileSync(unitPath, 'utf-8');
    const commands = extractBackpressureCommands(refreshedContent);

    // Zero backpressure commands = hard failure
    if (commands.length === 0) {
      const isExhausted = nextAttempt >= maxAttempts;
      const outcome = isExhausted ? 'failed' : 'retry';
      const rNoBp = writeUnitStatus(unitPath, {
        status: isExhausted ? 'failed' : 'pending',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, [], outcome, nextAttempt, maxAttempts) +
          '\n\n**Note:** No backpressure commands found in unit file.',
      });
      logRunnerTailWrite(args.cwd, args.unitId, rNoBp, debug);
      if (isExhausted) {
        return {
          event: 'unit_failed', unitId: args.unitId, unitPath,
          attempt: nextAttempt, maxAttempts, outcome: 'failed',
          summary: `Unit ${args.unitId} failed: no backpressure commands (attempt ${nextAttempt}/${maxAttempts}).`,
        };
      }
      previousAttempt = buildLatestAttemptState(dispatch, [], outcome, nextAttempt);
      lastAttempt = nextAttempt;
      continue;
    }

    // Run backpressure (only if dispatch succeeded)
    const backpressure = dispatch.event === 'complete'
      ? backpressureFn(commands, args.cwd)
      : [];

    const passed = dispatch.event === 'complete' &&
      backpressure.length > 0 &&
      backpressure.every(r => r.passed);

    if (passed) {
      // Per-unit semantic review (if configured). Fail-closed: catastrophic
      // exceptions in the reviewer block the unit instead of silently passing.
      let review: UnitReviewResult;
      try {
        review = await reviewFn(args.planPath, args.cwd, unitPath, debug);
      } catch (err) {
        review = {
          skipped: false,
          passed: false,
          feedback: `Review function threw: ${(err as Error).message}. Cannot advance.`,
        };
      }

      if (review.skipped || review.passed) {
        // Success path — clear any stale feedback from prior failed attempts.
        const rDone = writeUnitStatus(unitPath, {
          status: 'done',
          attempts: nextAttempt,
          appendResult: renderAttemptSummary(dispatch, backpressure, 'done', nextAttempt, maxAttempts),
          reviewFeedback: '',
        });
        logRunnerTailWrite(args.cwd, args.unitId, rDone, debug);
        return {
          event: 'unit_done', unitId: args.unitId, unitPath,
          attempt: nextAttempt, maxAttempts, outcome: 'done',
          summary: `Unit ${args.unitId} done on attempt ${nextAttempt}/${maxAttempts}.`,
        };
      }

      // Review failed — store feedback under ## Review Feedback only.
      // Note: feedback is NOT duplicated into Latest Build Attempt anymore;
      // the latter carries only mechanical results.
      const isExhausted = nextAttempt >= maxAttempts;
      const reviewOutcome = isExhausted ? 'failed' : 'retry';
      const rReviewFail = writeUnitStatus(unitPath, {
        status: isExhausted ? 'failed' : 'pending',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure,
          reviewOutcome, nextAttempt, maxAttempts) +
          '\n\n**Review Verdict:** NEEDS_CHANGES (see ## Review Feedback)',
        reviewFeedback: review.feedback,
      });
      logRunnerTailWrite(args.cwd, args.unitId, rReviewFail, debug);

      if (isExhausted) {
        return {
          event: 'unit_failed', unitId: args.unitId, unitPath,
          attempt: nextAttempt, maxAttempts, outcome: 'failed',
          summary: `Unit ${args.unitId} failed review after ${nextAttempt}/${maxAttempts} attempts.`,
        };
      }
      // Review-only failure: no mechanical context to forward. Reset
      // previousAttempt so the next dispatch routes via review_first, not
      // mechanical_first.
      previousAttempt = buildLatestAttemptState(dispatch, backpressure, reviewOutcome, nextAttempt);
      lastAttempt = nextAttempt;
      continue;
    }

    // Failed — check if exhausted
    if (nextAttempt >= maxAttempts) {
      const rFail = writeUnitStatus(unitPath, {
        status: 'failed',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure, 'failed', nextAttempt, maxAttempts),
      });
      logRunnerTailWrite(args.cwd, args.unitId, rFail, debug);
      return {
        event: 'unit_failed', unitId: args.unitId, unitPath,
        attempt: nextAttempt, maxAttempts, outcome: 'failed',
        summary: `Unit ${args.unitId} failed after ${nextAttempt}/${maxAttempts} attempts.`,
      };
    }

    // Retry — write pending and continue loop
    const rRetry = writeUnitStatus(unitPath, {
      status: 'pending',
      attempts: nextAttempt,
      appendResult: renderAttemptSummary(dispatch, backpressure, 'retry', nextAttempt, maxAttempts),
    });
    logRunnerTailWrite(args.cwd, args.unitId, rRetry, debug);
    previousAttempt = buildLatestAttemptState(dispatch, backpressure, 'retry', nextAttempt);
    lastAttempt = nextAttempt;
  }

  return {
    event: 'unit_failed', unitId: args.unitId, unitPath,
    attempt: lastAttempt, maxAttempts, outcome: 'failed',
    summary: `Unit ${args.unitId} exhausted all attempts.`,
  };
}

// ─── CLI ENTRY POINT ────────────────────────────────────────────────────────

if (import.meta.main) {
  (async () => {
    const SRC = 'build-loop-runner';
    let cwd = '.';
    const debug = await isDebugEnabled();

    try {
      const args = parseBuildLoopArgs(process.argv);
      cwd = args.cwd;

      await vcpLog(cwd, {
        source: SRC, event: 'start', decision: 'info',
        details: `plan=${path.basename(args.planPath)} unit=${args.unitId} cwd=${cwd}`,
      }, debug);

      const result = await runSingleUnit(args);

      await vcpLog(cwd, {
        source: SRC, event: 'complete', decision: 'info',
        details: `event=${result.event} unit=${result.unitId} attempt=${result.attempt}/${result.maxAttempts}`,
      }, debug);

      console.log(JSON.stringify(result, null, 2));

      if (result.event === 'unit_error') process.exit(1);
    } catch (err) {
      const msg = (err as Error).message;
      console.log(JSON.stringify({
        event: 'unit_error',
        unitId: 0,
        unitPath: '',
        attempt: 0,
        maxAttempts: 0,
        outcome: 'failed',
        summary: msg,
        error: msg,
      }));
      await vcpLog(cwd, { source: SRC, event: 'fatal', decision: 'error', details: msg }, debug);
      process.exit(1);
    }
  })();
}
