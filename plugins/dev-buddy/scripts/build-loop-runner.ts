#!/usr/bin/env bun
/**
 * Build Loop Runner — single-attempt build executor for the Ralph pipeline.
 *
 * Executes ONE build attempt per invocation: dispatches the build executor
 * via stage-runner.ts, runs backpressure, returns structured outcome JSON.
 * BLR writes NOTHING — no state files, no unit-N.md, no review dispatch.
 * Retry, unit-review, and state persistence are driven by the state machine
 * via compose_build_dispatch → BLR → record_attempt_result → record_review_result.
 *
 * Usage:
 *   bun build-loop-runner.ts --plan <path> --cwd <dir> --unit <id> [--lease <token>]
 *
 * Exit codes:
 *   0 - attempt_complete (structured outcome)
 *   1 - validation error
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runBackpressure } from './ralph-state-machine.ts';
import { vcpLog, isDebugEnabled, capLogPayload } from './vcp-logger.ts';
import type {
  BackpressureResult, UnitBuildDispatchResult, AttemptOutcome,
  MechanicalContext,
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

// Re-export unit-file helpers still used by callers importing from BLR.
export { splitUnitFile, extractBackpressureCommands, upsertMetadataLine, replaceOrAppendSection };
// Re-export prompt-assembly surface for tests and external callers that
// previously imported these from build-loop-runner.ts.
export { composeBuildDispatchPrompt, composeBuildDispatchPromptFromUnitFile };
export type { DispatchPriority, ComposeBuildDispatchPromptResult };

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

export function parseBuildLoopArgs(argv: string[]): {
  planPath: string; cwd: string; unitId: number; lease?: string;
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
  const leaseIdx = argv.indexOf('--lease');
  const lease = (leaseIdx !== -1 && leaseIdx + 1 < argv.length)
    ? argv[leaseIdx + 1]
    : undefined;
  return { planPath: argv[planIdx + 1], cwd: argv[cwdIdx + 1], unitId, lease };
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

async function dispatchBuildUnitDefault(
  planPath: string,
  cwd: string,
  unitPath: string,
  debugEnabled: boolean,
  promptText: string | null,
): Promise<UnitBuildDispatchResult> {
  let task: string;
  if (promptText) {
    task = promptText;
  } else {
    const unitContent = fs.readFileSync(unitPath, 'utf-8');
    const composed = composeBuildDispatchPromptFromUnitFile(unitContent, unitPath, null);
    task = composed.prompt;
    vcpLog(cwd, {
      source: 'build-loop-runner', event: 'build_dispatch.composed', decision: 'info',
      details:
        `staticPlan=${composed.staticPlanChars} feedback=${composed.feedbackChars} ` +
        `mechanical=${composed.mechanicalChars} priority=${composed.priority}`,
    }, debugEnabled).catch(() => {});
  }

  const { stdout, stderr, code } = await spawnStageRunner('ralph-build', task, planPath, cwd, debugEnabled);

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

// ─── REVIEW VERDICT PARSING ──────────────────────────────────────────────

/** Maximum bytes of raw output retained when feedback is unparseable. */
export const UNPARSEABLE_RAW_OUTPUT_CAP = 5000;

/**
 * Parse a review verdict from synthesized review output. **Fail-closed.**
 *
 * - Verdict `PASS` → `{ passed: true, feedback: '' }`
 * - Verdict `NEEDS_CHANGES` → `{ passed: false, feedback: <captured + demoted> }`
 * - Missing or unrecognized verdict → `{ passed: false, feedback: '<error + truncated raw output>' }`.
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

// ─── SINGLE-ATTEMPT EXECUTOR ──────────────────────────────────────────────

export interface BuildLoopOverrides {
  dispatchFn?: (planPath: string, cwd: string, unitPath: string, debug: boolean, promptText: string | null) => Promise<UnitBuildDispatchResult>;
  backpressureFn?: typeof runBackpressure;
}

/**
 * Execute a single build attempt. Stateless — returns structured outcome JSON
 * without writing any state files or unit markdown.
 *
 * 1. Resolve unit path from plan slug + unit ID
 * 2. Dispatch build executor (via promptText stdin or fallback compose)
 * 3. Run backpressure commands
 * 4. Log failures (§11)
 * 5. Return outcome for SM to persist via record_attempt_result
 */
