import * as fs from 'fs';
import * as path from 'path';
import { createLogger, isDebugEnabled } from '@vcp-lib/logging';
const vcpLog = createLogger('dev-buddy.log');
import { loadDevBuddyConfig } from './pipeline-config.ts';

// Re-export submodules so existing callers (tests, skills, CLI) keep working
export * from './ralph/types.ts';
export { parsePlanFile, parseUnitPlan, getNextBuildUnit, listUnits, detectUnitStateContradiction } from './ralph/parsers.ts';
export { loadState, saveState, registerTaskId, registerTaskGraph } from './ralph/state.ts';
export { runBackpressure } from './ralph/backpressure.ts';
export { verifyTaskGraph, computeBlockedByOperations } from './ralph/task-graph.ts';
export type { TaskGraphDiff } from './ralph/task-graph.ts';
export { checkPreconditions } from './ralph/preconditions.ts';
export { computeNextAction } from './ralph/compute-action.ts';
export {
  normalizeStderr, detectStuck, composeBuildDispatch,
  recordAttemptResultAction, recordReviewResultAction,
} from './ralph/build-actions.ts';

// Local imports for this file's logic
import type {
  PlanStatus, StateMachineState, StateMachineOutput,
  Action, SkillAction, CheckpointAction, WritePlanAction, TaskAction, TaskOperation,
  ErrorAction, UnitListEntry,
  RecordAttemptInput, RecordReviewInput,
} from './ralph/types.ts';
import { STATUS_TO_SKILL, STATUS_TO_STAGE_TYPE } from './ralph/types.ts';
import { parsePlanFile, listUnits } from './ralph/parsers.ts';
import { loadState, saveState, registerTaskId, registerTaskGraph } from './ralph/state.ts';
import { ensureStateMigrated, scanOrphanStagingDirs } from './ralph/migrate.ts';
import { verifyTaskGraph, computeBlockedByOperations } from './ralph/task-graph.ts';
import { maybeRunRetentionSweep } from './ralph/retention.ts';
import { checkPreconditions } from './ralph/preconditions.ts';
import { computeNextAction } from './ralph/compute-action.ts';
import {
  composeBuildDispatch, recordAttemptResultAction, recordReviewResultAction,
} from './ralph/build-actions.ts';
import { readPlanState, markPlanComplete } from './ralph/unit-state.ts';

// ─── EXECUTOR CONFIG RESOLUTION ───────────────────────────────────────────

/**
 * Map a plan status to its stage type and skill name.
 * Pure lookup using STATUS_TO_SKILL and STATUS_TO_STAGE_TYPE.
 *
 * @param status - A PlanStatus value
 * @param pluginRoot - Absolute path to plugin root (reserved for future prompt composition)
 * @returns Object with stageType and skill, or null for 'done' / unmapped statuses
 */
export function resolveExecutorConfig(
  status: PlanStatus,
  pluginRoot: string,
): { stageType: string; skill: string } | null {
  const skill = STATUS_TO_SKILL[status];
  const stageType = STATUS_TO_STAGE_TYPE[status];
  if (!skill || !stageType) return null;
  return { stageType, skill };
}

// ─── CLI ENTRY POINT ─────────────────────────────────────────────────────────

/**
 * Parse the slug out of a plan filename (ralph-{SLUG}.md). Returns null when
 * the filename does not match. Non-throwing so main() can return a structured
 * ErrorAction while CLI branches print+exit on the same nullable contract.
 */
function extractSlug(planPath: string): string | null {
  const m = path.basename(planPath).match(/^ralph-(.+)\.md$/);
  return m ? m[1] : null;
}

/**
 * Parse CLI arguments for the state machine entry point.
 * Expects: --plan <path> --action <action> [--ref <ref>] [--task-id <id>] [--data <json|@path>]
 * Throws if --plan or --action flags are missing.
 */
