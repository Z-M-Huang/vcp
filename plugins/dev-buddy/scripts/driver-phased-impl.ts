/**
 * Pipeline driver — phased implementation sub-state machine.
 */

import fs from 'fs';
import path from 'path';

import {
  sanitizeForFilename,
} from '../types/stage-definitions.ts';
import { loadPipelineConfig } from './pipeline-config.ts';
import { readPresets } from './preset-utils.ts';
import type { PipelineCommand } from '../types/commands.ts';
import { makeCommandId } from '../types/commands.ts';
import type {
  PipelineState,
  StageState,
} from '../types/driver-state.ts';
import type { PhaseRouter } from './driver-phases.ts';
import {
  getTaskPath,
  writeTempFile,
  writePipelineTasks,
  buildPipelineTasksJson,
  emitCommand,
  range,
} from './driver-state-io.ts';
import { findBackgroundTaskForStage } from './driver-main-loop.ts';

// ─── Phase: Phased Implementation ───────────────────────────────────────────

export function handlePhasedImplementation(state: PipelineState, cwd: string, routeByPhase?: PhaseRouter): PipelineCommand {
  const ps = state.phased_state;
  if (!ps) {
    return emitCommand(state, {
      action: 'escalate',
      error: 'Phased implementation state is null.',
      context: 'Phased implementation phase',
    });
  }

  const implStage = state.stages[ps.impl_stage_index];
  if (!implStage) {
    return emitCommand(state, {
      action: 'escalate',
      error: `Implementation stage at index ${ps.impl_stage_index} not found.`,
      context: 'Phased implementation phase',
    });
  }

  switch (state.step) {
    case 0: {
      // P0: Prepare directories and read plan step count
      state.step = 1;
      return emitCommand(state, {
        action: 'read_file',
        path: getTaskPath(cwd, 'plan/manifest.json'),
      });
    }

    case 1: {
      // P1: step count was read from report. Check for partial progress.
      if (ps.total_steps === 0) {
        return emitCommand(state, {
          action: 'escalate',
          error: 'Plan manifest has no step_count. Cannot run phased implementation.',
          context: 'Phased implementation P0',
        });
      }

      if (ps.current_step > ps.total_steps) {
        // All steps done — aggregate
        state.step = 10; // aggregation step
        return handlePhasedAggregation(state, cwd);
      }

      // Dispatch implementer for current step
      state.step = 2;
      return dispatchPhasedStep(state, cwd, implStage);
    }

    case 2: {
      // P2a: Step implementation dispatched, waiting for completion.
      // For API providers, wait for background task before advancing.
      if (implStage.providerType === 'api') {
        const bgTaskId = findBackgroundTaskForStage(state, implStage.index);
        if (bgTaskId) {
          // Background task still running — wait for it
          return emitCommand(state, {
            action: 'wait_for_task',
            task_id: bgTaskId,
            timeout_ms: 600000,
            poll_on_still_running: true,
            max_poll_attempts: 3,
          });
        }
      }

      // After report, check batch boundary.
      const stepsInBatch = ps.current_step - ps.batch_start + 1;
      const isBatchComplete = stepsInBatch >= ps.review_interval || ps.current_step >= ps.total_steps;

      if (!isBatchComplete) {
        // Mid-batch: advance to next step
        ps.current_step++;
        state.step = 1;
        return emitCommand(state, {
          action: 'noop',
          message: `Step ${ps.current_step - 1} implemented. Mid-batch — continuing to step ${ps.current_step}.`,
        });
      }

      // Batch complete — dispatch reviewers
      ps.batch_end = ps.current_step;
      ps.last_review_approved = true; // Reset before each review cycle
      state.step = 3;
      return dispatchPhasedReviewers(state, cwd);
    }

    case 3: {
      // P2c: Reviewers dispatched. Read review output files to check verdicts.
      const config = loadPipelineConfig();
      const pipelineCfg = state.pipeline === 'feature' ? config.feature_pipeline : config.bugfix_pipeline;
      const implEntry = pipelineCfg.find(e => e.type === 'implementation');
      const expectedReviewerCount = (implEntry?.phased_reviews || []).length;
      const reviewFiles = getPhasedReviewFiles(state, cwd);

      if (reviewFiles.length < expectedReviewerCount) {
        // Not all reviewers have submitted — wait
        return emitCommand(state, {
          action: 'noop',
          message: `Waiting for phased review results (${reviewFiles.length}/${expectedReviewerCount}).`,
        });
      }

      // Read review outputs to check status
      const readCmds: PipelineCommand[] = reviewFiles.map(f => ({
        command_id: makeCommandId(),
        state_version: state.state_version,
        action: 'read_file' as const,
        path: f,
      }));

      state.step = 30; // Intermediate step: process read results
      if (readCmds.length === 1) {
        return emitCommand(state, readCmds[0]);
      }
      return emitCommand(state, {
        action: 'parallel_batch',
        commands: readCmds,
      });
    }

    case 30: {
      // P2c-continued: Review files were read by report handler. Check verdicts.
      const allApproved = ps.last_review_approved ?? true;
      if (allApproved) {
        state.step = 4; // Batch approved
      } else {
        state.step = 5; // Needs changes
      }
      if (routeByPhase) return routeByPhase(state, cwd);
      return handlePhasedImplementation(state, cwd, routeByPhase);
    }

    case 4: {
      // P2d: Batch approved — update progress
      ps.completed_steps.push(...range(ps.batch_start, ps.batch_end));
      ps.last_reviewed_step = ps.batch_end;
      ps.batch_start = ps.batch_end + 1;
      ps.current_step = ps.batch_end + 1;
      ps.iteration_count = 0;

      // Update pipeline-tasks.json with step_progress
      updateStepProgress(state, cwd);

      if (ps.current_step > ps.total_steps) {
        // All steps done — aggregate
        state.step = 10;
        return handlePhasedAggregation(state, cwd);
      }

      // Continue to next step
      state.step = 1;
      return emitCommand(state, {
        action: 'noop',
        message: `Batch [${ps.batch_start - (ps.batch_end - ps.batch_start + 1)}-${ps.batch_end}] approved. Continuing to step ${ps.current_step}.`,
      });
    }

    case 5: {
      // P2e: needs_changes — dispatch fix
      ps.iteration_count++;
      if (ps.iteration_count >= ps.max_iterations) {
        // P2f: Escalation
        state.step = 6;
        return emitCommand(state, {
          action: 'ask_user',
          question: `Batch steps ${ps.batch_start}-${ps.batch_end} has failed phased review ${ps.max_iterations} times. How to proceed?`,
          options: [
            { label: 'Take over manually', description: 'Resolve the issues yourself, then continue' },
            { label: 'Abort pipeline', description: 'Stop execution entirely' },
          ],
          context: 'Phased implementation escalation',
        });
      }

      // Dispatch fix for affected steps
      state.step = 7;
      return dispatchPhasedFix(state, cwd, implStage);
    }

    case 6: {
      // User chose after escalation
      state.paused = true;
      state.pause_reason = 'Waiting for user to resolve phased review failure.';
      return emitCommand(state, {
        action: 'pause',
        reason: state.pause_reason,
        resume_condition: 'User must resolve issues and explicitly continue.',
      });
    }

    case 7: {
      // Fix dispatched — re-review
      ps.last_review_approved = true; // Reset before re-review cycle
      state.step = 3;
      return dispatchPhasedReviewers(state, cwd);
    }

    case 10: {
      // Aggregation
      return handlePhasedAggregation(state, cwd);
    }

    default:
      return emitCommand(state, {
        action: 'escalate',
        error: `Unexpected phased step: ${state.step}`,
        context: 'Phased implementation phase',
      });
  }
}

