import * as fs from 'fs';
import * as path from 'path';
import type {
  PlanStatus, PlanFileData, StateMachineState, StateMachineOutput,
  UnitPlanData, SkillAction, CheckpointAction, WritePlanAction,
  TaskAction, DoneAction, ErrorAction, BlockedAction,
} from './types.ts';
import { STATUS_TO_SKILL, STATUS_TO_STAGE_TYPE } from './types.ts';
import { parseUnitPlan, getNextBuildUnit, detectUnitStateContradiction, overlayRuntimeStatus } from './parsers.ts';
import { checkPreconditions } from './preconditions.ts';

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
  //
  // The action carries a ready-to-pass `askUserQuestion` payload whose shape
  // matches the AskUserQuestion tool's `questions` parameter. The orchestrator
  // is expected to forward it verbatim; shipping the pre-shaped payload keeps
  // the call site obvious instead of relying on SKILL.md prose.
  const REVIEW_STATUS_MAP: Record<string, {
    stage: 'discover' | 'requirements' | 'decompose';
    next: PlanStatus;
    reset: PlanStatus;
    heading: string;
    header: string;
    description: string;
  }> = {
    'discover-review': {
      stage: 'discover',
      next: 'requirements',
      reset: 'discover',
      heading: '## Discovery',
      header: 'Discover',
      description: 'Discovery synthesis is complete. The ## Discovery section has been written to the plan file.',
    },
    'requirements-review': {
      stage: 'requirements',
      next: 'decompose',
      reset: 'requirements',
      heading: '## Requirements',
      header: 'Requirements',
      description: 'Requirements synthesis is complete. The ## Requirements section (ACs + UATs) has been written to the plan file.',
    },
    'decompose-review': {
      stage: 'decompose',
      next: 'plan_lint',
      reset: 'decompose',
      heading: '## Units of Work',
      header: 'Decompose',
      description: 'Decomposition is complete. Unit plan files are under .vcp/plan/ralph/{SLUG}/unit-*.md and ## Units of Work is written to the plan.',
    },
  };
  const reviewConfig = REVIEW_STATUS_MAP[status];
  if (reviewConfig) {
    const description = reviewConfig.description.replace('{SLUG}', slug);
    const approveQ = `${description} Approve to advance to the ${reviewConfig.next} stage, or request changes to re-run ${reviewConfig.stage} with feedback?`;
    const feedbackQ = `What changes should the ${reviewConfig.stage} stage address? Pick an option, or use "Other" to type specific feedback that will be written to ## Feedback and injected as context on the re-run.`;
    return {
      actions: [{
        type: 'user_checkpoint',
        stage: reviewConfig.stage,
        sectionHeading: reviewConfig.heading,
        askUserQuestion: {
          questions: [{
            question: approveQ,
            header: reviewConfig.header,
            multiSelect: false,
            options: [
              { label: 'approve', description: `Accept ${reviewConfig.heading} and advance to the ${reviewConfig.next} stage.` },
              { label: 'request changes', description: `Provide feedback and re-run the ${reviewConfig.stage} stage.` },
            ],
          }],
        },
        approveStatus: reviewConfig.next,
        rejectStatus: reviewConfig.reset,
        feedbackQuestion: {
          questions: [{
            question: feedbackQ,
            header: 'Feedback',
            multiSelect: false,
            options: [
              { label: 'retry without feedback', description: 'Re-run the stage with no specific feedback (rarely useful — prefer typing feedback via Other).' },
              { label: 'abort pipeline', description: 'Stop the Ralph pipeline. No feedback is written.' },
            ],
          }],
        },
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
