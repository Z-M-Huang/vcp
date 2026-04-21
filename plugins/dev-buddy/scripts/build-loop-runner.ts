#!/usr/bin/env bun
/**
 * Build Loop Runner — per-unit driver for the Ralph pipeline.
 *
 * Drives one unit's full build + optional review loop by calling the three
 * action functions in ralph/build-actions.ts:
 *   composeBuildDispatch      → seed, reserve attempt, compose prompt
 *   recordAttemptResultAction → commit outcome, decide next action
 *   recordReviewResultAction  → commit review, decide next action
 *
 * BLR owns dispatch I/O, backpressure execution, contract-verify, review
 * dispatch, and event streaming. ALL state mutation, hash guards, stuck
 * detection, and terminal transitions live in build-actions.ts — the same
 * path the SM CLI uses. BLR never writes to unit-N.json or unit-N.md.
 *
 * Usage:
 *   bun build-loop-runner.ts --plan <path> --cwd <dir> --unit <id>
 *
 * Emits JSON events (one per line) on stdout:
 *   {event:"attempt_start", attempt, unitId}
 *   {event:"review_start", attempt, unitId}
 *   {event:"review_verdict", passed, attempt, unitId}
 *   {event:"complete", status:"done"|"failed"|"stuck", unitId, attempts, reason, orchestratorHints?}
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runBackpressure } from './ralph-state-machine.ts';
import { verifyContract, formatFailureMessage } from './contract-verifier.ts';
import type { ContractVerifyResult } from './contract-verifier.ts';
import { vcpLog, isDebugEnabled, capLogPayload } from './vcp-logger.ts';
import type {
  BackpressureResult, UnitBuildDispatchResult,
  MechanicalContext,
  ComposeBuildDispatchOutput,
} from './ralph/types.ts';
import {
  splitUnitFile,
  extractBackpressureCommands,
  upsertMetadataLine,
  replaceOrAppendSection,
  demoteFeedbackHeadings,
} from './ralph/unit-file.ts';
import {
  composeBuildDispatchPrompt,
  composeBuildDispatchPromptFromUnitFile,
} from './ralph/prompt-assembly.ts';
import type {
  DispatchPriority,
  ComposeBuildDispatchPromptResult,
} from './ralph/prompt-assembly.ts';
import { resolveUnitPath, resolveRalphSlug } from './ralph/paths.ts';
import {
  composeBuildDispatch,
  recordAttemptResultAction,
  recordReviewResultAction,
} from './ralph/build-actions.ts';

// Re-export unit-file helpers still used by external callers importing from BLR.
export { splitUnitFile, extractBackpressureCommands, upsertMetadataLine, replaceOrAppendSection };
// Re-export prompt-assembly surface for external callers that previously
// imported these from build-loop-runner.ts.
export { composeBuildDispatchPrompt, composeBuildDispatchPromptFromUnitFile };
export type { DispatchPriority, ComposeBuildDispatchPromptResult };
// resolveUnitPath lives in ralph/paths.ts; re-exported here for the BLR surface.
export { resolveUnitPath };

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
  source: 'dispatch' | 'backpressure' | 'contract-verifier',
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

export function parseBuildLoopArgs(argv: string[]): {
  planPath: string; cwd: string; unitId: number;
} {
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

// ─── STAGE-RUNNER SUBPROCESS ─────────────────────────────────────────────────

/** Raw result from spawning stage-runner.ts. */
interface StageRunnerResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface SpawnStageRunnerArgs {
  stageType: string;
  planPath: string;
  cwd: string;
  debugEnabled: boolean;
  /** Task payload. When defined, piped via stdin + `--task-stdin`. Omit for unit-review (task synthesized by stage-runner from --unit). */
  task?: string;
  /** Forwarded as `--unit <N>`. Required for unit-review (triggers task synthesis there). */
  unitId?: number;
}

/**
 * Spawn stage-runner.ts as subprocess and return raw output. Task is piped on
 * stdin when provided; `--unit N` is forwarded when provided. For unit-review,
 * callers pass `unitId` and omit `task` — stage-runner synthesizes the task
 * internally from unit-N.md + Implementation Files.
 */
