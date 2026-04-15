import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';
import { loadDevBuddyConfig } from './pipeline-config.ts';

// Re-export submodules so existing callers (tests, skills, CLI) keep working
export * from './ralph/types.ts';
export { parsePlanFile, parseUnitPlan, getNextBuildUnit, listUnits, detectUnitStateContradiction } from './ralph/parsers.ts';
export { loadState, saveState, registerTaskId, registerTaskGraph } from './ralph/state.ts';

// Local imports for this file's logic
import type {
  PlanStatus, PlanFileData, UnitPlanData, StateMachineState, StateMachineOutput,
  Action, SkillAction, CheckpointAction, WritePlanAction, TaskAction,
  DoneAction, ErrorAction, BlockedAction, BackpressureResult, UnitListEntry,
} from './ralph/types.ts';
import { STATUS_TO_SKILL, STATUS_TO_STAGE_TYPE } from './ralph/types.ts';
import { parsePlanFile, parseUnitPlan, getNextBuildUnit, listUnits, detectUnitStateContradiction } from './ralph/parsers.ts';
import { loadState, saveState, registerTaskId, registerTaskGraph } from './ralph/state.ts';

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

// ─── PRECONDITION CHECKS ───────────────────────────────────────────────────

/**
 * Check stage-specific preconditions before entering a stage.
 * Returns null if preconditions pass, or a descriptive error string if they fail.
 *
 * Logic ported from ralph-stage-gate.ts (removed in v0.5.0):229-301, rewritten to use
 * structured PlanFileData instead of regex on raw content.
 */
export function checkPreconditions(
  status: PlanStatus,
  planData: PlanFileData,
  projectDir: string,
  slug: string,
): string | null {
  switch (status) {
    // Review gates have no additional preconditions — the prior stage already validated
    case 'discover-review':
    case 'requirements-review':
    case 'decompose-review':
      return null;

    case 'requirements':
      if (!planData.hasDiscovery) {
        return 'Discovery section is still pending. Complete discovery first.';
      }
      return null;

    case 'decompose':
      if (!planData.hasRequirements) {
        return 'Requirements section is still pending. Complete requirements first.';
      }
      if (!planData.hasACs) {
        return 'No acceptance criteria (AC-N) found in plan. Complete requirements first.';
      }
      if (!planData.hasUATs) {
        return 'No UAT scenarios (UAT-N) found in plan. Complete requirements first.';
      }
      return null;

    case 'build': {
      const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
      try {
        const units = fs.readdirSync(unitsDir).filter((f: string) => /^unit-\d+\.md$/.test(f));
        if (units.length === 0) {
          return `No unit plan files found in ${unitsDir}. Complete decompose first.`;
        }
        // Validate unit file structure — required sections must exist
        const requiredSections = [
          '### Entropy', '### Acceptance Criteria', '### Interface Contract',
          '### Test Stubs', '### What to Implement', '### Files to Touch',
          '### Backpressure', '### Done When',
        ];
        const missingSections: string[] = [];
        for (const f of units) {
          const content = fs.readFileSync(path.join(unitsDir, f), 'utf-8');
          for (const section of requiredSections) {
            // Accept both ### and ## heading levels
            const h3 = content.includes(section);
            const h2 = content.includes(section.replace('### ', '## '));
            if (!h3 && !h2) {
              missingSections.push(`${f}: missing "${section}"`);
            }
          }
        }
        if (missingSections.length > 0) {
          return `Unit plan files have missing required sections:\n` +
            missingSections.map(m => `  - ${m}`).join('\n') + '\n' +
            'Re-run decomposition to produce complete unit files.';
        }
      } catch {
        return `No unit plans directory found: ${unitsDir}. Complete decompose first.`;
      }
      return null;
    }

    case 'review': {
      const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
      try {
        const unitFiles = fs.readdirSync(unitsDir).filter((f: string) => /^unit-\d+\.md$/.test(f));
        const notDone: string[] = [];
        for (const f of unitFiles) {
          const unitContent = fs.readFileSync(path.join(unitsDir, f), 'utf-8');
          const unitStatusMatch = unitContent.match(/\*\*Status:\*\*\s*(\S+)/);
          const unitStatus = unitStatusMatch ? unitStatusMatch[1].toLowerCase() : 'unknown';
          if (unitStatus !== 'done') {
            notDone.push(`${f}: ${unitStatus}`);
          }
        }
        if (notDone.length > 0) {
          return `Cannot start code review — ${notDone.length} unit(s) not done:\n` +
            notDone.map(u => `  - ${u}`).join('\n') + '\n' +
            'All units must have **Status:** done.';
        }
      } catch {
        // fail-open: can't read units directory
      }
      return null;
    }

    case 'uat':
      if (!planData.hasVerdict || planData.verdictValue !== 'approved') {
        return 'No code review approval found. Complete code review first.';
      }
      return null;

    default:
      return null;
  }
}

