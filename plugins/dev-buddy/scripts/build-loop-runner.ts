#!/usr/bin/env bun
/**
 * Build Loop Runner — mechanical build loop for the Ralph pipeline.
 *
 * Owns the entire inner build loop: queries the state machine for the next unit,
 * dispatches the build executor via stage-runner.ts, runs backpressure, and writes
 * unit status mechanically. The Ralph orchestrator (LLM) calls this once via Bash;
 * the script loops internally and returns one JSON result when done.
 *
 * Invariant: single-writer per pipeline. Ralph invokes one build-loop-runner at a time.
 *
 * Usage:
 *   bun build-loop-runner.ts --plan <path> --cwd <dir>
 *
 * Exit codes:
 *   0 - Success (build_loop_complete or build_loop_blocked)
 *   1 - Validation error (missing args, bad plan path)
 *   2 - Execution error (state machine failure, unrecoverable)
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { main as queryStateMachineRaw, runBackpressure } from './ralph-state-machine.ts';
import { parseUnitPlan } from './ralph/parsers.ts';
import { loadDevBuddyConfig } from './pipeline-config.ts';
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';
import type {
  StateMachineOutput, Action, SkillAction, ErrorAction, BlockedAction,
  WritePlanAction, TaskAction, BackpressureResult,
  PlanStatus, UnitPlanData,
  TaskProjectionOp, UnitBuildDispatchResult, UnitBuildOutcome,
  BuildLoopRunnerResult, UnitStatusPatch,
} from './ralph/types.ts';

// ─── CLI ARG PARSING ────────────────────────────────────────────────────────

export function parseBuildLoopArgs(argv: string[]): { planPath: string; cwd: string } {
  const planIdx = argv.indexOf('--plan');
  if (planIdx === -1 || planIdx + 1 >= argv.length) {
    throw new Error('Missing required flag: --plan <plan-file-path>');
  }
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx === -1 || cwdIdx + 1 >= argv.length) {
    throw new Error('Missing required flag: --cwd <project-dir>');
  }
  return { planPath: argv[planIdx + 1], cwd: argv[cwdIdx + 1] };
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
export function writeUnitStatus(unitPath: string, patch: UnitStatusPatch): void {
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

// ─── ACTION INSPECTION HELPERS ──────────────────────────────────────────────

export function findBuildInvokeAction(output: StateMachineOutput): SkillAction | null {
  for (const action of output.actions) {
    if (action.type === 'invoke_skill') {
      const sa = action as SkillAction;
      if (sa.stageType === 'ralph-build') return sa;
    }
  }
  return null;
}

export function findErrorAction(output: StateMachineOutput): ErrorAction | null {
  for (const action of output.actions) {
    if (action.type === 'error') return action as ErrorAction;
  }
  return null;
}

export function findBlockedAction(output: StateMachineOutput): BlockedAction | null {
  for (const action of output.actions) {
    if (action.type === 'blocked') return action as BlockedAction;
  }
  return null;
}

/** Convert update_tasks actions into flat TaskProjectionOp array. */
export function collectTaskOps(actions: Action[]): TaskProjectionOp[] {
  const ops: TaskProjectionOp[] = [];
  for (const action of actions) {
    if (action.type === 'update_tasks') {
      const ta = action as TaskAction;
      for (const op of ta.operations) {
        ops.push({ ref: op.ref, status: op.status });
      }
    }
  }
  return ops;
}

/** Apply write_plan actions to the plan file using string replacement. */
export function applyWritePlanActions(planPath: string, actions: Action[]): void {
  let content = fs.readFileSync(planPath, 'utf-8');
  for (const action of actions) {
    if (action.type === 'write_plan') {
      const wp = action as WritePlanAction;
      for (const edit of wp.edits) {
        if (content.includes(edit.old_string)) {
          content = content.replace(edit.old_string, edit.new_string);
        }
      }
    }
  }
  fs.writeFileSync(planPath, content, 'utf-8');
}

// ─── STATE MACHINE QUERY ────────────────────────────────────────────────────

/**
 * Query the state machine by importing main() directly.
 * main() is NOT pure — it reads files, loads/saves state, and can throw.
 * Safe from process.exit (gated by import.meta.main).
 */
function queryStateMachine(planPath: string): StateMachineOutput {
  return queryStateMachineRaw(planPath, 'next');
}

// ─── BUILD DISPATCH ─────────────────────────────────────────────────────────

/**
 * Spawn stage-runner.ts as subprocess to dispatch the configured build executor.
 * Must be subprocess because stage-runner calls process.exit via emitSuccess/emitError.
 */