function dispatchPhasedStep(state: PipelineState, cwd: string, implStage: StageState): PipelineCommand {
  const ps = state.phased_state!;
  const promptContent = [
    `SINGLE_STEP_MODE: step ${ps.current_step}`,
    `PLAN STEP: .vcp/task/plan/steps/${ps.current_step}.json`,
    `OUTPUT: .vcp/task/impl-steps/impl-step-${ps.current_step}-v1.json`,
    `OVERALL GOAL: Read .vcp/task/user-story/meta.json for ${state.pipeline === 'feature' ? 'feature' : 'bug fix'} context`,
    `PLAN OVERVIEW: Read .vcp/task/plan/manifest.json for architecture decisions`,
    `NOTE: Implement ONLY step ${ps.current_step}. Do NOT touch prior or future steps.`,
  ].join('\n');

  const promptFile = writeTempFile(cwd, `phased-impl-step-${ps.current_step}`, makeCommandId(), promptContent);

  switch (implStage.providerType) {
    case 'subscription':
      return emitCommand(state, {
        action: 'spawn_agent',
        subagent_type: 'dev-buddy:implementer',
        name: `implementer-step-${ps.current_step}`,
        model: implStage.model,
        prompt_file: promptFile,
      });

    case 'api':
      return emitCommand(state, {
        action: 'spawn_background',
        command: buildPhasedApiCommand(implStage, cwd),
        timeout_ms: 300000,
        stage_index: implStage.index,
      });

    case 'cli':
      return emitCommand(state, {
        action: 'spawn_agent',
        subagent_type: 'dev-buddy:cli-executor',
        name: `cli-impl-step-${ps.current_step}`,
        prompt_file: promptFile,
      });

    default:
      return emitCommand(state, {
        action: 'escalate',
        error: `Unknown provider type for phased implementation: ${implStage.providerType}`,
        context: `Phased step ${ps.current_step}`,
      });
  }
}