export async function runSingleAttempt(
  args: { planPath: string; cwd: string; unitId: number; lease?: string; promptText?: string },
  overrides?: BuildLoopOverrides,
): Promise<AttemptOutcome> {
  const debug = await isDebugEnabled();
  const dispatchFn = overrides?.dispatchFn ?? dispatchBuildUnitDefault;
  const backpressureFn = overrides?.backpressureFn ?? runBackpressure;

  const { unitPath, slug } = resolveUnitPath(args.planPath, args.unitId);

  const unitContent = fs.readFileSync(unitPath, 'utf-8');
  const commands = extractBackpressureCommands(unitContent);

  const dispatch = await dispatchFn(args.planPath, args.cwd, unitPath, debug, args.promptText ?? null);

  // Re-read unit file post-dispatch (executor may have modified project files)
  const refreshedContent = fs.readFileSync(unitPath, 'utf-8');
  const refreshedCommands = extractBackpressureCommands(refreshedContent);
  const effectiveCommands = refreshedCommands.length > 0 ? refreshedCommands : commands;

  // Run backpressure only when dispatch succeeded and commands exist
  const backpressure: BackpressureResult[] =
    (dispatch.event === 'complete' && effectiveCommands.length > 0)
      ? backpressureFn(effectiveCommands, args.cwd)
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

  // Determine outcome
  let outcome: AttemptOutcome['outcome'];
  let mechanicalContext: MechanicalContext | null = null;

  if (dispatch.event !== 'complete') {
    outcome = 'dispatch_error';
    mechanicalContext = dispatch.mechanicalContext ?? null;
  } else if (backpressure.length > 0 && backpressure.every(r => r.passed)) {
    outcome = 'mechanical_pass';
  } else if (backpressure.length === 0 && effectiveCommands.length === 0) {
    outcome = 'mechanical_pass';
  } else {
    outcome = 'mechanical_fail';
    const firstFailure = backpressure.find(bp => !bp.passed);
    if (firstFailure) {
      mechanicalContext = buildMechanicalContext(
        'backpressure', firstFailure.command, firstFailure.exitCode,
        firstFailure.stdout, firstFailure.stderr,
      );
    }
  }

  return {
    event: 'attempt_complete',
    unitId: args.unitId,
    unitPath,
    outcome,
    mechanicalContext,
    backpressureResults: backpressure,
    synthesis: dispatch.synthesis ?? null,
    lease: args.lease ?? null,
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

      // Read prompt from stdin when piped (composed by SM's compose_build_dispatch)
      let promptText: string | undefined;
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const stdinContent = Buffer.concat(chunks).toString('utf-8').trim();
        if (stdinContent) promptText = stdinContent;
      }

      await vcpLog(cwd, {
        source: SRC, event: 'start', decision: 'info',
        details: `plan=${path.basename(args.planPath)} unit=${args.unitId} lease=${args.lease ?? 'none'} promptStdin=${!!promptText} cwd=${cwd}`,
      }, debug);

      const result = await runSingleAttempt({
        planPath: args.planPath,
        cwd: args.cwd,
        unitId: args.unitId,
        lease: args.lease,
        promptText,
      });

      await vcpLog(cwd, {
        source: SRC, event: 'complete', decision: 'info',
        details: `outcome=${result.outcome} unit=${result.unitId} lease=${result.lease ?? 'none'}`,
      }, debug);

      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      const msg = (err as Error).message;
      const errorResult: AttemptOutcome = {
        event: 'attempt_complete',
        unitId: 0,
        unitPath: '',
        outcome: 'dispatch_error',
        mechanicalContext: null,
        backpressureResults: [],
        synthesis: null,
        lease: null,
      };
      console.log(JSON.stringify({ ...errorResult, error: msg }, null, 2));
      await vcpLog(cwd, { source: SRC, event: 'fatal', decision: 'error', details: msg }, debug);
      process.exit(1);
    }
  })();
}