// ─── COMPUTE NEXT ACTION ──────────────────────────────────────────────────

/**
 * Determine the next action based on current state and plan data.
 * Pure function — caller is responsible for applying the returned actions.
 *
 * Forward transitions: discover→requirements→decompose→build→review→uat→done.
 * Returns BlockedAction when preconditions fail, DoneAction when status is 'done',
 * ErrorAction for unknown status, or SkillAction for valid forward transitions.
 */
export function computeNextAction(
  state: StateMachineState,
  planData: PlanFileData,
  projectDir: string,
  config: { max_iterations: number; max_build_attempts: number; max_outer_iterations: number },
): StateMachineOutput {
  const { status, slug } = state;

  // Done — nothing to do
  if (status === 'done') {
    return {
      actions: [{ type: 'done', summary: `Pipeline complete for ${slug}.` } as DoneAction],
      state,
    };
  }

  // ─── Review gates ──────────────────────────────────────────────────────
  // Emit user_checkpoint for approval before advancing to the next stage.
  // MUST come before the unknown-status guard since review statuses have no skill mapping.
  const REVIEW_STATUS_MAP: Record<string, { next: PlanStatus; heading: string }> = {
    'discover-review': { next: 'requirements', heading: '## Discovery' },
    'requirements-review': { next: 'decompose', heading: '## Requirements' },
    'decompose-review': { next: 'build', heading: '## Units of Work' },
  };
  const reviewConfig = REVIEW_STATUS_MAP[status];
  if (reviewConfig) {
    return {
      actions: [{
        type: 'user_checkpoint',
        stage: status.replace('-review', ''),
        sectionHeading: reviewConfig.heading,
        present: `Review the ${reviewConfig.heading} section in the plan file.`,
        question: `Approve to proceed to ${reviewConfig.next}, or request changes to re-run.`,
        options: ['approve', 'request changes'],
        approveStatus: reviewConfig.next,
      } as CheckpointAction],
      state,
    };
  }

  // Unknown status — error
  const skill = STATUS_TO_SKILL[status];
  const stageType = STATUS_TO_STAGE_TYPE[status];
  if (!skill || !stageType) {
    return {
      actions: [{ type: 'error', message: `Unknown status: ${status}` } as ErrorAction],
      state,
    };
  }

  // Precondition gate
  const preconditionError = checkPreconditions(status, planData, projectDir, slug);
  if (preconditionError !== null) {
    return {
      actions: [{
        type: 'blocked',
        reason: `Preconditions not met for ${status}`,
        preconditionError,
      } as BlockedAction],
      state,
    };
  }

  // ─── Review verdict branching ──────────────────────────────────────────
  // When a verdict exists in review stage, branch on its value:
  //   needs_changes → loop back to build (write verdict, then status)
  //   approved      → forward transition to uat
  //   no verdict    → fall through to invoke review skill
  if (status === 'review' && planData.hasVerdict && planData.verdictValue) {
    if (planData.verdictValue === 'needs_changes') {
      // Guard: max review iterations exhausted
      if (state.reviewIteration >= config.max_iterations) {
        return {
          actions: [{ type: 'error', message: `Max review iterations (${config.max_iterations}) exhausted for ${slug}.` } as ErrorAction],
          state,
        };
      }

      // Write verdict FIRST, then status change (F-6: write order enforced)
      const writePlan: WritePlanAction = {
        type: 'write_plan',
        edits: [
          { old_string: '**Verdict:** needs_changes', new_string: '**Verdict:** (cleared — loop-back)' },
          { old_string: '**Status:** review', new_string: '**Status:** build' },
        ],
      };

      return {
        actions: [writePlan],
        state: { ...state, reviewIteration: state.reviewIteration + 1 },
      };
    }

    if (planData.verdictValue === 'approved') {
      // Forward transition to uat
      return {
        actions: [{
          type: 'invoke_skill',
          skill: STATUS_TO_SKILL['uat'],
          stageType: STATUS_TO_STAGE_TYPE['uat'],
          slug,
        } as SkillAction],
        state,
      };
    }
  }

  // ─── UAT pass/fail branching ────────────────────────────────────────────
  // When UAT results exist (definedUATIds > 0), check pass/fail:
  //   all pass  → write results + status→done, then DoneAction
  //   any fail  → guard max_outer_iterations, write results + status→build, increment outerIteration
  //   no results yet → fall through to invoke UAT skill
  if (status === 'uat' && planData.definedUATIds.length > 0) {
    const allPassed = planData.definedUATIds.every(id => planData.passedUATIds.includes(id));

    if (allPassed) {
      // All UATs pass — write results then mark done
      const writePlan: WritePlanAction = {
        type: 'write_plan',
        edits: [
          { old_string: '**Status:** uat', new_string: '**Status:** done' },
        ],
      };
      return {
        actions: [writePlan, { type: 'done', summary: `All UATs passed for ${slug}.` } as DoneAction],
        state: { ...state, status: 'done' as PlanStatus },
      };
    }

    // Some UATs failed — guard max outer iterations
    if (state.outerIteration >= config.max_outer_iterations) {
      return {
        actions: [{ type: 'error', message: `Max outer iterations (${config.max_outer_iterations}) exhausted for ${slug}.` } as ErrorAction],
        state,
      };
    }

    // Loop back to build — write results then status→build
    const writePlan: WritePlanAction = {
      type: 'write_plan',
      edits: [
        { old_string: '**Verdict:** approved', new_string: '**Verdict:** (cleared — UAT loop-back)' },
        { old_string: '**Status:** uat', new_string: '**Status:** build' },
      ],
    };
    return {
      actions: [writePlan],
      state: { ...state, outerIteration: state.outerIteration + 1 },
    };
  }

  // ─── Build: unit-specific dispatch ────────────────────────────────────
  // For build status, resolve the next eligible unit and include its ID/path
  // in the SkillAction so the orchestrator dispatches the correct unit.
  if (status === 'build') {
    const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
    let unitFiles: string[];
    try {
      unitFiles = fs.readdirSync(unitsDir).filter((f: string) => /^unit-\d+\.md$/.test(f));
    } catch {
      return {
        actions: [{ type: 'blocked', reason: 'No units directory', preconditionError: `Cannot read ${unitsDir}` } as BlockedAction],
        state,
      };
    }

    const parsedUnits = unitFiles.map(f => {
      const id = parseInt(f.match(/unit-(\d+)\.md/)![1], 10);
      const content = fs.readFileSync(path.join(unitsDir, f), 'utf-8');
      return { content, parsed: parseUnitPlan(content, id) };
    }).sort((a, b) => a.parsed.id - b.parsed.id);

    const units: UnitPlanData[] = parsedUnits.map(u => u.parsed);
    const nextUnit = getNextBuildUnit(units);

    if (!nextUnit) {
      // All units done → transition to review
      const allDone = units.every(u => u.status === 'done');
      if (allDone) {
        // Guard against header/tail contradictions (e.g. status=done but
        // latest attempt outcome=failed). Refuse to promote on stale lies;
        // operator must resolve the unit file or re-run build.
        const contradictions = parsedUnits
          .map(u => ({ id: u.parsed.id, issue: detectUnitStateContradiction(u.content) }))
          .filter((c): c is { id: number; issue: string } => c.issue !== null);
        if (contradictions.length > 0) {
          const summary = contradictions.map(c => `unit-${c.id}: ${c.issue}`).join('; ');
          return {
            actions: [{
              type: 'blocked',
              reason: 'Inconsistent unit state — refusing to advance build→review',
              preconditionError: summary,
            } as BlockedAction],
            state,
          };
        }
        const writePlan: WritePlanAction = {
          type: 'write_plan',
          edits: [
            { old_string: '**Status:** build', new_string: '**Status:** review' },
          ],
        };
        const taskAction: TaskAction = {
          type: 'update_tasks',
          operations: [
            { action: 'update', ref: 'stage:build', status: 'completed' },
            { action: 'update', ref: 'stage:review', status: 'in_progress' },
          ],
        };
        return {
          actions: [writePlan, taskAction],
          state: { ...state, status: 'review' as PlanStatus },
        };
      }
      // Some units blocked/failed — escalate
      const failed = units.filter(u => u.status === 'failed');
      const pending = units.filter(u => u.status === 'pending');
      return {
        actions: [{
          type: 'blocked',
          reason: 'No eligible unit to build',
          preconditionError: `${failed.length} failed, ${pending.length} pending (blocked by dependencies)`,
        } as BlockedAction],
        state,
      };
    }

    // Dispatch build for the specific unit
    const taskAction: TaskAction = {
      type: 'update_tasks',
      operations: [
        { action: 'update', ref: `unit:${nextUnit.id}`, status: 'in_progress' },
      ],
    };
    return {
      actions: [
        taskAction,
        {
          type: 'invoke_skill',
          skill,
          stageType,
          slug,
          unitId: nextUnit.id,
          unitPath: path.join(unitsDir, `unit-${nextUnit.id}.md`),
        } as SkillAction,
      ],
      state,
    };
  }

  // Forward transition — invoke the mapped skill (discover, requirements, decompose, review, uat)
  const taskAction: TaskAction = {
    type: 'update_tasks',
    operations: [
      { action: 'update', ref: `stage:${status}`, status: 'in_progress' },
    ],
  };
  return {
    actions: [
      taskAction,
      {
        type: 'invoke_skill',
        skill,
        stageType,
        slug,
      } as SkillAction,
    ],
    state,
  };
}

