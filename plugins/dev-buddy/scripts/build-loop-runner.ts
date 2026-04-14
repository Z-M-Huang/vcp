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
} from './ralph/types.ts';

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

// ─── UNIT FILE MUTATION HELPERS ─────────────────────────────────────────────

/**
 * Find `**{label}:** value` in content and replace, or insert below the title if absent.
 * Idempotent: works whether the field exists or not.
 */
export function upsertMetadataLine(content: string, label: string, value: string): string {
  const pattern = new RegExp(`\\*\\*${label}:\\*\\*\\s*\\S+`);
  const replacement = `**${label}:** ${value}`;
  if (pattern.test(content)) {
    return content.replace(pattern, replacement);
  }
  // Insert after the first heading line (# Unit N: ...)
  const titleMatch = content.match(/^#.+$/m);
  if (titleMatch && titleMatch.index !== undefined) {
    const insertPos = titleMatch.index + titleMatch[0].length;
    return content.slice(0, insertPos) + '\n' + replacement + content.slice(insertPos);
  }
  // No title found — prepend
  return replacement + '\n' + content;
}

/**
 * Find a section by heading and replace its body, or append the section at end.
 * The section ends at the next heading of same or higher level, or EOF.
 */
export function replaceOrAppendSection(content: string, heading: string, body: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRegex = new RegExp(`(^${escapedHeading}\\s*$)([\\s\\S]*?)(?=^#{1,3} |$(?!\\n))`, 'm');
  const match = content.match(sectionRegex);
  if (match && match.index !== undefined) {
    const start = match.index;
    const end = start + match[0].length;
    return content.slice(0, start) + heading + '\n\n' + body + '\n\n' + content.slice(end);
  }
  // Append at end
  return content.trimEnd() + '\n\n' + heading + '\n\n' + body + '\n';
}

/**
 * Write unit status, attempts, and build attempt summary to a unit plan file.
 * Uses atomic temp-file + rename to prevent partial writes.
 */
export function writeUnitStatus(unitPath: string, patch: import('./ralph/types.ts').UnitStatusPatch): void {
  let content = fs.readFileSync(unitPath, 'utf-8');
  content = upsertMetadataLine(content, 'Status', patch.status);
  content = upsertMetadataLine(content, 'Attempts', String(patch.attempts));
  content = replaceOrAppendSection(content, '## Latest Build Attempt', patch.appendResult);
  // Atomic write
  const tempPath = `${unitPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, unitPath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ─── BACKPRESSURE EXTRACTION ────────────────────────────────────────────────

/**
 * Extract backpressure commands from unit file content.
 * Matches both ## Backpressure and ### Backpressure headings.
 */
export function extractBackpressureCommands(content: string): string[] {
  const match = content.match(/^#{2,3} Backpressure\s*$/m);
  if (!match || match.index === undefined) return [];
  const after = content.slice(match.index + match[0].length);
  const nextHeading = after.search(/\n#{2,3} /);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
  return [...section.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(Boolean);
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

async function dispatchBuildUnitDefault(
  planPath: string,
  cwd: string,
  unitPath: string,
  debugEnabled: boolean,
): Promise<UnitBuildDispatchResult> {
  const unitContent = fs.readFileSync(unitPath, 'utf-8');
  const task = [
    'Orchestrated single-unit build.',
    `Unit plan path: ${unitPath}`,
    'Read and implement the following unit plan.',
    'Do NOT write **Status:** or decide pass/fail — the outer runner handles that.',
    'Do NOT modify the unit plan file itself.',
    '',
    unitContent,
  ].join('\n');

  const { stdout, stderr, code } = await spawnStageRunner('ralph-build', task, planPath, cwd, debugEnabled);

  if (!stdout) {
    return {
      event: 'error', stage: 'ralph-build', phase: 'dispatch_failed',
      error: `Failed to start stage-runner: ${stderr}`,
    };
  }

  try {
    const parsed = JSON.parse(stdout);
    if (parsed.event === 'complete') {
      return {
        event: 'complete', stage: 'ralph-build',
        synthesis: parsed.synthesis ?? null,
        workerOutputs: parsed.worker_outputs ?? [],
      };
    }
    return {
      event: 'error', stage: 'ralph-build',
      phase: parsed.phase ?? 'dispatch',
      error: parsed.error ?? 'stage-runner returned non-complete event',
    };
  } catch {
    const stderrExcerpt = stderr.trim() ? ` stderr=${stderr.slice(0, 500)}` : '';
    return {
      event: 'error', stage: 'ralph-build', phase: 'dispatch_failed',
      error: `stage-runner exited ${code}, stdout not parseable: ${stdout.slice(0, 500)}${stderrExcerpt}`,
    };
  }
}

// ─── PER-UNIT SEMANTIC REVIEW ──────────────────────────────────────────────

/**
 * Parse a review verdict from synthesized review output.
 * Searches for `## Verdict: PASS` or `## Verdict: NEEDS_CHANGES`.
 * Fail-open: unparseable output → treat as PASS + log warning.
 */
export function parseReviewVerdict(output: string): { passed: boolean; feedback: string } {
  const verdictMatch = output.match(/^##\s+Verdict:\s*(PASS|NEEDS_CHANGES)\s*$/im);
  if (!verdictMatch) {
    return { passed: true, feedback: '' };
  }
  if (verdictMatch[1].toUpperCase() === 'PASS') {
    return { passed: true, feedback: '' };
  }
  // Extract feedback: everything after "## Review Feedback" heading, or everything after the verdict
  const feedbackMatch = output.match(/^##\s+Review Feedback\s*$([\s\S]*?)(?=^##\s|$(?!\n))/im);
  const feedback = feedbackMatch ? feedbackMatch[1].trim() : output.slice(verdictMatch.index! + verdictMatch[0].length).trim();
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

/** Dispatch per-unit semantic review via stage-runner subprocess. Fail-open on any error. */
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

    const { stdout } = await spawnStageRunner('unit-review', task, planPath, cwd, debugEnabled);

    if (!stdout) {
      return { skipped: false, passed: true, feedback: '' };
    }

    try {
      const parsed = JSON.parse(stdout);
      if (parsed.event === 'complete' && parsed.synthesis) {
        return { skipped: false, ...parseReviewVerdict(parsed.synthesis) };
      }
      // Non-complete event — fail-open
      vcpLog(cwd, {
        source: 'build-loop-runner', event: 'unit_review_non_complete', decision: 'warn',
        details: `stage-runner returned: ${stdout.slice(0, 500)}`,
      }, debugEnabled).catch(() => {});
      return { skipped: false, passed: true, feedback: '' };
    } catch {
      vcpLog(cwd, {
        source: 'build-loop-runner', event: 'unit_review_parse_error', decision: 'warn',
        details: `stdout not parseable: ${stdout.slice(0, 500)}`,
      }, debugEnabled).catch(() => {});
      return { skipped: false, passed: true, feedback: '' };
    }
  } catch (err) {
    vcpLog(cwd, {
      source: 'build-loop-runner', event: 'unit_review_error', decision: 'warn',
      details: `Review dispatch failed: ${(err as Error).message}`,
    }, debugEnabled).catch(() => {});
    return { skipped: false, passed: true, feedback: '' };
  }
}

/** Check if unit-review stage is enabled (has executors) in the given config. */
function isUnitReviewEnabled(config: { stages: Record<string, { executors: unknown[] }> }): boolean {
  const stage = config.stages['unit-review' as StageType];
  return !!stage && stage.executors.length > 0;
}

// ─── RESULT BUILDERS ────────────────────────────────────────────────────────

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
  dispatchFn?: (planPath: string, cwd: string, unitPath: string, debug: boolean) => Promise<UnitBuildDispatchResult>;
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
    writeUnitStatus(unitPath, {
      status: 'failed',
      attempts: unit.attempts,
      appendResult: `Attempt budget exhausted (${unit.attempts}/${maxAttempts}).`,
    });
    return {
      event: 'unit_failed', unitId: args.unitId, unitPath,
      attempt: unit.attempts, maxAttempts, outcome: 'failed',
      summary: `Unit ${args.unitId} exhausted attempt budget (${unit.attempts}/${maxAttempts}).`,
    };
  }

  let lastAttempt = unit.attempts;

  while (lastAttempt < maxAttempts) {
    const nextAttempt = lastAttempt + 1;

    // Crash-safe: consume attempt before dispatch
    writeUnitStatus(unitPath, {
      status: 'pending',
      attempts: nextAttempt,
      appendResult: `Attempt ${nextAttempt}/${maxAttempts} started.`,
    });

    // Dispatch build executor
    const dispatch = await dispatchFn(args.planPath, args.cwd, unitPath, debug);

    // Re-read unit file (executor may have modified project files)
    const refreshedContent = fs.readFileSync(unitPath, 'utf-8');
    const commands = extractBackpressureCommands(refreshedContent);

    // Zero backpressure commands = hard failure
    if (commands.length === 0) {
      const isExhausted = nextAttempt >= maxAttempts;
      writeUnitStatus(unitPath, {
        status: isExhausted ? 'failed' : 'pending',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, [], isExhausted ? 'failed' : 'retry', nextAttempt, maxAttempts) +
          '\n\n**Note:** No backpressure commands found in unit file.',
      });
      if (isExhausted) {
        return {
          event: 'unit_failed', unitId: args.unitId, unitPath,
          attempt: nextAttempt, maxAttempts, outcome: 'failed',
          summary: `Unit ${args.unitId} failed: no backpressure commands (attempt ${nextAttempt}/${maxAttempts}).`,
        };
      }
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
      // Per-unit semantic review (if configured) — fail-open on any error
      let review: UnitReviewResult;
      try {
        review = await reviewFn(args.planPath, args.cwd, unitPath, debug);
      } catch {
        review = { skipped: false, passed: true, feedback: '' };
      }

      if (review.skipped || review.passed) {
        // Clear stale review feedback from prior failed attempts
        if (refreshedContent.includes('## Review Feedback')) {
          const cleaned = replaceOrAppendSection(refreshedContent, '## Review Feedback', '');
          const tempClean = `${unitPath}.tmp-${process.pid}-${Date.now()}`;
          try {
            fs.writeFileSync(tempClean, cleaned, 'utf-8');
            fs.renameSync(tempClean, unitPath);
          } catch { try { fs.unlinkSync(tempClean); } catch { /* ignore */ } }
        }

        writeUnitStatus(unitPath, {
          status: 'done',
          attempts: nextAttempt,
          appendResult: renderAttemptSummary(dispatch, backpressure, 'done', nextAttempt, maxAttempts),
        });
        return {
          event: 'unit_done', unitId: args.unitId, unitPath,
          attempt: nextAttempt, maxAttempts, outcome: 'done',
          summary: `Unit ${args.unitId} done on attempt ${nextAttempt}/${maxAttempts}.`,
        };
      }

      // Review failed — write feedback for next attempt
      const withFeedback = replaceOrAppendSection(refreshedContent, '## Review Feedback', review.feedback);
      const tempFeedback = `${unitPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        fs.writeFileSync(tempFeedback, withFeedback, 'utf-8');
        fs.renameSync(tempFeedback, unitPath);
      } catch { try { fs.unlinkSync(tempFeedback); } catch { /* ignore */ } }

      const isExhausted = nextAttempt >= maxAttempts;
      writeUnitStatus(unitPath, {
        status: isExhausted ? 'failed' : 'pending',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure,
          isExhausted ? 'failed' : 'retry', nextAttempt, maxAttempts) +
          '\n\n**Review Verdict:** NEEDS_CHANGES\n' + review.feedback,
      });

      if (isExhausted) {
        return {
          event: 'unit_failed', unitId: args.unitId, unitPath,
          attempt: nextAttempt, maxAttempts, outcome: 'failed',
          summary: `Unit ${args.unitId} failed review after ${nextAttempt}/${maxAttempts} attempts.`,
        };
      }
      lastAttempt = nextAttempt;
      continue;
    }

    // Failed — check if exhausted
    if (nextAttempt >= maxAttempts) {
      writeUnitStatus(unitPath, {
        status: 'failed',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure, 'failed', nextAttempt, maxAttempts),
      });
      return {
        event: 'unit_failed', unitId: args.unitId, unitPath,
        attempt: nextAttempt, maxAttempts, outcome: 'failed',
        summary: `Unit ${args.unitId} failed after ${nextAttempt}/${maxAttempts} attempts.`,
      };
    }

    // Retry — write pending and continue loop
    writeUnitStatus(unitPath, {
      status: 'pending',
      attempts: nextAttempt,
      appendResult: renderAttemptSummary(dispatch, backpressure, 'retry', nextAttempt, maxAttempts),
    });
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