export function parseCliArgs(argv: string[]): {
  planPath: string;
  action: string;
  ref?: string;
  taskId?: string;
  data?: string;
} {
  const planIdx = argv.indexOf('--plan');
  if (planIdx === -1 || planIdx + 1 >= argv.length) {
    throw new Error('Missing required flag: --plan <plan-file-path>');
  }
  const actionIdx = argv.indexOf('--action');
  if (actionIdx === -1 || actionIdx + 1 >= argv.length) {
    throw new Error('Missing required flag: --action <action>');
  }
  const result: { planPath: string; action: string; ref?: string; taskId?: string; data?: string } = {
    planPath: argv[planIdx + 1],
    action: argv[actionIdx + 1],
  };
  const refIdx = argv.indexOf('--ref');
  if (refIdx !== -1 && refIdx + 1 < argv.length) {
    result.ref = argv[refIdx + 1];
  }
  const taskIdIdx = argv.indexOf('--task-id');
  if (taskIdIdx !== -1 && taskIdIdx + 1 < argv.length) {
    result.taskId = argv[taskIdIdx + 1];
  }
  const dataIdx = argv.indexOf('--data');
  if (dataIdx !== -1 && dataIdx + 1 < argv.length) {
    result.data = argv[dataIdx + 1];
  }
  return result;
}

/**
 * Resolve `--data` argument: raw JSON string, or `@path/to/file.json` to read from disk.
 * Path form avoids OS argv size limits for large graphs.
 */
export function resolveDataArg(raw: string): unknown {
  let text: string;
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1);
    text = fs.readFileSync(filePath, 'utf-8');
  } else {
    text = raw;
  }
  return JSON.parse(text);
}

/**
 * Main entry point: read plan, load/create state, compute next action, save state.
 * Returns StateMachineOutput. Returns ErrorAction on failure rather than throwing.
 */
export function main(planPath: string, action: string): StateMachineOutput {
  // Read plan file
  let content: string;
  try {
    content = fs.readFileSync(planPath, 'utf-8');
  } catch {
    const errorState: StateMachineState = {
      slug: '', status: 'discover', outerIteration: 0, reviewIteration: 0,
      units: [], lastAction: action, lastTimestamp: new Date().toISOString(),
      taskIds: {}, blockedBy: {},
    };
    return {
      actions: [{ type: 'error', message: `Plan file not found: ${planPath}` } as ErrorAction],
      state: errorState,
    };
  }

  // Extract slug from filename: ralph-{SLUG}.md
  const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
  if (!slugMatch) {
    const errorState: StateMachineState = {
      slug: '', status: 'discover', outerIteration: 0, reviewIteration: 0,
      units: [], lastAction: action, lastTimestamp: new Date().toISOString(),
      taskIds: {}, blockedBy: {},
    };
    return {
      actions: [{ type: 'error', message: `Cannot extract slug from plan filename: ${path.basename(planPath)}` } as ErrorAction],
      state: errorState,
    };
  }
  const slug = slugMatch[1];

  // Derive projectDir: plan file lives at {projectDir}/.vcp/plan/ralph-{slug}.md
  const projectDir = path.resolve(path.dirname(planPath), '..', '..');

  // Crash-safe migration + orphan cleanup (§Migration).
  // Idempotent: no-op when the v2 layout already exists. Throws on corrupt
  // legacy input, which propagates upward so the caller sees the cause.
  scanOrphanStagingDirs(projectDir);
  ensureStateMigrated(projectDir, slug);

  // §9 retention: archive old completed plans when the marker says we're due.
  maybeRunRetentionSweep(projectDir);

  // Parse plan file
  const planData = parsePlanFile(content);

  // Load existing state or create initial state
  let state = loadState(projectDir, slug);
  if (!state) {
    state = {
      slug,
      status: planData.status || 'discover',
      outerIteration: 0,
      reviewIteration: 0,
      units: [],
      lastAction: action,
      lastTimestamp: new Date().toISOString(),
      taskIds: {},
      blockedBy: {},
    };
  }

  // Sync status from plan file (plan file is source of truth)
  if (planData.status) {
    state = { ...state, status: planData.status };
  }

  // Compute next action — read real config, fall back to safe defaults on error
  let config: { max_iterations: number; max_build_attempts: number; max_outer_iterations: number };
  try {
    const devBuddyConfig = loadDevBuddyConfig();
    config = {
      max_iterations: devBuddyConfig.max_iterations,
      max_build_attempts: devBuddyConfig.max_build_attempts,
      max_outer_iterations: devBuddyConfig.max_outer_iterations,
    };
  } catch {
    config = { max_iterations: 10, max_build_attempts: 3, max_outer_iterations: 3 };
  }
  const output = computeNextAction(state, planData, projectDir, config);

  // Update timestamps and persist
  const updatedState: StateMachineState = {
    ...output.state,
    lastAction: action,
    lastTimestamp: new Date().toISOString(),
  };
  saveState(projectDir, slug, updatedState);

  // §9 retention anchor: stamp plan.json.completedAt on terminal transitions so
  // the next sweep has something to act on. Skip if plan.json is missing (older
  // plan that never migrated) or if it is already stamped.
  if (updatedState.status === 'done' || updatedState.status === 'failed_irrecoverable') {
    try {
      const plan = readPlanState(projectDir, slug);
      if (plan && !plan.completedAt) {
        markPlanComplete(projectDir, slug, updatedState.status);
      }
    } catch {
      // best-effort — retention is not load-bearing for correctness
    }
  }

  return { actions: output.actions, state: updatedState };
}

