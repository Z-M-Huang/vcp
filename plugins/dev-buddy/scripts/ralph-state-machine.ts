import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { vcpLog, isDebugEnabled, capLogPayload } from './vcp-logger.ts';
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
  MechanicalContext, AttemptRecord, LatestAttemptState,
  ComposeBuildDispatchOutput, RecordAttemptInput, RecordAttemptOutput,
  RecordReviewInput, RecordReviewOutput,
} from './ralph/types.ts';
import { STATUS_TO_SKILL, STATUS_TO_STAGE_TYPE } from './ralph/types.ts';
import { parsePlanFile, parseUnitPlan, getNextBuildUnit, listUnits, detectUnitStateContradiction, overlayRuntimeStatus } from './ralph/parsers.ts';
import { loadState, saveState, registerTaskId, registerTaskGraph } from './ralph/state.ts';
import { ensureStateMigrated, scanOrphanStagingDirs } from './ralph/migrate.ts';
import { composeBuildDispatchPrompt } from './ralph/prompt-assembly.ts';
import { splitUnitFile } from './ralph/unit-file.ts';
import {
  readUnitState, ensurePlanStateSeeded, ensureUnitStateSeeded,
  reserveAttempt, commitAttemptResult, setReviewFeedback,
  markUnitDone, markUnitFailed, hashUnitFile, getUnitBuildContext,
  readPlanState, markPlanComplete, sweepCompletedPlans,
  isReservationStale, abandonReservation,
} from './ralph/unit-state.ts';

// ─── RETENTION SWEEP GATE (§9) ────────────────────────────────────────────

const SWEEP_MARKER_BASENAME = '.sweep.marker';
const DEFAULT_SWEEP_INTERVAL_HOURS = 24;

/**
 * Returns true when a sweep is due. The gate is a per-repo marker at
 * .vcp/plan/.state/.sweep.marker; no marker or an old one → due.
 */
function isSweepDue(projectDir: string, intervalHours: number): boolean {
  try {
    const markerPath = path.join(projectDir, '.vcp', 'plan', '.state', SWEEP_MARKER_BASENAME);
    const raw = fs.readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as { lastSweptAt?: string };
    if (!parsed.lastSweptAt) return true;
    const last = Date.parse(parsed.lastSweptAt);
    if (!Number.isFinite(last)) return true;
    return Date.now() - last > intervalHours * 3_600_000;
  } catch {
    return true;
  }
}

function touchSweepMarker(projectDir: string): void {
  try {
    const stateRoot = path.join(projectDir, '.vcp', 'plan', '.state');
    fs.mkdirSync(stateRoot, { recursive: true });
    const markerPath = path.join(stateRoot, SWEEP_MARKER_BASENAME);
    fs.writeFileSync(markerPath, JSON.stringify({ lastSweptAt: new Date().toISOString() }));
  } catch {
    // best-effort — next invocation will retry the sweep
  }
}

/**
 * Run a retention sweep when due, reading retention_days and
 * sweep_interval_hours from dev-buddy config. Silent no-op on errors.
 */
function maybeRunRetentionSweep(projectDir: string): void {
  let retentionDays = 7;
  let intervalHours = DEFAULT_SWEEP_INTERVAL_HOURS;
  try {
    const cfg = loadDevBuddyConfig() as unknown as { retention_days?: number; sweep_interval_hours?: number };
    if (typeof cfg.retention_days === 'number') retentionDays = cfg.retention_days;
    if (typeof cfg.sweep_interval_hours === 'number') intervalHours = cfg.sweep_interval_hours;
  } catch {
    // default values above
  }
  if (retentionDays === 0) return;
  if (!isSweepDue(projectDir, intervalHours)) return;
  try {
    sweepCompletedPlans(projectDir, { retentionDays });
    touchSweepMarker(projectDir);
  } catch {
    // sweep failures are non-fatal — a later run will retry
  }
}

/**
 * True when the unit-review stage has at least one executor configured.
 * When false, recordAttemptResultAction short-circuits mechanical_pass to
 * unit_done without dispatching a review stage. Defaults to false on config
 * read failure so we never dispatch a stage that would crash on zero executors.
 */