/** Build API task runner command for phased steps (non-review). */
function buildPhasedApiCommand(stage: StageState, cwd: string): string {
  const pluginRoot = path.dirname(import.meta.dir);
  const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

  return [
    `bun`,
    esc(path.join(pluginRoot, 'scripts', 'api-task-runner.ts')),
    `--preset ${esc(stage.provider)}`,
    `--model ${esc(stage.model)}`,
    `--cwd ${esc(cwd)}`,
    `--task-timeout 300000`,
    `--task-stdin`,
  ].join(' ');
}

function dispatchPhasedReviewers(state: PipelineState, cwd: string): PipelineCommand {
  const ps = state.phased_state!;
  const config = loadPipelineConfig();
  const pipeline = state.pipeline === 'feature'
    ? config.feature_pipeline
    : config.bugfix_pipeline;
  const implEntry = pipeline.find(e => e.type === 'implementation');
  const reviewers = implEntry?.phased_reviews || [];

  if (reviewers.length === 0) {
    // No reviewers — auto-approve
    state.step = 4;
    return emitCommand(state, {
      action: 'noop',
      message: 'No phased reviewers configured. Auto-approving batch.',
    });
  }

  // Build reviewer dispatch commands
  const reviewCmds: PipelineCommand[] = reviewers.map(pr => {
    const preset = readPresets().presets[pr.provider];
    const providerType = preset ? preset.type as string : 'subscription';
    const reviewVersion = (ps.per_reviewer_versions[`${pr.provider}-${pr.model}`] || 0) + 1;
    ps.per_reviewer_versions[`${pr.provider}-${pr.model}`] = reviewVersion;

    const promptContent = [
      `AGENT: dev-buddy:phased-reviewer (model: ${pr.model}, provider: ${pr.provider})`,
      ps.review_interval === 1
        ? `PLAN STEP: .vcp/task/plan/steps/${ps.current_step}.json`
        : `PLAN STEPS: .vcp/task/plan/steps/${ps.batch_start}.json ... steps/${ps.batch_end}.json`,
      ps.review_interval === 1
        ? `IMPL STEP: .vcp/task/impl-steps/impl-step-${ps.current_step}-v1.json`
        : `IMPL STEPS: .vcp/task/impl-steps/impl-step-${ps.batch_start}-v1.json ... impl-step-${ps.batch_end}-v1.json`,
      `OUTPUT: .vcp/task/phased-reviews/phased-review-${sanitizeForFilename(pr.provider)}-${sanitizeForFilename(pr.model)}-step-${ps.batch_end}-v${reviewVersion}.json`,
      `NOTE: Review steps ${ps.batch_start} through ${ps.batch_end}.`,
    ].join('\n');

    const promptFile = writeTempFile(cwd, `phased-review-${pr.provider}-${pr.model}`, makeCommandId(), promptContent);

    return {
      command_id: makeCommandId(),
      state_version: state.state_version,
      action: 'spawn_agent' as const,
      subagent_type: providerType === 'cli' ? 'dev-buddy:cli-executor' : 'dev-buddy:phased-reviewer',
      name: `phased-reviewer-${pr.provider}-${pr.model}`,
      model: providerType === 'cli' ? undefined : pr.model,
      prompt_file: promptFile,
    };
  });

  if (reviewCmds.length === 1) {
    return emitCommand(state, reviewCmds[0]);
  }

  // Map sub-command IDs → reviewer indices for post-iteration missing-result detection
  const reviewMapping: Record<string, number> = {};
  reviewCmds.forEach((cmd, idx) => { reviewMapping[cmd.command_id] = idx; });
  state.batch_cmd_to_stage = reviewMapping;

  return emitCommand(state, {
    action: 'parallel_batch',
    commands: reviewCmds,
  });
}