async function dispatchBuildUnitDefault(
  planPath: string,
  cwd: string,
  action: SkillAction,
): Promise<UnitBuildDispatchResult> {
  const unitContent = fs.readFileSync(action.unitPath!, 'utf-8');
  const task = [
    'Orchestrated single-unit build.',
    `Unit plan path: ${action.unitPath}`,
    'Read and implement the following unit plan.',
    'Do NOT write **Status:** or decide pass/fail — the outer runner handles that.',
    'Do NOT modify the unit plan file itself.',
    '',
    unitContent,
  ].join('\n');

  const stageRunnerPath = path.join(path.dirname(import.meta.path), 'stage-runner.ts');

  return new Promise<UnitBuildDispatchResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const proc = spawn('bun', [
      stageRunnerPath,
      '--stage-type', 'ralph-build',
      '--plan', planPath,
      '--cwd', cwd,
      '--task-stdin',
    ], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd,
    });

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stdin!.write(task);
    proc.stdin!.end();

    proc.on('error', (err) => {
      resolve({
        event: 'error',
        stage: 'ralph-build',
        phase: 'dispatch_failed',
        error: `Failed to start stage-runner: ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      // Parse JSON defensively — stage-runner may crash and emit to stderr only
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.event === 'complete') {
          resolve({
            event: 'complete',
            stage: 'ralph-build',
            synthesis: parsed.synthesis ?? null,
            workerOutputs: parsed.worker_outputs ?? [],
          });
        } else {
          resolve({
            event: 'error',
            stage: 'ralph-build',
            phase: parsed.phase ?? 'dispatch',
            error: parsed.error ?? `stage-runner returned non-complete event`,
          });
        }
      } catch {
        resolve({
          event: 'error',
          stage: 'ralph-build',
          phase: 'dispatch_failed',
          error: `stage-runner exited ${code}, stdout not parseable: ${stdout.slice(0, 500)}`,
        });
      }
    });
  });
}

// ─── RESULT BUILDERS ─────────────────────────────────────���──────────────────

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

// ─── MAIN BUILD LOOP ────────────────────────────────────────────────────────

export interface BuildLoopOverrides {
  dispatchFn?: typeof dispatchBuildUnitDefault;
  backpressureFn?: typeof runBackpressure;
}

export async function runBuildLoop(
  args: { planPath: string; cwd: string },
  overrides?: BuildLoopOverrides,
): Promise<BuildLoopRunnerResult> {
  const dispatchFn = overrides?.dispatchFn ?? dispatchBuildUnitDefault;
  const backpressureFn = overrides?.backpressureFn ?? runBackpressure;

  let devBuddyConfig: { max_build_attempts: number };
  try {
    devBuddyConfig = loadDevBuddyConfig();
  } catch {
    devBuddyConfig = { max_build_attempts: 3 };
  }

  const allUnitOutcomes: UnitBuildOutcome[] = [];
  const taskOps: TaskProjectionOp[] = [];
  let slug = '';

  while (true) {
    // Query state machine — wrapped in try/catch for corrupted state
    let sm: StateMachineOutput;
    try {
      sm = queryStateMachine(args.planPath);
    } catch (err) {
      return {
        event: 'build_loop_error',
        slug,
        terminalPlanStatus: 'build' as PlanStatus,
        nextStep: 'report_error',
        taskOperations: taskOps,
        units: allUnitOutcomes,
        summary: `State machine error: ${(err as Error).message}`,
        error: { message: (err as Error).message },
      };
    }

    slug = sm.state.slug;

    // Check for terminal actions
    const fatal = findErrorAction(sm);
    if (fatal) {
      return {
        event: 'build_loop_error',
        slug,
        terminalPlanStatus: sm.state.status,
        nextStep: 'report_error',
        taskOperations: taskOps,
        units: allUnitOutcomes,
        summary: `State machine error: ${fatal.message}`,
        error: { message: fatal.message },
      };
    }

    const blocked = findBlockedAction(sm);
    if (blocked) {
      return {
        event: 'build_loop_blocked',
        slug,
        terminalPlanStatus: sm.state.status,
        nextStep: 'report_blocked',
        taskOperations: taskOps,
        units: allUnitOutcomes,
        summary: `Build blocked: ${blocked.reason}`,
        blocked: { reason: blocked.reason, preconditionError: blocked.preconditionError },
      };
    }

    // Look for a build invoke action
    const buildAction = findBuildInvokeAction(sm);

    if (!buildAction) {
      // No build action — state machine transitioned away from build (all done → review)
      // Apply any write_plan actions (e.g., Status: build → review)
      applyWritePlanActions(args.planPath, sm.actions);
      taskOps.push(...collectTaskOps(sm.actions));
      return {
        event: 'build_loop_complete',
        slug,
        terminalPlanStatus: sm.state.status,
        nextStep: 'requery_state_machine',
        taskOperations: taskOps,
        units: allUnitOutcomes,
        summary: `Build loop complete: ${allUnitOutcomes.filter(u => u.outcome === 'done').length} units done, plan advanced to ${sm.state.status}.`,
      };
    }

    // Collect task ops from this iteration
    taskOps.push(...collectTaskOps(sm.actions));

    // Read unit and compute attempt budget
    const unitContent = fs.readFileSync(buildAction.unitPath!, 'utf-8');
    const unit = parseUnitPlan(unitContent, buildAction.unitId!);
    const maxAttempts = Math.min(unit.maxAttempts, devBuddyConfig.max_build_attempts);
    const nextAttempt = unit.attempts + 1;

    // Guard: attempt budget exhausted
    if (nextAttempt > maxAttempts) {
      writeUnitStatus(buildAction.unitPath!, {
        status: 'failed',
        attempts: unit.attempts,
        appendResult: `Attempt budget exhausted (${unit.attempts}/${maxAttempts}).`,
      });
      taskOps.push({ ref: `unit:${buildAction.unitId}`, status: 'failed' });
      allUnitOutcomes.push({
        unitId: buildAction.unitId!,
        unitPath: buildAction.unitPath!,
        attempt: unit.attempts,
        maxAttempts,
        dispatch: {
          event: 'error',
          stage: 'ralph-build',
          phase: 'attempt_budget',
          error: `Exhausted ${unit.attempts}/${maxAttempts} attempts.`,
        },
        backpressure: [],
        outcome: 'failed',
      });
      continue; // State machine may have independent units
    }

    // Crash-safe: consume attempt before dispatch
    writeUnitStatus(buildAction.unitPath!, {
      status: 'pending',
      attempts: nextAttempt,
      appendResult: `Attempt ${nextAttempt}/${maxAttempts} started.`,
    });

    // Dispatch build executor
    const dispatch = await dispatchFn(args.planPath, args.cwd, buildAction);

    // Re-read unit file (executor may have modified project files)
    const refreshedContent = fs.readFileSync(buildAction.unitPath!, 'utf-8');
    const commands = extractBackpressureCommands(refreshedContent);

    // Zero backpressure commands = hard failure
    if (commands.length === 0) {
      const isExhausted = nextAttempt >= maxAttempts;
      const outcome: UnitBuildOutcome['outcome'] = isExhausted ? 'failed' : 'retry';
      writeUnitStatus(buildAction.unitPath!, {
        status: isExhausted ? 'failed' : 'pending',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, [], outcome, nextAttempt, maxAttempts) +
          '\n\n**Note:** No backpressure commands found in unit file.',
      });
      if (isExhausted) {
        taskOps.push({ ref: `unit:${buildAction.unitId}`, status: 'failed' });
      }
      allUnitOutcomes.push({
        unitId: buildAction.unitId!,
        unitPath: buildAction.unitPath!,
        attempt: nextAttempt,
        maxAttempts,
        dispatch,
        backpressure: [],
        outcome,
      });
      continue;
    }

    // Run backpressure (only if dispatch succeeded)
    const backpressure = dispatch.event === 'complete'
      ? backpressureFn(commands, args.cwd)
      : [];

    const passed = dispatch.event === 'complete' &&
      backpressure.length > 0 &&
      backpressure.every(r => r.passed);

    let outcome: UnitBuildOutcome['outcome'];
    if (passed) {
      outcome = 'done';
      writeUnitStatus(buildAction.unitPath!, {
        status: 'done',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure, outcome, nextAttempt, maxAttempts),
      });
      taskOps.push({ ref: `unit:${buildAction.unitId}`, status: 'completed' });
    } else if (nextAttempt >= maxAttempts) {
      outcome = 'failed';
      writeUnitStatus(buildAction.unitPath!, {
        status: 'failed',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure, outcome, nextAttempt, maxAttempts),
      });
      taskOps.push({ ref: `unit:${buildAction.unitId}`, status: 'failed' });
    } else {
      outcome = 'retry';
      writeUnitStatus(buildAction.unitPath!, {
        status: 'pending',
        attempts: nextAttempt,
        appendResult: renderAttemptSummary(dispatch, backpressure, outcome, nextAttempt, maxAttempts),
      });
    }

    allUnitOutcomes.push({
      unitId: buildAction.unitId!,
      unitPath: buildAction.unitPath!,
      attempt: nextAttempt,
      maxAttempts,
      dispatch,
      backpressure,
      outcome,
    });
  }
}

// ─��─ CLI ENTRY POINT ────────────────────────────────────────��───────────────

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
        details: `plan=${path.basename(args.planPath)} cwd=${cwd}`,
      }, debug);

      const result = await runBuildLoop(args);

      await vcpLog(cwd, {
        source: SRC, event: 'complete', decision: 'info',
        details: `event=${result.event} units=${result.units.length} slug=${result.slug}`,
      }, debug);

      console.log(JSON.stringify(result, null, 2));

      if (result.event === 'build_loop_error') process.exit(2);
    } catch (err) {
      const msg = (err as Error).message;
      console.log(JSON.stringify({
        event: 'build_loop_error',
        slug: '',
        terminalPlanStatus: 'build',
        nextStep: 'report_error',
        taskOperations: [],
        units: [],
        summary: msg,
        error: { message: msg },
      }));
      await vcpLog(cwd, { source: SRC, event: 'fatal', decision: 'error', details: msg }, debug);
      process.exit(1);
    }
  })();
}