if (import.meta.main) {
  (async () => {
    const SRC = 'ralph-state-machine';
    let projectDir = '';
    let debug = false;

    try {
      debug = await isDebugEnabled();
      const parsed = parseCliArgs(process.argv);
      const { planPath, action } = parsed;

      // Derive projectDir early for logging
      projectDir = path.resolve(path.dirname(planPath), '..', '..');

      const log = (event: string, decision: 'info' | 'warn' | 'error' | 'allow' | 'block', details?: string) =>
        vcpLog(projectDir, { source: SRC, event, decision, details }, debug);

      await log('cli-invoke', 'info', `action=${action} plan=${path.basename(planPath)}`);

      // ─── list-units: return structured unit data for task creation ────
      if (action === 'list-units') {
        const slug = extractSlug(planPath);
        if (!slug) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          await log('list-units', 'error', `bad slug from ${path.basename(planPath)}`);
          process.exit(1);
        }
        const units = listUnits(projectDir, slug);
        await log('list-units', 'info', `slug=${slug} units=${units.length} statuses=${units.map(u => `${u.id}:${u.status}`).join(',')}`);
        console.log(JSON.stringify({ units }, null, 2));
        process.exit(0);
      }

      // ─── register-task: persist a task ID in the state file ──────────
      if (action === 'register-task') {
        if (!parsed.ref || !parsed.taskId) {
          console.error('register-task requires --ref <ref> --task-id <id>');
          await log('register-task', 'error', 'missing --ref or --task-id');
          process.exit(1);
        }
        const slug = extractSlug(planPath);
        if (!slug) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          await log('register-task', 'error', `bad slug from ${path.basename(planPath)}`);
          process.exit(1);
        }
        registerTaskId(projectDir, slug, parsed.ref, parsed.taskId);
        await log('register-task', 'info', `ref=${parsed.ref} taskId=${parsed.taskId}`);
        console.log(JSON.stringify({ registered: { ref: parsed.ref, taskId: parsed.taskId } }));
        process.exit(0);
      }

      // ─── register-task-graph: bulk-register taskIds + blockedBy ──────
      if (action === 'register-task-graph') {
        if (!parsed.data) {
          console.error('register-task-graph requires --data <json|@path>');
          await log('register-task-graph', 'error', 'missing --data');
          process.exit(1);
        }
        const slug = extractSlug(planPath);
        if (!slug) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          await log('register-task-graph', 'error', `bad slug from ${path.basename(planPath)}`);
          process.exit(1);
        }
        let payload: { taskIds: Record<string, string>; blockedBy: Record<string, string[]> };
        try {
          const raw = resolveDataArg(parsed.data);
          if (typeof raw !== 'object' || raw === null) {
            throw new Error('--data must be a JSON object');
          }
          const obj = raw as Record<string, unknown>;
          if (typeof obj.taskIds !== 'object' || obj.taskIds === null) {
            throw new Error('--data.taskIds must be an object');
          }
          if (typeof obj.blockedBy !== 'object' || obj.blockedBy === null) {
            throw new Error('--data.blockedBy must be an object');
          }
          payload = {
            taskIds: obj.taskIds as Record<string, string>,
            blockedBy: obj.blockedBy as Record<string, string[]>,
          };
        } catch (err) {
          console.error(`Failed to parse --data: ${(err as Error).message}`);
          await log('register-task-graph', 'error', `parse-error: ${(err as Error).message}`);
          process.exit(1);
        }
        registerTaskGraph(projectDir, slug, payload);
        const refCount = Object.keys(payload.taskIds).length;
        const edgeCount = Object.values(payload.blockedBy).reduce((n, refs) => n + refs.length, 0);
        // Stats from the post-write state (merged with any prior entries).
        const postState = loadState(projectDir, slug);
        const knownRefs = postState ? Object.keys(postState.taskIds).length : refCount;
        const knownEdges = postState
          ? Object.values(postState.blockedBy).reduce((n, refs) => n + refs.length, 0)
          : edgeCount;
        // Derive ops from the post-write state so merged entries from prior
        // calls are covered, not just this call's payload.
        const ops = postState
          ? computeBlockedByOperations(postState.taskIds, postState.blockedBy)
          : computeBlockedByOperations(payload.taskIds, payload.blockedBy);
        await log('register_task_graph.write', 'info',
          `refCount=${refCount} edgeCount=${edgeCount} knownRefs=${knownRefs} knownEdges=${knownEdges} ops=${ops.length}`);
        const output: { registered: { refCount: number; edgeCount: number }; actions?: TaskAction[] } = {
          registered: { refCount, edgeCount },
        };
        if (ops.length > 0) {
          output.actions = [{ type: 'update_tasks', operations: ops }];
        }
        console.log(JSON.stringify(output));
        process.exit(0);
      }

      // ─── verify-task-graph: compare state.blockedBy to listUnits() ───
      if (action === 'verify-task-graph') {
        const slug = extractSlug(planPath);
        if (!slug) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          await log('task_graph.verify', 'error', `bad slug from ${path.basename(planPath)}`);
          process.exit(1);
        }
        const units = listUnits(projectDir, slug);
        const state = loadState(projectDir, slug);
        const { ok, diff } = verifyTaskGraph(units, state?.blockedBy ?? {});
        await log('task_graph.verify', ok ? 'allow' : 'warn',
          `ok=${ok} missing=${diff.missingRefs.length} extra=${diff.extraRefs.length} mismatched=${diff.mismatchedEdges.length} firstDiffs=${JSON.stringify([
            ...diff.missingRefs.slice(0, 2).map(r => ({ missing: r })),
            ...diff.extraRefs.slice(0, 2).map(r => ({ extra: r })),
            ...diff.mismatchedEdges.slice(0, 2),
          ]).slice(0, 500)}`);
        console.log(JSON.stringify({ ok, diff }, null, 2));
        process.exit(0);
      }

      // ─── compose_build_dispatch: compose prompt + reserve attempt ────
      if (action === 'compose_build_dispatch') {
        if (!parsed.data) {
          console.error('compose_build_dispatch requires --data <json|@path>');
          await log('compose_build_dispatch', 'error', 'missing --data');
          process.exit(1);
        }
        const slug = extractSlug(planPath);
        if (!slug) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          process.exit(1);
        }
        const data = resolveDataArg(parsed.data) as { unitId: number };
        if (typeof data.unitId !== 'number') {
          console.error('compose_build_dispatch: --data.unitId must be a number');
          process.exit(1);
        }
        try {
          const result = composeBuildDispatch(projectDir, slug, data.unitId);
          await log('compose_build_dispatch', 'info',
            `unit=${data.unitId} attempt=${result.attempt} priority=${result.priority}`);
          console.log(JSON.stringify(result, null, 2));
        } catch (err) {
          console.error(`compose_build_dispatch failed: ${(err as Error).message}`);
          await log('compose_build_dispatch', 'error', (err as Error).message);
          process.exit(1);
        }
        process.exit(0);
      }

      // ─── record_attempt_result: commit outcome, decide next action ──
      if (action === 'record_attempt_result') {
        if (!parsed.data) {
          console.error('record_attempt_result requires --data <json|@path>');
          await log('record_attempt_result', 'error', 'missing --data');
          process.exit(1);
        }
        const slug = extractSlug(planPath);
        if (!slug) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          process.exit(1);
        }
        const data = resolveDataArg(parsed.data) as RecordAttemptInput;
        try {
          const result = recordAttemptResultAction(projectDir, slug, data);
          await log('record_attempt_result', 'info',
            `unit=${data.unitId} outcome=${data.outcome} nextAction=${result.nextAction}`);
          console.log(JSON.stringify(result, null, 2));
        } catch (err) {
          console.error(`record_attempt_result failed: ${(err as Error).message}`);
          await log('record_attempt_result', 'error', (err as Error).message);
          process.exit(1);
        }
        process.exit(0);
      }

      // ─── record_review_result: commit review, mark done/retry/fail ──
      if (action === 'record_review_result') {
        if (!parsed.data) {
          console.error('record_review_result requires --data <json|@path>');
          await log('record_review_result', 'error', 'missing --data');
          process.exit(1);
        }
        const slug = extractSlug(planPath);
        if (!slug) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          process.exit(1);
        }
        const data = resolveDataArg(parsed.data) as RecordReviewInput;
        try {
          const result = await recordReviewResultAction(projectDir, slug, data, debug);
          await log('record_review_result', 'info',
            `unit=${data.unitId} passed=${data.passed} nextAction=${result.nextAction}`);
          console.log(JSON.stringify(result, null, 2));
        } catch (err) {
          console.error(`record_review_result failed: ${(err as Error).message}`);
          await log('record_review_result', 'error', (err as Error).message);
          process.exit(1);
        }
        process.exit(0);
      }

      // ─── next: standard state machine evaluation ─────────────────────
      // Read plan and log parsed state
      const content = fs.readFileSync(planPath, 'utf-8');
      const planData = parsePlanFile(content);
      await log('plan-parsed', 'info', `status=${planData.status} hasDiscovery=${planData.hasDiscovery} hasRequirements=${planData.hasRequirements} hasACs=${planData.hasACs} hasUATs=${planData.hasUATs} verdict=${planData.verdictValue ?? 'none'} units=${planData.unitCount}`);

      // Extract slug for state logging
      const slug = extractSlug(planPath) ?? 'unknown';

      // Log state load
      const existingState = loadState(projectDir, slug);
      if (existingState) {
        await log('state-loaded', 'info', `slug=${slug} status=${existingState.status} outerIter=${existingState.outerIteration} reviewIter=${existingState.reviewIteration} taskIds=${Object.keys(existingState.taskIds).length}`);
      } else {
        await log('state-created', 'info', `slug=${slug} fresh state from plan status=${planData.status}`);
      }

      // Check preconditions for logging (main() also checks, but we log here)
      const precondErr = checkPreconditions(planData.status!, planData, projectDir, slug);
      if (precondErr) {
        await log('precondition-fail', 'block', `status=${planData.status} error=${precondErr}`);
      } else {
        await log('precondition-pass', 'allow', `status=${planData.status}`);
      }

      // Run main
      const result = main(planPath, action);

      // Log each action in the result
      for (const act of result.actions) {
        switch (act.type) {
          case 'invoke_skill':
            await log('action-invoke', 'info', `skill=${act.skill} stage=${act.stageType}${act.unitId ? ` unit=${act.unitId}` : ''}`);
            break;
          case 'user_checkpoint':
            await log('action-checkpoint', 'info', `stage=${act.stage} approve→${act.approveStatus}`);
            break;
          case 'write_plan':
            await log('action-write-plan', 'info', `edits=${act.edits.length} targets=${act.edits.map(e => e.new_string.substring(0, 40)).join('; ')}`);
            break;
          case 'update_tasks':
            await log('action-update-tasks', 'info', act.operations.map(o =>
              o.action === 'update'
                ? `${o.ref}→${o.status}`
                : `${o.ref} blockedBy=[${o.blockedBy.join(',')}]`,
            ).join(', '));
            break;
          case 'done':
            await log('action-done', 'info', act.summary);
            break;
          case 'error':
            await log('action-error', 'error', act.message);
            break;
          case 'blocked':
            await log('action-blocked', 'block', `${act.reason}: ${act.preconditionError}`);
            break;
          case 'run_backpressure':
            await log('action-backpressure', 'info', `commands=${act.commands.length}`);
            break;
        }
      }

      // Log final state
      await log('state-saved', 'info', `status=${result.state.status} outerIter=${result.state.outerIteration} reviewIter=${result.state.reviewIteration}`);

      // Build-stage task-graph drift surfacing: include warnings in the JSON
      // so the orchestrator can show the user without making them re-run verify.
      let outputPayload: { actions: typeof result.actions; state: typeof result.state; warnings?: string[] } = result;
      if (result.state.status === 'build') {
        const units = listUnits(projectDir, slug);
        const { ok, diff } = verifyTaskGraph(units, result.state.blockedBy ?? {});
        if (!ok) {
          const warnings: string[] = [];
          if (diff.missingRefs.length > 0) {
            warnings.push(`Task graph missing ${diff.missingRefs.length} ref(s): ${diff.missingRefs.slice(0, 5).join(', ')}${diff.missingRefs.length > 5 ? '…' : ''}`);
          }
          if (diff.extraRefs.length > 0) {
            warnings.push(`Task graph has ${diff.extraRefs.length} stale ref(s): ${diff.extraRefs.slice(0, 5).join(', ')}${diff.extraRefs.length > 5 ? '…' : ''}`);
          }
          if (diff.mismatchedEdges.length > 0) {
            const sample = diff.mismatchedEdges.slice(0, 3).map(m =>
              `${m.ref} expected=[${m.expected.join(',')}] actual=[${m.actual.join(',')}]`,
            ).join('; ');
            warnings.push(`Task graph has ${diff.mismatchedEdges.length} mismatched edge(s): ${sample}${diff.mismatchedEdges.length > 3 ? '…' : ''}`);
          }
          outputPayload = { ...result, warnings };
          await log('task_graph.verify', 'warn',
            `ok=false missing=${diff.missingRefs.length} extra=${diff.extraRefs.length} mismatched=${diff.mismatchedEdges.length}`);
        }
      }

      // Console output for LLM
      console.log(JSON.stringify(outputPayload, null, 2));

      // Exit 1 if the result contains an error action
      const hasError = result.actions.some(a => a.type === 'error');
      if (hasError) process.exit(1);
    } catch (err) {
      if (err instanceof Error) {
        console.error(`[ralph-state-machine] Error: ${err.message}`);
        await vcpLog(projectDir || '.', { source: SRC, event: 'fatal', decision: 'error', details: err.message }, debug);
      } else {
        console.error('[ralph-state-machine] Unknown error:', err);
        await vcpLog(projectDir || '.', { source: SRC, event: 'fatal', decision: 'error', details: String(err) }, debug);
      }
      process.exit(2);
    }
  })();
}