export function getPhasedReviewFiles(state: PipelineState, cwd: string): string[] {
  const ps = state.phased_state;
  if (!ps) return [];
  const config = loadPipelineConfig();
  const pipeline = state.pipeline === 'feature' ? config.feature_pipeline : config.bugfix_pipeline;
  const implEntry = pipeline.find(e => e.type === 'implementation');
  const reviewers = implEntry?.phased_reviews || [];

  return reviewers.map(pr => {
    const version = ps.per_reviewer_versions[`${pr.provider}-${pr.model}`] || 1;
    return getTaskPath(cwd,
      `phased-reviews/phased-review-${sanitizeForFilename(pr.provider)}-${sanitizeForFilename(pr.model)}-step-${ps.batch_end}-v${version}.json`
    );
  }).filter(f => fs.existsSync(f));
}

function dispatchPhasedFix(state: PipelineState, cwd: string, implStage: StageState): PipelineCommand {
  const ps = state.phased_state!;
  // Dispatch fix for each step in the batch
  const promptContent = [
    `SINGLE_STEP_MODE: fix steps ${ps.batch_start}-${ps.batch_end}`,
    `ISSUES FROM PRIOR REVIEW: See phased-reviews/ for details`,
    `OUTPUT: Updated impl-step files with incremented versions`,
    `NOTE: Fix ONLY the issues identified in the review.`,
  ].join('\n');

  const promptFile = writeTempFile(cwd, `phased-fix-batch`, makeCommandId(), promptContent);

  return emitCommand(state, {
    action: 'spawn_agent',
    subagent_type: 'dev-buddy:implementer',
    name: `implementer-fix-batch-${ps.batch_start}-${ps.batch_end}`,
    model: implStage.model,
    prompt_file: promptFile,
  });
}

function handlePhasedAggregation(state: PipelineState, cwd: string): PipelineCommand {
  const ps = state.phased_state!;
  // Write aggregated impl-result.json
  const resultContent = JSON.stringify({
    status: 'complete',
    steps_completed: ps.total_steps,
    phased: true,
    notes: `Aggregated from ${ps.total_steps} per-step implementations`,
    completed_at: new Date().toISOString(),
  }, null, 2);

  const contentFile = writeTempFile(cwd, 'impl-result', makeCommandId(), resultContent);

  // Mark implementation stage as complete
  const implStage = state.stages[ps.impl_stage_index];
  if (implStage) {
    implStage.status = 'completed';
  }

  // Transition back to main loop
  state.phased_state = null;
  state.phase = 'main_loop';
  state.step = 0;

  return emitCommand(state, {
    action: 'write_file',
    path: getTaskPath(cwd, 'impl-result.json'),
    content_file: contentFile,
  });
}

function updateStepProgress(state: PipelineState, cwd: string): void {
  const ps = state.phased_state!;
  const config = loadPipelineConfig();
  const tasksData = buildPipelineTasksJson(state, config);
  const stages = tasksData.stages as Array<Record<string, unknown>>;
  const implStageData = stages.find((_, i) => i === ps.impl_stage_index);
  if (implStageData) {
    implStageData.step_progress = {
      current_step: ps.current_step,
      total_steps: ps.total_steps,
      completed_steps: ps.completed_steps,
      last_reviewed_step: ps.last_reviewed_step,
    };
  }
  writePipelineTasks(cwd, tasksData);
}