function isUnitReviewEnabled(): boolean {
  try {
    const config = loadDevBuddyConfig();
    const stage = config.stages['unit-review'];
    return !!stage && Array.isArray(stage.executors) && stage.executors.length > 0;
  } catch {
    return false;
  }
}

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
      // §10: unit-N.md is immutable post-decompose — runtime status lives in
      // .state/ralph-{slug}/units/unit-N.json. Read unit-state JSON, not markdown.
      const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
      let unitFiles: string[];
      try {
        unitFiles = fs.readdirSync(unitsDir).filter((f: string) => /^unit-\d+\.md$/.test(f));
      } catch {
        return null; // fail-open: units directory missing
      }
      const notDone: string[] = [];
      for (const f of unitFiles) {
        const idMatch = f.match(/^unit-(\d+)\.md$/);
        if (!idMatch) continue;
        const unitId = parseInt(idMatch[1], 10);
        const unitState = readUnitState(projectDir, slug, unitId);
        const unitStatus = unitState?.status ?? 'unknown';
        if (unitStatus !== 'done') {
          notDone.push(`${f}: ${unitStatus}`);
        }
      }
      if (notDone.length > 0) {
        return `Cannot start code review — ${notDone.length} unit(s) not done:\n` +
          notDone.map(u => `  - ${u}`).join('\n') + '\n' +
          'All units must reach status=done in units/unit-N.json.';
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
    'decompose-review': { next: 'plan_lint', heading: '## Units of Work' },
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
      const staticParsed = parseUnitPlan(content, id);
      // Overlay runtime status from units/unit-N.json. Unit-N.md is immutable
      // post-decompose (§10); its Status/Attempts header is stale after the
      // first BLR invocation. unit-N.json is the live truth.
      const parsed = overlayRuntimeStatus(staticParsed, projectDir, slug);
      return { content, parsed };
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

// ─── STUCK DETECTION (§4) ───────────────────────────────────────────────────

/**
 * Normalize stderr for stuck-detection comparison. Strips volatile byte-level
 * variance (timestamps, PIDs, memory addresses, line numbers, temp paths) so
 * that two attempts with the same root-cause failure produce the same hash
 * even when noisy details differ.
 *
 * Conservative: false negatives cost one wasted retry; false positives would
 * kill a unit that could recover. Add new patterns only from observed misses.
 */
export function normalizeStderr(s: string): string {
  return s
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<TS>')
    .replace(/\bpid[=: ]+\d+\b/gi, '<PID>')
    .replace(/\b0x[0-9a-f]{8,16}\b/gi, '<ADDR>')
    .replace(/\/tmp\/[^\s]+/g, '<TMP>')
    .replace(/\bline\s*\d+\b/gi, '<LN>')
    .replace(/:\d+:\d+/g, ':<L>:<C>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect whether the current mechanical failure is identical to the previous
 * one after normalization. Returns true when the same root failure repeated
 * (same command, same exit code, same normalized stderr).
 */
export function detectStuck(
  prev: MechanicalContext | undefined,
  curr: MechanicalContext,
): boolean {
  if (!prev) return false;
  if (prev.command !== curr.command || prev.exitCode !== curr.exitCode) return false;
  const prevStderr = (prev.stderrHead ?? '') + (prev.stderrTail ?? '');
  const currStderr = (curr.stderrHead ?? '') + (curr.stderrTail ?? '');
  return normalizeStderr(prevStderr) === normalizeStderr(currStderr);
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

// ─── SM BUILD ACTIONS (§2, §3 — single-attempt orchestration) ───────────────
// Three actions that move the retry loop out of BLR and into CC-driven SM calls:
//   compose_build_dispatch  — compose prompt, reserve attempt, return {prompt, lease}
//   record_attempt_result   — commit outcome, decide retry/stuck/fail/review
//   record_review_result    — commit review, mark done/retry/fail

/**
 * Compose the dispatch prompt for a build attempt and reserve the attempt slot.
 * Reads unit-N.md (static plan) + units/unit-N.json (feedback, mechanical ctx).
 * Seeds state if missing. Throws if unit is done/failed/exhausted.
 */
export function composeBuildDispatch(
  projectDir: string,
  slug: string,
  unitId: number,
): ComposeBuildDispatchOutput {
  const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
  const unitPath = path.join(unitsDir, `unit-${unitId}.md`);

  const ctx = getUnitBuildContext(projectDir, slug, unitId);
  if (!ctx) throw new Error(`composeBuildDispatch: unit ${unitId} file not found`);

  if (!ctx.state) {
    const parsed = parseUnitPlan(ctx.staticPlan, unitId);
    let maxAttempts = parsed.maxAttempts;
    try {
      const cfg = loadDevBuddyConfig();
      maxAttempts = Math.min(maxAttempts, cfg.max_build_attempts);
    } catch { /* keep parsed value */ }
    const plan = ensurePlanStateSeeded(projectDir, slug, 'build', 'sm-compose');
    ensureUnitStateSeeded(projectDir, slug, unitId, plan.decomposeRunId, maxAttempts, {
      status: parsed.status as 'pending' | 'done' | 'failed',
      attempts: parsed.attempts,
    });
  }

  let state = readUnitState(projectDir, slug, unitId)!;

  // §1.1 crash recovery: if a previous dispatch reserved an attempt but never
  // committed (CC crashed mid-dispatch), the reservation is stale. Abandon it
  // so a fresh attempt can proceed — the budget stays burned (attempts was
  // already incremented by the prior reserveAttempt).
  if (state.reservedAttempt && isReservationStale(state)) {
    abandonReservation(projectDir, slug, unitId, state.reservedAttempt.lease, 'stale_reservation');
    state = readUnitState(projectDir, slug, unitId)!;
  }

  if (state.status === 'done' || state.status === 'failed') {
    throw new Error(`composeBuildDispatch: unit ${unitId} is in terminal status '${state.status}'`);
  }
  if (state.attempts >= state.maxAttempts) {
    throw new Error(
      `composeBuildDispatch: unit ${unitId} has exhausted budget (${state.attempts}/${state.maxAttempts})`,
    );
  }

  let previousAttempt: LatestAttemptState | null = null;
  if (state.lastMechanicalContext) {
    previousAttempt = {
      attempt: state.attempts,
      dispatchEvent: null,
      dispatchError: null,
      backpressure: [],
      outcome: 'retry',
      mechanicalContext: state.lastMechanicalContext,
    };
  }

  const { staticPlan } = splitUnitFile(ctx.staticPlan);
  const reviewFeedback = state.reviewFeedback ?? '';
  const composed = composeBuildDispatchPrompt(staticPlan, reviewFeedback, previousAttempt, unitPath);

  const reservation = reserveAttempt(projectDir, slug, unitId, state.generation);

  return {
    prompt: composed.prompt,
    lease: reservation.lease,
    attempt: reservation.attempt,
    unitId,
    unitPath,
    priority: composed.priority,
    generation: reservation.newGeneration,
  };
}

/**
 * Record the outcome of a single build attempt. Commits to unit-N.json and
 * decides the next action for CC:
 *   mechanical_pass → dispatch_unit_review (reservation stays open)
 *   mechanical_fail → retry_unit | escalate_stuck | unit_failed
 *   dispatch_error  → retry_unit | unit_failed
 */
export function recordAttemptResultAction(
  projectDir: string,
  slug: string,
  data: RecordAttemptInput,
): RecordAttemptOutput {
  const unitState = readUnitState(projectDir, slug, data.unitId);
  if (!unitState) throw new Error(`recordAttemptResult: no state for unit ${data.unitId}`);

  if (data.outcome === 'mechanical_pass') {
    // If unit-review is disabled (no executors configured), skip straight to
    // marking the unit done. Otherwise dispatch the review stage.
    const unitReviewEnabled = isUnitReviewEnabled();
    if (!unitReviewEnabled) {
      const record: AttemptRecord = {
        attempt: unitState.attempts,
        timestamp: new Date().toISOString(),
        outcome: 'done',
        reviewPassed: true,
      };
      commitAttemptResult(projectDir, slug, data.unitId, data.lease, record, {
        identicalFailure: false,
        reviewFeedbackAfter: '',
      });
      markUnitDone(projectDir, slug, data.unitId, {
        passed: true,
        review: { ok: true },
      });
      return { nextAction: 'unit_done', unitId: data.unitId };
    }
    return {
      nextAction: 'dispatch_unit_review',
      unitId: data.unitId,
      lease: data.lease,
    };
  }

  const currMech = data.mechanicalContext ?? undefined;
  const prevMech = unitState.lastMechanicalContext;
  const identicalFailure = !!(currMech && prevMech && detectStuck(prevMech, currMech));
  const newIdenticalCount = identicalFailure ? unitState.identicalFailureCount + 1 : 0;
  const isStuck = newIdenticalCount >= 2;
  const isExhausted = unitState.attempts >= unitState.maxAttempts;

  const recordOutcome: AttemptRecord['outcome'] = isExhausted ? 'failed'
    : isStuck ? 'stuck'
    : 'retry';

  const record: AttemptRecord = {
    attempt: unitState.attempts,
    timestamp: new Date().toISOString(),
    outcome: recordOutcome,
    mechanicalContext: currMech,
  };

  commitAttemptResult(projectDir, slug, data.unitId, data.lease, record, {
    identicalFailure,
    mechanicalContextAfter: currMech,
  });

  if (isExhausted) {
    markUnitFailed(projectDir, slug, data.unitId, {
      attempts: unitState.attempts,
      maxAttempts: unitState.maxAttempts,
      reason: `attempt ${unitState.attempts}/${unitState.maxAttempts} exhausted`,
    });
    return { nextAction: 'unit_failed', unitId: data.unitId };
  }

  if (isStuck) {
    return {
      nextAction: 'escalate_stuck',
      unitId: data.unitId,
      identicalFailureCount: newIdenticalCount,
    };
  }

  return { nextAction: 'retry_unit', unitId: data.unitId };
}

/**
 * Record the outcome of a per-unit semantic review. Handles both pass (mark
 * done) and fail (persist feedback, check budget) paths. §11 log points for
 * review.feedback.cleared and review.needs_changes live here — the SM is the
 * single writer, so the log captures happen at the write boundary.
 */
export async function recordReviewResultAction(
  projectDir: string,
  slug: string,
  data: RecordReviewInput,
  debugEnabled: boolean,
): Promise<RecordReviewOutput> {
  const SRC = 'ralph-state-machine';
  const unitState = readUnitState(projectDir, slug, data.unitId);
  if (!unitState) throw new Error(`recordReviewResult: no state for unit ${data.unitId}`);

  if (data.passed) {
    if (unitState.reviewFeedback) {
      await vcpLog(projectDir, {
        source: SRC,
        event: 'review.feedback.cleared',
        decision: 'info',
        fsync: true,
        details: `slug=${slug} unit=${data.unitId} attempt=${unitState.attempts} ` +
          `reason=unit_passed_review\ncleared.tail: ${capLogPayload(unitState.reviewFeedback, 4 * 1024)}`,
      }, debugEnabled);
    }

    const record: AttemptRecord = {
      attempt: unitState.attempts,
      timestamp: new Date().toISOString(),
      outcome: 'done',
      reviewPassed: true,
    };
    commitAttemptResult(projectDir, slug, data.unitId, data.lease, record, {
      identicalFailure: false,
      reviewFeedbackAfter: '',
    });

    markUnitDone(projectDir, slug, data.unitId, {
      passed: true,
      review: { ok: true },
    });

    return { nextAction: 'unit_done', unitId: data.unitId };
  }

  // Review failed
  await vcpLog(projectDir, {
    source: SRC,
    event: 'review.needs_changes',
    decision: 'info',
    fsync: true,
    details: `slug=${slug} unit=${data.unitId} attempt=${unitState.attempts} ` +
      `feedbackBytes=${data.feedback.length}\nfeedback: ${capLogPayload(data.feedback)}`,
  }, debugEnabled);

  const unitFileHash = hashUnitFile(projectDir, slug, data.unitId) ?? '';
  setReviewFeedback(projectDir, slug, data.unitId, data.feedback, unitFileHash);

  const isExhausted = unitState.attempts >= unitState.maxAttempts;
  const record: AttemptRecord = {
    attempt: unitState.attempts,
    timestamp: new Date().toISOString(),
    outcome: isExhausted ? 'failed' : 'retry',
    reviewPassed: false,
  };
  commitAttemptResult(projectDir, slug, data.unitId, data.lease, record, {
    identicalFailure: false,
    reviewFeedbackAfter: data.feedback,
  });

  if (isExhausted) {
    markUnitFailed(projectDir, slug, data.unitId, {
      attempts: unitState.attempts,
      maxAttempts: unitState.maxAttempts,
      reason: `review failed, attempt ${unitState.attempts}/${unitState.maxAttempts} exhausted`,
    });
    return { nextAction: 'unit_failed', unitId: data.unitId };
  }

  return { nextAction: 'retry_unit', unitId: data.unitId };
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

      // ─── compose_build_dispatch: compose prompt + reserve attempt ────
      if (action === 'compose_build_dispatch') {
        if (!parsed.data) {
          console.error('compose_build_dispatch requires --data <json|@path>');
          await log('compose_build_dispatch', 'error', 'missing --data');
          process.exit(1);
        }
        const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
        if (!slugMatch) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          process.exit(1);
        }
        const data = resolveDataArg(parsed.data) as { unitId: number };
        if (typeof data.unitId !== 'number') {
          console.error('compose_build_dispatch: --data.unitId must be a number');
          process.exit(1);
        }
        try {
          const result = composeBuildDispatch(projectDir, slugMatch[1], data.unitId);
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
        const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
        if (!slugMatch) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          process.exit(1);
        }
        const data = resolveDataArg(parsed.data) as RecordAttemptInput;
        try {
          const result = recordAttemptResultAction(projectDir, slugMatch[1], data);
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
        const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
        if (!slugMatch) {
          console.error(`Cannot extract slug from: ${path.basename(planPath)}`);
          process.exit(1);
        }
        const data = resolveDataArg(parsed.data) as RecordReviewInput;
        try {
          const result = await recordReviewResultAction(projectDir, slugMatch[1], data, debug);
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