function spawnStageRunner(args: SpawnStageRunnerArgs): Promise<StageRunnerResult> {
  const { stageType, planPath, cwd, debugEnabled, task, unitId } = args;
  const stageRunnerPath = path.join(path.dirname(import.meta.path), 'stage-runner.ts');
  return new Promise<StageRunnerResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const runnerArgs = [
      stageRunnerPath,
      '--stage-type', stageType,
      '--plan', planPath,
      '--cwd', cwd,
    ];
    if (unitId !== undefined) {
      runnerArgs.push('--unit', String(unitId));
    }
    if (task !== undefined) {
      runnerArgs.push('--task-stdin');
    }
    const proc = spawn('bun', runnerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    if (task !== undefined) {
      proc.stdin!.write(task);
    }
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

async function dispatchBuildUnitDefault(
  planPath: string,
  cwd: string,
  debugEnabled: boolean,
  promptText: string,
): Promise<UnitBuildDispatchResult> {
  const { stdout, stderr, code } = await spawnStageRunner({
    stageType: 'ralph-build', planPath, cwd, debugEnabled, task: promptText,
  });

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

// ─── REVIEW DISPATCH ────────────────────────────────────────────────────────

/** Output from unit-review dispatch — synthesis text + optional dispatch error. */
export interface UnitReviewDispatchOutput {
  /** Synthesized review output. Empty string when dispatch failed. */
  synthesis: string;
  /** Non-null when stage-runner returned an error event or failed to spawn. */
  error?: string;
}

/**
 * Dispatch the `unit-review` stage. Spawns stage-runner with `--unit N` —
 * stage-runner's unit-review branch composes the review task from unit-N.md +
 * Implementation Files. BLR never composes the review prompt.
 */
async function dispatchUnitReviewDefault(
  planPath: string,
  cwd: string,
  unitId: number,
  debugEnabled: boolean,
): Promise<UnitReviewDispatchOutput> {
  const { stdout, stderr, code } = await spawnStageRunner({
    stageType: 'unit-review', planPath, cwd, debugEnabled, unitId,
  });

  if (!stdout) {
    return { synthesis: '', error: `unit-review dispatch failed: ${stderr || `exit ${code}`}` };
  }

  try {
    const parsed = JSON.parse(stdout);
    if (parsed.event === 'complete') {
      return { synthesis: parsed.synthesis ?? '' };
    }
    return {
      synthesis: '',
      error: parsed.error ?? 'unit-review stage-runner returned non-complete event',
    };
  } catch {
    const stderrExcerpt = stderr.trim() ? ` stderr=${stderr.slice(0, 500)}` : '';
    return {
      synthesis: '',
      error: `unit-review stage-runner exited ${code}, stdout not parseable: ${stdout.slice(0, 500)}${stderrExcerpt}`,
    };
  }
}

// ─── REVIEW VERDICT PARSING ──────────────────────────────────────────────

/** Maximum bytes of raw output retained when feedback is unparseable. */
export const UNPARSEABLE_RAW_OUTPUT_CAP = 5000;

export interface ReviewVerdictParseResult {
  passed: boolean;
  feedback: string;
  parseMode: 'strict' | 'salvaged_pass' | 'unparseable';
  reason?: string;
}

const REVIEW_PASS_HEADING_RE = /^##\s+(?:✅\s*)?Implementation Review\s*$/im;
const REVIEW_PASS_SCAFFOLD_RE = /\b(?:here(?:'s| is) my verification|the implementation covers:|let me verify the code quality against the specification|verifying the code quality against the specification)\b/i;
const REVIEW_PASS_CONCLUSION_RE = /\b(?:the implementation is )?(?:complete and correct|complete and matches(?: [^.:\n]+)?|complete and satisfies(?: [^.:\n]+)?|complete and meets(?: [^.:\n]+)?|matches(?: [^.:\n]+)?(?:requirements|acceptance criteria|specification)|all ACs satisfied)\b/i;
const REVIEW_READY_MARKER_RE = /\b(?:ready for backpressure verification|ready to mark\s+`?\[x\]`?)\b/i;
const REVIEW_FINDING_LINE_RE = /(?:^|\n)(?:[-*]\s+|###\s+).*?\b(?:violated|mismatch|missing|not implemented|incorrect|tautological|required change|must address)\b/im;
const REVIEW_FINDING_WITH_LOCATION_RE = /(?:^|\n).*?\b[\w./-]+\.[A-Za-z0-9]+:\d+\b.*\b(?:violated|mismatch|missing|not implemented|incorrect|tautological|required change|must address)\b/im;
const REVIEW_NEGATIVE_MARKERS = [
  /\bNEEDS_CHANGES\b/i,
  /\b(?:contract mismatch|tautological test|missing implementation|undefined symbol)\b/i,
  REVIEW_FINDING_LINE_RE,
  REVIEW_FINDING_WITH_LOCATION_RE,
] as const;
const REVIEW_NO_FINDINGS_RE = /^\(?no findings\b[\s\S]*\ball ACs satisfied\)?$/i;

function truncateRawReviewOutput(output: string): string {
  return output.length > UNPARSEABLE_RAW_OUTPUT_CAP
    ? output.slice(0, UNPARSEABLE_RAW_OUTPUT_CAP) + '\n\n…[truncated]'
    : output;
}

function buildUnparseableReviewVerdict(output: string, reason: string): ReviewVerdictParseResult {
  return {
    passed: false,
    feedback: `Review output unparseable — ${reason}. Raw output:\n\n${truncateRawReviewOutput(output)}`,
    parseMode: 'unparseable',
    reason,
  };
}

function extractReviewFeedbackBody(output: string, startIndex: number = 0): string | null {
  const searchSpace = output.slice(startIndex);
  const fbHeadingMatch = searchSpace.match(/^##\s+Review Feedback\s*$/m);
  if (!fbHeadingMatch || fbHeadingMatch.index === undefined) {
    return null;
  }
  return searchSpace.slice(fbHeadingMatch.index + fbHeadingMatch[0].length).trim();
}

function isNoFindingsFeedback(body: string): boolean {
  return REVIEW_NO_FINDINGS_RE.test(body.trim());
}

function trySalvagePassVerdict(output: string): ReviewVerdictParseResult | null {
  const feedbackBody = extractReviewFeedbackBody(output);
  if (feedbackBody !== null) {
    if (isNoFindingsFeedback(feedbackBody)) {
      return {
        passed: true,
        feedback: '',
        parseMode: 'salvaged_pass',
        reason: 'review_feedback_no_findings_without_verdict',
      };
    }
    if (feedbackBody.length > 0) {
      return null;
    }
  }

  if (REVIEW_NEGATIVE_MARKERS.some((pattern) => pattern.test(output))) {
    return null;
  }

  const hasPositiveHeading = REVIEW_PASS_HEADING_RE.test(output);
  const hasVerificationScaffold = REVIEW_PASS_SCAFFOLD_RE.test(output);
  const hasPositiveConclusion = REVIEW_PASS_CONCLUSION_RE.test(output);
  const hasReadyMarker = REVIEW_READY_MARKER_RE.test(output);

  if (hasPositiveConclusion && (hasPositiveHeading || hasVerificationScaffold || hasReadyMarker)) {
    return {
      passed: true,
      feedback: '',
      parseMode: 'salvaged_pass',
      reason: 'affirmative_pass_family_without_verdict',
    };
  }

  return null;
}

/**
 * Parse a review verdict from synthesized review output. **Fail-closed.**
 *
 * - Verdict `PASS` → `{ passed: true, feedback: '' }`
 * - Verdict `NEEDS_CHANGES` → `{ passed: false, feedback: <captured + demoted> }`
 * - Missing or unrecognized verdict → `{ passed: false, feedback: '<error + truncated raw output>' }`.
 */
export function parseReviewVerdict(output: string): ReviewVerdictParseResult {
  const verdictMatch = output.match(/^##\s+Verdict:\s*(PASS|NEEDS_CHANGES)\s*$/im);
  if (!verdictMatch) {
    return trySalvagePassVerdict(output)
      ?? buildUnparseableReviewVerdict(output, 'no recognized verdict header');
  }
  if (verdictMatch[1].toUpperCase() === 'PASS') {
    return { passed: true, feedback: '', parseMode: 'strict', reason: 'strict_pass_verdict' };
  }

  let feedback: string;
  const feedbackBody = extractReviewFeedbackBody(output, verdictMatch.index! + verdictMatch[0].length);
  if (feedbackBody !== null) {
    feedback = feedbackBody;
  } else {
    feedback = output.slice(verdictMatch.index! + verdictMatch[0].length).trim();
  }
  feedback = demoteFeedbackHeadings(feedback);
  return {
    passed: false,
    feedback,
    parseMode: 'strict',
    reason: 'strict_needs_changes_verdict',
  };
}

/**
 * Read the contents of files listed in a unit plan's "Files to Touch" section.
 * Returns formatted file contents for the reviewer. Used by stage-runner's
 * unit-review branch to compose the Implementation Files block.
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

// ─── ATTEMPT CLASSIFICATION (pure) ─────────────────────────────────────────

/** Input to {@link classifyAttempt}. */
export interface ClassifyAttemptInput {
  dispatch: UnitBuildDispatchResult;
  backpressure: BackpressureResult[];
  /** Count of backpressure commands extracted from the unit file — distinct from backpressure.length (skipped when dispatch errored). */
  backpressureCommandCount: number;
  /** Contract-verifier result, or null when not run (dispatch/backpressure already failed). */
  contract: ContractVerifyResult | null;
}

/** Output from {@link classifyAttempt}. */
export interface ClassifyAttemptOutput {
  outcome: 'mechanical_pass' | 'mechanical_fail' | 'dispatch_error';
  mechanicalContext: MechanicalContext | null;
}

/**
 * Classify a single build attempt from dispatch + backpressure + contract results.
 * Pure function — no I/O, no state. Extracted for unit-testable policy coverage.
 *
 * Priority: dispatch_error > mechanical_fail (backpressure) > mechanical_fail
 * (contract-verifier) > mechanical_pass. Contract-verifier only runs when
 * dispatch + backpressure are both green; skip/error both treated as pass.
 */
export function classifyAttempt(input: ClassifyAttemptInput): ClassifyAttemptOutput {
  const { dispatch, backpressure, backpressureCommandCount, contract } = input;

  if (dispatch.event !== 'complete') {
    return {
      outcome: 'dispatch_error',
      mechanicalContext: dispatch.mechanicalContext ?? null,
    };
  }

  const backpressureGreen =
    (backpressure.length > 0 && backpressure.every(r => r.passed)) ||
    (backpressure.length === 0 && backpressureCommandCount === 0);

  if (!backpressureGreen) {
    const firstFailure = backpressure.find(bp => !bp.passed);
    return {
      outcome: 'mechanical_fail',
      mechanicalContext: firstFailure
        ? buildMechanicalContext(
            'backpressure', firstFailure.command, firstFailure.exitCode,
            firstFailure.stdout, firstFailure.stderr,
          )
        : null,
    };
  }

  if (contract && contract.event === 'fail') {
    const formatted = formatFailureMessage(contract);
    return {
      outcome: 'mechanical_fail',
      mechanicalContext: buildMechanicalContext(
        'contract-verifier',
        'bun plugins/dev-buddy/scripts/contract-verifier.ts',
        1, '', formatted,
      ),
    };
  }

  return { outcome: 'mechanical_pass', mechanicalContext: null };
}

// ─── TERMINAL OUTCOME + UNIT LOOP ──────────────────────────────────────────

/** Top-level status surfaced to the CC orchestrator. */
export type TerminalStatus = 'done' | 'failed' | 'stuck';

/**
 * Terminal JSON emitted on the final `complete` line. `orchestratorHints` is
 * an advisory pre-formatted hint for Claude Code — the top-level `status` and
 * `reason` are the authoritative, consumer-neutral contract.
 */
export interface TerminalOutcome {
  event: 'complete';
  status: TerminalStatus;
  unitId: number;
  attempts: number;
  reason: string;
  orchestratorHints?: {
    claudeCode: {
      tool: 'TaskUpdate';
      status: 'completed';
      note: string;
    };
  };
}

export interface RunUnitLoopArgs {
  planPath: string;
  cwd: string;
  unitId: number;
  /** Defaults to `cwd`. Separated so tests can point projectDir at a fixture while cwd points at the build dir. */
  projectDir?: string;
}

/** Discriminated union of events BLR emits on stdout during a unit loop. */
export type BuildLoopEvent =
  | { event: 'attempt_start'; unitId: number; attempt: number }
  | { event: 'review_start'; unitId: number; attempt: number }
  | { event: 'review_verdict'; unitId: number; attempt: number; passed: boolean }
  | TerminalOutcome;

export interface RunUnitLoopOverrides {
  dispatchFn?: (planPath: string, cwd: string, debug: boolean, promptText: string) => Promise<UnitBuildDispatchResult>;
  backpressureFn?: typeof runBackpressure;
  verifyContractFn?: (args: { unitFile: string; projectDir: string; unitId?: number }) => ContractVerifyResult;
  reviewDispatchFn?: (planPath: string, cwd: string, unitId: number, debug: boolean) => Promise<UnitReviewDispatchOutput>;
  /** Injected for tests. Defaults to JSON.stringify → console.log. */
  emitFn?: (event: BuildLoopEvent) => void;
}

function defaultEmit(event: BuildLoopEvent): void {
  console.log(JSON.stringify(event));
}

function buildTerminal(
  status: TerminalStatus,
  unitId: number,
  attempts: number,
  reason: string,
): TerminalOutcome {
  const outcome: TerminalOutcome = {
    event: 'complete',
    status, unitId, attempts, reason,
  };
  // Stuck tasks must NOT be marked completed — CC halts for user intervention.
  // done/failed both become `completed` because TaskOperation's vocabulary is
  // only `in_progress | completed`; the failed semantic lives in the note text.
  if (status !== 'stuck') {
    outcome.orchestratorHints = {
      claudeCode: {
        tool: 'TaskUpdate',
        status: 'completed',
        note: status === 'done' ? reason : `failed — ${reason}`,
      },
    };
  }
  return outcome;
}

/**
 * Map an error thrown by {@link composeBuildDispatch} to a terminal outcome.
 * composeBuildDispatch throws for already-terminal units or exhausted budgets;
 * BLR surfaces these as a terminal outcome instead of looping. For already-done
 * units the caller (CC) should not have invoked BLR in the first place, but we
 * report the honest status rather than pretend it failed.
 */
function terminalFromComposeError(err: Error, unitId: number): TerminalOutcome {
  const msg = err.message;
  if (/terminal status 'done'/.test(msg)) {
    return buildTerminal('done', unitId, 0, msg);
  }
  return buildTerminal('failed', unitId, 0, msg);
}

/**
 * Drive one unit's full build + review loop to terminal outcome. Calls the
 * three build-actions.ts functions in-process; BLR never mutates state.
 */
export async function runUnitLoop(
  args: RunUnitLoopArgs,
  overrides?: RunUnitLoopOverrides,
): Promise<TerminalOutcome> {
  const debug = await isDebugEnabled();
  const projectDir = args.projectDir ?? args.cwd;
  const slug = resolveRalphSlug(args.planPath);
  const dispatchFn = overrides?.dispatchFn ?? dispatchBuildUnitDefault;
  const backpressureFn = overrides?.backpressureFn ?? runBackpressure;
  const verifyContractFn = overrides?.verifyContractFn ?? verifyContract;
  const reviewDispatchFn = overrides?.reviewDispatchFn ?? dispatchUnitReviewDefault;
  const emit = overrides?.emitFn ?? defaultEmit;

  while (true) {
    // ─ Phase 1: compose + reserve ──────────────────────────────────────────
    let reservation: ComposeBuildDispatchOutput;
    try {
      reservation = composeBuildDispatch(projectDir, slug, args.unitId);
    } catch (err) {
      const terminal = terminalFromComposeError(err as Error, args.unitId);
      emit(terminal);
      return terminal;
    }

    emit({
      event: 'attempt_start',
      unitId: args.unitId,
      attempt: reservation.attempt,
    });

    // ─ Phase 2: dispatch + backpressure + contract-verify ─────────────────
    const dispatch = await dispatchFn(args.planPath, args.cwd, debug, reservation.prompt);

    // Re-read unit file post-dispatch (executor may have mutated it, though
    // the plan forbids BLR from mutating — the executor sees only the prompt).
    const refreshedContent = fs.readFileSync(reservation.unitPath, 'utf-8');
    const refreshedCommands = extractBackpressureCommands(refreshedContent);

    const backpressure: BackpressureResult[] =
      (dispatch.event === 'complete' && refreshedCommands.length > 0)
        ? backpressureFn(refreshedCommands, args.cwd)
        : [];

    // §11: backpressure.fail — emit per failing command, fsync'd
    for (const bp of backpressure) {
      if (bp.passed) continue;
      const payload =
        `stdout.tail: ${capLogPayload(bp.stdout ?? '', 4 * 1024)}\n` +
        `stderr.tail: ${capLogPayload(bp.stderr ?? '', 4 * 1024)}`;
      vcpLog(args.cwd, {
        source: 'build-loop-runner',
        event: 'backpressure.fail',
        decision: 'info',
        fsync: true,
        details: `slug=${slug} unit=${args.unitId} command=${bp.command} ` +
          `exitCode=${bp.exitCode} stdoutBytes=${(bp.stdout ?? '').length} stderrBytes=${(bp.stderr ?? '').length}\n${capLogPayload(payload)}`,
      }, debug).catch(() => {});
    }

    // Contract-verifier gate only when backpressure is green (cheap-to-expensive ordering).
    let contract: ContractVerifyResult | null = null;
    const backpressureGreen =
      dispatch.event === 'complete' &&
      ((backpressure.length > 0 && backpressure.every(r => r.passed)) ||
        (backpressure.length === 0 && refreshedCommands.length === 0));
    if (backpressureGreen) {
      try {
        contract = verifyContractFn({
          unitFile: reservation.unitPath,
          projectDir: args.cwd,
          unitId: args.unitId,
        });
      } catch (err) {
        contract = { event: 'error', unitId: args.unitId, error: (err as Error).message };
      }
      if (contract.event === 'fail') {
        const formatted = formatFailureMessage(contract);
        vcpLog(args.cwd, {
          source: 'build-loop-runner',
          event: 'contract-verifier.fail',
          decision: 'info',
          fsync: true,
          details: `slug=${slug} unit=${args.unitId} failures=${contract.failures.length}\n${capLogPayload(formatted)}`,
        }, debug).catch(() => {});
      } else if (contract.event === 'error') {
        vcpLog(args.cwd, {
          source: 'build-loop-runner',
          event: 'contract-verifier.error',
          decision: 'info',
          details: `slug=${slug} unit=${args.unitId} error=${contract.error}`,
        }, debug).catch(() => {});
      }
    }

    const classified = classifyAttempt({
      dispatch, backpressure,
      backpressureCommandCount: refreshedCommands.length,
      contract,
    });

    // ─ Phase 3: commit + decide ────────────────────────────────────────────
    const attemptResult = recordAttemptResultAction(projectDir, slug, {
      unitId: args.unitId,
      lease: reservation.lease,
      outcome: classified.outcome,
      mechanicalContext: classified.mechanicalContext,
    });

    if (attemptResult.nextAction === 'unit_done') {
      const terminal = buildTerminal(
        'done', args.unitId, reservation.attempt,
        'passed mechanical gate; review disabled',
      );
      emit(terminal);
      return terminal;
    }
    if (attemptResult.nextAction === 'unit_failed') {
      const terminal = buildTerminal(
        'failed', args.unitId, reservation.attempt,
        `attempt budget exhausted after ${reservation.attempt} tries`,
      );
      emit(terminal);
      return terminal;
    }
    if (attemptResult.nextAction === 'escalate_stuck') {
      const count = attemptResult.identicalFailureCount ?? 2;
      const terminal = buildTerminal(
        'stuck', args.unitId, reservation.attempt,
        `identical mechanical failure x${count} — halt for intervention`,
      );
      emit(terminal);
      return terminal;
    }
    if (attemptResult.nextAction === 'retry_unit') {
      // Lease auto-closed inside commitAttemptResult.
      continue;
    }
    if (attemptResult.nextAction === 'dispatch_unit_review') {
      // Reservation stays OPEN across the review dispatch —
      // recordReviewResultAction commits it with the verdict.
      emit({
        event: 'review_start',
        unitId: args.unitId,
        attempt: reservation.attempt,
      });
      const reviewOutput = await reviewDispatchFn(
        args.planPath, args.cwd, args.unitId, debug,
      );
      if (reviewOutput.error) {
        vcpLog(args.cwd, {
          source: 'build-loop-runner',
          event: 'unit-review.dispatch_error',
          decision: 'warn',
          details: `slug=${slug} unit=${args.unitId} error=${reviewOutput.error}`,
        }, debug).catch(() => {});
      }
      const verdict = parseReviewVerdict(reviewOutput.synthesis ?? '');
      if (verdict.parseMode === 'salvaged_pass') {
        const excerpt = truncateRawReviewOutput(reviewOutput.synthesis ?? '');
        vcpLog(args.cwd, {
          source: 'build-loop-runner',
          event: 'unit-review.verdict_salvaged_pass',
          decision: 'warn',
          details: capLogPayload(
            `slug=${slug} unit=${args.unitId} attempt=${reservation.attempt} reason=${verdict.reason ?? 'unknown'}\n${excerpt}`,
          ),
        }, debug).catch(() => {});
      }
      emit({
        event: 'review_verdict',
        unitId: args.unitId,
        attempt: reservation.attempt,
        passed: verdict.passed,
      });

      const reviewResult = await recordReviewResultAction(projectDir, slug, {
        unitId: args.unitId,
        lease: reservation.lease,
        passed: verdict.passed,
        feedback: verdict.feedback,
      }, debug);

      if (reviewResult.nextAction === 'unit_done') {
        const terminal = buildTerminal(
          'done', args.unitId, reservation.attempt,
          `passed review on attempt ${reservation.attempt}`,
        );
        emit(terminal);
        return terminal;
      }
      if (reviewResult.nextAction === 'unit_failed') {
        const terminal = buildTerminal(
          'failed', args.unitId, reservation.attempt,
          `review NEEDS_CHANGES; budget exhausted after ${reservation.attempt} tries`,
        );
        emit(terminal);
        return terminal;
      }
      if (reviewResult.nextAction === 'retry_unit') {
        continue;
      }
      throw new Error(`runUnitLoop: unknown review nextAction ${(reviewResult as { nextAction: string }).nextAction}`);
    }
    throw new Error(`runUnitLoop: unknown attempt nextAction ${(attemptResult as { nextAction: string }).nextAction}`);
  }
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

      const result = await runUnitLoop({
        planPath: args.planPath,
        cwd: args.cwd,
        unitId: args.unitId,
      });

      await vcpLog(cwd, {
        source: SRC, event: 'complete', decision: 'info',
        details: `status=${result.status} unit=${result.unitId} attempts=${result.attempts}`,
      }, debug);

      // runUnitLoop already emitted the terminal `complete` event — do not re-emit.
    } catch (err) {
      const msg = (err as Error).message;
      const terminal: TerminalOutcome = {
        event: 'complete',
        status: 'failed',
        unitId: 0,
        attempts: 0,
        reason: `fatal: ${msg}`,
      };
      console.log(JSON.stringify(terminal));
      await vcpLog(cwd, { source: SRC, event: 'fatal', decision: 'error', details: msg }, debug);
      process.exit(1);
    }
  })();
}