// ─── BACKPRESSURE EXECUTION ──────────────────────────────────────────────────

/**
 * Run backpressure commands as child processes via spawnSync.
 * Each command runs sequentially in the given cwd.
 * Returns one BackpressureResult per command with passed=true iff exitCode===0.
 */
export function runBackpressure(commands: string[], cwd: string): BackpressureResult[] {
  const results: BackpressureResult[] = [];
  for (const command of commands) {
    const result = spawnSync('sh', ['-c', command], {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    results.push({
      command,
      exitCode: result.status ?? 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      passed: result.status === 0,
    });
  }
  return results;
}

// ─── TASK GRAPH VERIFICATION ────────────────────────────────────────────────

/** Structured diff between expected and actual task-graph edges. */
export interface TaskGraphDiff {
  /** Unit refs missing entirely from state.blockedBy. */
  missingRefs: string[];
  /** Refs present in state.blockedBy but absent from the current unit list. */
  extraRefs: string[];
  /** Refs where state.blockedBy[ref] does not match the expected edges. */
  mismatchedEdges: Array<{ ref: string; expected: string[]; actual: string[] }>;
}

/** Pure-function core of verify-task-graph. Compares expected edges to state. */
export function verifyTaskGraph(
  expected: UnitListEntry[],
  stateBlockedBy: Record<string, string[]>,
): { ok: boolean; diff: TaskGraphDiff } {
  const missingRefs: string[] = [];
  const mismatchedEdges: Array<{ ref: string; expected: string[]; actual: string[] }> = [];
  const expectedRefs = new Set(expected.map(e => e.ref));

  for (const entry of expected) {
    const actual = stateBlockedBy[entry.ref];
    if (actual === undefined) {
      missingRefs.push(entry.ref);
      continue;
    }
    const expectedSorted = [...entry.blockedByRefs].sort();
    const actualSorted = [...actual].sort();
    if (JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)) {
      mismatchedEdges.push({
        ref: entry.ref,
        expected: entry.blockedByRefs,
        actual,
      });
    }
  }

  const extraRefs = Object.keys(stateBlockedBy).filter(ref =>
    ref.startsWith('unit:') && !expectedRefs.has(ref),
  );

  const ok = missingRefs.length === 0 && extraRefs.length === 0 && mismatchedEdges.length === 0;
  return { ok, diff: { missingRefs, extraRefs, mismatchedEdges } };
}

// ─── CLI ENTRY POINT ─────────────────────────────────────────────────────────

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
        const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
        if (!slugMatch) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          await log('list-units', 'error', `bad slug from ${path.basename(planPath)}`);
          process.exit(1);
        }
        const units = listUnits(projectDir, slugMatch[1]);
        await log('list-units', 'info', `slug=${slugMatch[1]} units=${units.length} statuses=${units.map(u => `${u.id}:${u.status}`).join(',')}`);
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
        const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
        if (!slugMatch) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          await log('register-task', 'error', `bad slug from ${path.basename(planPath)}`);
          process.exit(1);
        }
        registerTaskId(projectDir, slugMatch[1], parsed.ref, parsed.taskId);
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
        const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
        if (!slugMatch) {
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
        registerTaskGraph(projectDir, slugMatch[1], payload);
        const refCount = Object.keys(payload.taskIds).length;
        const edgeCount = Object.values(payload.blockedBy).reduce((n, refs) => n + refs.length, 0);
        // Stats from the post-write state (merged with any prior entries).
        const postState = loadState(projectDir, slugMatch[1]);
        const knownRefs = postState ? Object.keys(postState.taskIds).length : refCount;
        const knownEdges = postState
          ? Object.values(postState.blockedBy).reduce((n, refs) => n + refs.length, 0)
          : edgeCount;
        await log('register_task_graph.write', 'info',
          `refCount=${refCount} edgeCount=${edgeCount} knownRefs=${knownRefs} knownEdges=${knownEdges}`);
        console.log(JSON.stringify({ registered: { refCount, edgeCount } }));
        process.exit(0);
      }

      // ─── verify-task-graph: compare state.blockedBy to listUnits() ───
      if (action === 'verify-task-graph') {
        const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
        if (!slugMatch) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          await log('task_graph.verify', 'error', `bad slug from ${path.basename(planPath)}`);
          process.exit(1);
        }
        const units = listUnits(projectDir, slugMatch[1]);
        const state = loadState(projectDir, slugMatch[1]);
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

      // ─── next: standard state machine evaluation ─────────────────────
      // Read plan and log parsed state
      const content = fs.readFileSync(planPath, 'utf-8');
      const planData = parsePlanFile(content);
      await log('plan-parsed', 'info', `status=${planData.status} hasDiscovery=${planData.hasDiscovery} hasRequirements=${planData.hasRequirements} hasACs=${planData.hasACs} hasUATs=${planData.hasUATs} verdict=${planData.verdictValue ?? 'none'} units=${planData.unitCount}`);

      // Extract slug for state logging
      const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
      const slug = slugMatch ? slugMatch[1] : 'unknown';

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
