/**
 * Pipeline driver — main loop dispatch, stage dispatch, parallel groups, and enrichment.
 *
 * Functions that need routeByPhase accept it as a PhaseRouter callback.
 */

import fs from 'fs';
import path from 'path';

import type { StageType } from '../types/stage-definitions.ts';
import {
  STAGE_DEFINITIONS,
  getOutputFileName,
} from '../types/stage-definitions.ts';
import { loadPipelineConfig } from './pipeline-config.ts';
import type { PipelineCommand } from '../types/commands.ts';
import { makeCommandId } from '../types/commands.ts';
import type {
  PipelineState,
  StageState,
} from '../types/driver-state.ts';
import type { PhaseRouter } from './driver-phases.ts';
import {
  getTaskPath,
  getTmpPath,
  writeTempFile,
  writePipelineTasks,
  buildPipelineTasksJson,
  emitCommand,
  deriveSubject,
  deriveDescription,
  buildResolvedStageInfo,
  computeStageIndex,
} from './driver-state-io.ts';
import { findGroupStart } from './driver-phases.ts';

// ─── Phase: Main Loop ───────────────────────────────────────────────────────

/**
 * Main loop state machine. Uses current_dispatch_index + dispatch_step to
 * track multi-step stage execution:
 *
 *   dispatch_step 0: Find next actionable stage, mark in_progress (update_task)
 *   dispatch_step 1: Dispatch agent (spawn_agent/spawn_background)
 *   dispatch_step 2: Read output file after agent completes
 *   dispatch_step 3: Process result (approved → complete, needs_changes → fix flow)
 *   dispatch_step 10: Create fix task (needs_changes)
 *   dispatch_step 11: Create re-review task
 *   dispatch_step 12: Rewire successor, complete current review task
 */
export function handleMainLoop(
  state: PipelineState,
  cwd: string,
  routeByPhase: PhaseRouter,
  handleRcaConsolidation: (state: PipelineState, cwd: string) => PipelineCommand,
  handlePhasedImplementation: (state: PipelineState, cwd: string) => PipelineCommand,
  checkRcaConsolidationNeeded: (state: PipelineState, cwd: string) => boolean,
): PipelineCommand {
  // If we're mid-dispatch, continue the dispatch flow
  if (state.current_dispatch_index !== null) {
    return handleMainLoopDispatch(state, cwd, routeByPhase);
  }

  // Find the next actionable stage
  const nextStage = findNextActionableStage(state);

  if (!nextStage) {
    // Check if all stages are complete
    const allComplete = state.stages.every(s => s.status === 'completed');
    if (allComplete) {
      state.terminal_state = 'completed';
      state.terminal_reason = 'All pipeline stages completed successfully.';
      return emitCommand(state, {
        action: 'done',
        summary: 'Pipeline completed successfully.',
        terminal_state: 'completed',
      });
    }

    // Check for in-progress stages (waiting for parallel group completion etc.)
    const hasInProgress = state.stages.some(s => s.status === 'in_progress');
    if (hasInProgress) {
      // If we have an active parallel group with API members, emit wait_for_task
      if (state.active_parallel_group && state.active_parallel_group.api_members_pending_wait.length > 0) {
        const nextApiStageIdx = state.active_parallel_group.api_members_pending_wait[0];
        const bgTaskId = findBackgroundTaskForStage(state, nextApiStageIdx);
        if (bgTaskId) {
          return emitCommand(state, {
            action: 'wait_for_task',
            task_id: bgTaskId,
            timeout_ms: 600000,
            poll_on_still_running: true,
            max_poll_attempts: 3,
          });
        }
      }
      return emitCommand(state, {
        action: 'list_tasks',
      });
    }

    // Check for needs_changes stages that need fix flow
    const needsChanges = state.stages.find(s => s.status === 'needs_changes');
    if (needsChanges) {
      state.current_dispatch_index = needsChanges.index;
      state.dispatch_step = 10; // Jump to fix flow
      return handleMainLoopDispatch(state, cwd, routeByPhase);
    }

    return emitCommand(state, {
      action: 'escalate',
      error: 'Pipeline is stuck — no actionable stages found.',
      context: `Stages: ${state.stages.map(s => `${s.type}[${s.index}]:${s.status}`).join(', ')}`,
    });
  }

  // Check for RCA consolidation trigger (bugfix pipeline)
  if (state.pipeline === 'bugfix' && nextStage.type !== 'rca') {
    const rcaNeeded = checkRcaConsolidationNeeded(state, cwd);
    if (rcaNeeded) {
      state.phase = 'rca_consolidation';
      state.step = 0;
      return handleRcaConsolidation(state, cwd);
    }
  }

  // Check for phased implementation
  if (nextStage.type === 'implementation') {
    const config = loadPipelineConfig();
    const pipeline = state.pipeline === 'feature'
      ? config.feature_pipeline
      : config.bugfix_pipeline;
    const implEntry = pipeline.find(e => e.type === 'implementation');
    if (implEntry?.phased_reviews && implEntry.phased_reviews.length > 0) {
      state.phase = 'phased_implementation';
      state.step = 0;
      state.phased_state = {
        impl_stage_index: nextStage.index,
        current_step: 1,
        total_steps: 0,
        last_reviewed_step: 0,
        review_interval: config.review_interval ?? 1,
        batch_start: 1,
        batch_end: 0,
        completed_steps: [],
        iteration_count: 0,
        max_iterations: config.max_phased_iterations ?? 3,
        per_reviewer_versions: {},
      };
      return handlePhasedImplementation(state, cwd);
    }
  }

  // Check if stage is a parallel group that should be dispatched together
  if (nextStage.parallel_group_id !== null) {
    const groupMembers = state.stages.filter(
      s => s.parallel_group_id === nextStage.parallel_group_id && s.status === 'pending'
    );
    if (groupMembers.length > 1) {
      return dispatchParallelGroup(state, cwd, groupMembers);
    }
  }

  // Begin single stage dispatch: step 0 → mark in_progress
  state.current_dispatch_index = nextStage.index;
  state.dispatch_step = 0;
  return dispatchStage(state, cwd, nextStage);
}

/**
 * Continue multi-step dispatch flow for the current stage.
 */
export function handleMainLoopDispatch(state: PipelineState, cwd: string, routeByPhase: PhaseRouter): PipelineCommand {
  const stageIndex = state.current_dispatch_index!;
  const stage = state.stages[stageIndex];
  if (!stage) {
    state.current_dispatch_index = null;
    state.dispatch_step = 0;
    return emitCommand(state, {
      action: 'escalate',
      error: `Stage ${stageIndex} not found during dispatch.`,
      context: 'Main loop dispatch',
    });
  }

  switch (state.dispatch_step) {
    case 0:
      // Mark in_progress — already handled by dispatchStage
      // (We get here if report processed for update_task)
      state.dispatch_step = 1;
      return dispatchStageAgent(state, cwd, stage);

    case 1:
      // Agent dispatched. For subscription/CLI, the report comes when agent finishes.
      // For API (background), report comes with task_id. Need to wait.
      if (stage.providerType === 'api') {
        // Background task — need to wait.
        // Keep dispatch_step at 1 so still_running re-enters this case for re-poll.
        const bgTaskId = findBackgroundTaskForStage(state, stage.index);
        if (bgTaskId) {
          // Do NOT advance dispatch_step — wait_for_task handler advances to 2 on completion
          return emitCommand(state, {
            action: 'wait_for_task',
            task_id: bgTaskId,
            timeout_ms: 600000,
            poll_on_still_running: true,
            max_poll_attempts: 3,
          });
        }
      }
      // Subscription/CLI: agent result in report. Read output file.
      state.dispatch_step = 2;
      return emitCommand(state, {
        action: 'read_file',
        path: getTaskPath(cwd, stage.output_file),
      });

    case 2:
      // Output file read or background task completed.
      // Read the output file to check status.
      return emitCommand(state, {
        action: 'read_file',
        path: getTaskPath(cwd, stage.output_file),
      });

    case 3: {
      // Result processed by processReport → processStageResult.
      // Check for pending user decision (needs_clarification, partial)
      if (state.pending_user_decision) {
        const decision = state.pending_user_decision;
        state.pending_user_decision = null;
        state.dispatch_step = 14; // needs_clarification response step
        return emitCommand(state, {
          action: 'ask_user',
          question: decision.question,
          options: decision.options.map(o => ({ label: o, description: '' })),
          context: decision.context,
        });
      }

      // Check stage status and emit appropriate next command.
      if (stage.status === 'completed') {
        // Check for remaining parallel group members that need processing.
        const nextGroupMember = findNextGroupMemberToProcess(state, stage);
        if (nextGroupMember !== null) {
          // More group members to process — dispatch read_file for the next one
          state.current_dispatch_index = nextGroupMember;
          state.dispatch_step = 2; // read_file step
        } else {
          state.current_dispatch_index = null;
          state.dispatch_step = 0;
        }

        if (stage.task_id) {
          // Enrich the next stage's task description before completing
          enrichNextStage(state, cwd, stage);
          return emitCommand(state, {
            action: 'update_task',
            taskId: stage.task_id,
            status: 'completed',
          });
        }
        return routeByPhase(state, cwd);
      }

      if (stage.status === 'needs_changes') {
        const config = loadPipelineConfig();
        const maxIter = config.max_iterations ?? 10;
        if (stage.iteration_count >= maxIter) {
          state.terminal_state = 'max_iterations_reached';
          state.terminal_reason = `Stage ${stage.type} ${stage.index} exceeded max iterations (${maxIter}).`;
          state.current_dispatch_index = null;
          state.dispatch_step = 0;
          return emitCommand(state, {
            action: 'done',
            summary: state.terminal_reason,
            terminal_state: 'max_iterations_reached',
          });
        }
        // Enter fix flow
        state.dispatch_step = 10;
        return handleMainLoopDispatch(state, cwd, routeByPhase);
      }

      if (stage.status === 'rejected') {
        state.current_dispatch_index = null;
        state.dispatch_step = 0;
        return emitCommand(state, {
          action: 'ask_user',
          question: `Stage "${stage.type}" was rejected. How would you like to proceed?`,
          options: [
            { label: 'Abort', description: 'Stop the pipeline' },
            { label: 'Treat as needs_changes', description: 'Create fix and re-review tasks' },
          ],
          context: `Terminal state: ${state.terminal_state}`,
        });
      }

      if (stage.status === 'failed') {
        state.current_dispatch_index = null;
        state.dispatch_step = 0;
        return emitCommand(state, {
          action: 'done',
          summary: state.terminal_reason || `Stage ${stage.type} failed.`,
          terminal_state: state.terminal_state || 'implementation_failed',
        });
      }

      // Default: advance
      state.current_dispatch_index = null;
      state.dispatch_step = 0;
      return routeByPhase(state, cwd);
    }

    // ── needs_changes fix flow ──

    case 10: {
      // Create fix task
      stage.current_version++;
      const fixSubject = `Fix ${deriveSubject(buildResolvedStageInfo(stage, state))} v${stage.current_version}`;
      const fixDescription = [
        `FIX TASK: Address issues from ${stage.type} review`,
        `ISSUES TO FIX: See .vcp/task/${stage.output_file}`,
        `AGENT: dev-buddy:implementer`,
        `MODEL: ${stage.model}`,
        `OUTPUT: Updated implementation addressing review feedback`,
      ].join('\n');

      state.dispatch_step = 11;
      return emitCommand(state, {
        action: 'create_task',
        subject: fixSubject,
        description: fixDescription,
        activeForm: `Fixing ${stage.type} issues...`,
      });
    }

    case 11: {
      // Create re-review task
      const reReviewSubject = `${deriveSubject(buildResolvedStageInfo(stage, state))} v${stage.current_version}`;
      const reReviewDescription = [
        `RE-REVIEW: Verify fixes for ${stage.type}`,
        `NOTE: Re-review after fix. Check that all prior issues are resolved.`,
        `AGENT: dev-buddy:${STAGE_DEFINITIONS[stage.type].agent_type}`,
        `MODEL: ${stage.model}`,
        `PROVIDER: ${stage.provider} (${stage.providerType})`,
        `OUTPUT: .vcp/task/${getOutputFileName(stage.type, computeStageIndex(state, stage), stage.provider, stage.model, stage.current_version)}`,
      ].join('\n');

      state.dispatch_step = 12;
      return emitCommand(state, {
        action: 'create_task',
        subject: reReviewSubject,
        description: reReviewDescription,
        activeForm: `Re-reviewing ${stage.type}...`,
      });
    }

    case 12: {
      // Rewire successor: the next stage after this one (or after the parallel group)
      // must now be blocked by the re-review task instead.
      // Mark the ORIGINAL review task as completed (it did its job — found issues).
      // stage.task_id now points to the re-review task (set in processReport step 12).
      const originalTaskId = state.original_review_task_id || stage.task_id;
      if (originalTaskId) {
        // Reset stage to pending for the re-review cycle
        stage.status = 'pending';
        stage.output_file = getOutputFileName(
          stage.type,
          computeStageIndex(state, stage),
          stage.provider,
          stage.model,
          stage.current_version,
        );

        // Update pipeline-tasks.json
        const config = loadPipelineConfig();
        writePipelineTasks(cwd, buildPipelineTasksJson(state, config));

        // Clean up temporary state
        state.original_review_task_id = null;

        state.current_dispatch_index = null;
        state.dispatch_step = 0;
        return emitCommand(state, {
          action: 'update_task',
          taskId: originalTaskId,
          status: 'completed',
        });
      }

      state.current_dispatch_index = null;
      state.dispatch_step = 0;
      return routeByPhase(state, cwd);
    }

    case 14: {
      // needs_clarification resolved — re-run same stage from dispatch step 0
      state.dispatch_step = 0;
      return dispatchStage(state, cwd, stage);
    }

    default:
      state.current_dispatch_index = null;
      state.dispatch_step = 0;
      return emitCommand(state, {
        action: 'escalate',
        error: `Unexpected dispatch step: ${state.dispatch_step}`,
        context: 'Main loop dispatch',
      });
  }
}

// ─── Background Task Helpers ────────────────────────────────────────────────

/** Find background task ID linked to a stage. */
export function findBackgroundTaskForStage(state: PipelineState, stageIndex: number): string | null {
  for (const [taskId, bt] of Object.entries(state.background_tasks)) {
    if (bt.stage_index === stageIndex) return taskId;
  }
  return null;
}

// ─── Stage Query Helpers ────────────────────────────────────────────────────

/**
 * Progressive enrichment: extract context from completed stage output
 * and append it to the next stage's task description.
 */
function enrichNextStage(state: PipelineState, cwd: string, completedStage: StageState): void {
  // Find the successor stage
  const successorIndex = findSuccessorIndex(state, completedStage.index);
  if (successorIndex === null) return;

  const successor = state.stages[successorIndex];
  if (!successor?.task_id) return;

  // Read the completed stage's output for context extraction
  const outputPath = getTaskPath(cwd, completedStage.output_file);
  try {
    if (!fs.existsSync(outputPath)) return;
    const content = fs.readFileSync(outputPath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;

    // Extract a brief summary (≤250 chars)
    const summary = extractContextSummary(data, completedStage.type);
    if (!summary) return;

    // Write enrichment context to a temp file that the executor can use
    const enrichmentKey = `enrichment_${successorIndex}`;
    const existing = state.global_iteration_counters[enrichmentKey] || 0;
    state.global_iteration_counters[enrichmentKey] = existing + 1;

    // Store enrichment data in temp file for executor access
    const enrichPath = getTmpPath(cwd, `enrichment-${successorIndex}.txt`);
    const prefix = existing > 0 ? '\n\n' : '';
    const block = `${prefix}CONTEXT FROM ${completedStage.type.toUpperCase()} (${completedStage.provider}/${completedStage.model}):\n${summary}`;

    if (existing > 0) {
      fs.appendFileSync(enrichPath, block, 'utf-8');
    } else {
      fs.writeFileSync(enrichPath, block, 'utf-8');
    }
  } catch {
    // Enrichment is best-effort — never blocks pipeline
  }
}

/** Extract a brief context summary from stage output. */
function extractContextSummary(data: Record<string, unknown>, stageType: StageType): string | null {
  switch (stageType) {
    case 'requirements': {
      const title = data.title as string | undefined;
      const acCount = data.ac_count as number | undefined;
      if (title) return `User story: "${title}" (${acCount ?? 0} acceptance criteria)`;
      return null;
    }
    case 'planning': {
      const title = data.title as string | undefined;
      const stepCount = data.step_count as number | undefined;
      if (title) return `Plan: "${title}" (${stepCount ?? 0} steps)`;
      return null;
    }
    case 'plan-review':
    case 'code-review': {
      const status = data.status as string | undefined;
      const summary = data.summary as string | undefined;
      if (summary) return `Review (${status}): ${summary.slice(0, 200)}`;
      return null;
    }
    case 'rca': {
      const rc = data.root_cause as Record<string, unknown> | undefined;
      const summary = rc?.summary as string | undefined;
      if (summary) return `RCA: ${summary.slice(0, 200)}`;
      return null;
    }
    case 'implementation': {
      const status = data.status as string | undefined;
      return `Implementation: ${status || 'unknown'}`;
    }
    default:
      return null;
  }
}

/** Find the index of the successor stage (respecting parallel groups). */
export function findSuccessorIndex(state: PipelineState, stageIndex: number): number | null {
  const stage = state.stages[stageIndex];

  // If stage is in a parallel group, successor is after the group
  if (stage.parallel_group_id !== null) {
    let lastInGroup = stageIndex;
    for (let i = stageIndex + 1; i < state.stages.length; i++) {
      if (state.stages[i].parallel_group_id === stage.parallel_group_id) {
        lastInGroup = i;
      } else {
        break;
      }
    }
    const nextIndex = lastInGroup + 1;
    return nextIndex < state.stages.length ? nextIndex : null;
  }

  // Sequential: next index
  const nextIndex = stageIndex + 1;
  return nextIndex < state.stages.length ? nextIndex : null;
}

/**
 * After completing a parallel group member, find the next in_progress sibling
 * in the same group that still needs output processing (read_file → processStageResult).
 */
export function findNextGroupMemberToProcess(state: PipelineState, completedStage: StageState): number | null {
  if (completedStage.parallel_group_id === null) return null;

  for (const s of state.stages) {
    if (
      s.parallel_group_id === completedStage.parallel_group_id &&
      s.index !== completedStage.index &&
      s.status === 'in_progress'
    ) {
      return s.index;
    }
  }
  return null;
}

/**
 * Find the next stage that can be executed.
 * A stage is actionable if:
 * 1. Its status is 'pending'
 * 2. All predecessor stages are 'completed'
 */
export function findNextActionableStage(state: PipelineState): StageState | null {
  for (const stage of state.stages) {
    if (stage.status !== 'pending') continue;

    // Check all predecessors are completed
    const predecessorsComplete = arePredecessorsComplete(state, stage.index);
    if (predecessorsComplete) {
      return stage;
    }
  }
  return null;
}

export function arePredecessorsComplete(state: PipelineState, stageIndex: number): boolean {
  if (stageIndex === 0) return true;

  const stage = state.stages[stageIndex];

  // Same parallel group as previous — check if the group predecessor is complete
  if (stage.parallel_group_id !== null) {
    const groupStart = findGroupStart(state, stageIndex);
    if (groupStart === stageIndex) {
      // First in group — check predecessor before the group
      if (groupStart === 0) return true;
      const prevStage = state.stages[groupStart - 1];
      if (prevStage.parallel_group_id !== null) {
        // Previous was also a group — all members must be complete
        return state.stages
          .filter(s => s.parallel_group_id === prevStage.parallel_group_id)
          .every(s => s.status === 'completed');
      }
      return prevStage.status === 'completed';
    }
    // Not first in group — same predecessors as first in group
    return arePredecessorsComplete(state, groupStart);
  }

  // Sequential stage
  const prevStage = state.stages[stageIndex - 1];
  if (prevStage.parallel_group_id !== null) {
    // Fan-in: all members of the previous group must be complete
    return state.stages
      .filter(s => s.parallel_group_id === prevStage.parallel_group_id)
      .every(s => s.status === 'completed');
  }
  return prevStage.status === 'completed';
}

// ─── Stage Dispatch ─────────────────────────────────────────────────────────

export function dispatchStage(state: PipelineState, cwd: string, stage: StageState): PipelineCommand {
  // Mark stage as in_progress in internal state
  stage.status = 'in_progress';

  // Update pipeline-tasks.json (hook contract)
  const config = loadPipelineConfig();
  writePipelineTasks(cwd, buildPipelineTasksJson(state, config));

  if (!stage.task_id) {
    return emitCommand(state, {
      action: 'escalate',
      error: `Stage ${stage.index} (${stage.type}) has no task_id.`,
      context: 'Cannot dispatch stage without a task ID.',
    });
  }

  // Step 0: mark the task as in_progress. Step 1 (dispatch agent) happens after report.
  return emitCommand(state, {
    action: 'update_task',
    taskId: stage.task_id,
    status: 'in_progress',
  });
}

export function buildStagePrompt(state: PipelineState, stage: StageState, cwd: string): string {
  const desc = deriveDescription(state, stage, buildResolvedStageInfo(stage, state), cwd);
  return desc;
}

export function dispatchStageAgent(state: PipelineState, cwd: string, stage: StageState): PipelineCommand {
  const agentDef = STAGE_DEFINITIONS[stage.type];
  const promptContent = buildStagePrompt(state, stage, cwd);
  const promptFile = writeTempFile(cwd, `stage-${stage.type}`, makeCommandId(), promptContent);

  switch (stage.providerType) {
    case 'subscription': {
      const subagentType = stage.type === 'requirements'
        ? 'general-purpose'
        : `dev-buddy:${agentDef.agent_type}`;

      return emitCommand(state, {
        action: 'spawn_agent',
        subagent_type: subagentType,
        name: `${stage.type}-${stage.index}`,
        model: stage.model,
        prompt_file: promptFile,
      });
    }

    case 'api': {
      // Build api-task-runner command
      const isReviewStage = stage.type === 'plan-review' || stage.type === 'code-review';
      return emitCommand(state, {
        action: 'spawn_background',
        command: buildApiTaskRunnerCommand(stage, cwd, isReviewStage),
        timeout_ms: 300000, // Will be overridden by preset timeout_ms
        system_prompt_file: isReviewStage ? 'docs/review-guidelines.md' : undefined,
        stage_index: stage.index,
      });
    }

    case 'cli': {
      return emitCommand(state, {
        action: 'spawn_agent',
        subagent_type: 'dev-buddy:cli-executor',
        name: `cli-${stage.type}-${stage.index}`,
        prompt_file: promptFile,
      });
    }

    default:
      return emitCommand(state, {
        action: 'escalate',
        error: `Unknown provider type: ${stage.providerType}`,
        context: `Stage ${stage.index} (${stage.type})`,
      });
  }
}

export function buildApiTaskRunnerCommand(stage: StageState, cwd: string, isReview: boolean): string {
  // import.meta.dir = scripts/ directory. Plugin root = one level up.
  const pluginRoot = path.dirname(import.meta.dir);

  // Shell-escape values to prevent injection via provider names or paths
  const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

  const parts = [
    `bun`,
    esc(path.join(pluginRoot, 'scripts', 'api-task-runner.ts')),
    `--preset ${esc(stage.provider)}`,
    `--model ${esc(stage.model)}`,
    `--cwd ${esc(cwd)}`,
    `--task-timeout 300000`,
    `--task-stdin`,
  ];
  if (isReview) {
    parts.splice(parts.length - 1, 0,
      `--system-prompt ${esc(path.join(pluginRoot, 'docs', 'review-guidelines.md'))}`
    );
  }
  return parts.join(' ');
}

// ─── Parallel Group Dispatch ────────────────────────────────────────────────

export function dispatchParallelGroup(state: PipelineState, cwd: string, groupMembers: StageState[]): PipelineCommand {
  // Mark all group members as in_progress
  for (const member of groupMembers) {
    member.status = 'in_progress';
  }

  // Update pipeline-tasks.json
  const config = loadPipelineConfig();
  writePipelineTasks(cwd, buildPipelineTasksJson(state, config));

  // Track parallel group
  const dispatchCmdToStage: Record<string, number> = {};
  const apiMembersPendingWait: number[] = [];
  state.active_parallel_group = {
    group_id: `group-${groupMembers[0].parallel_group_id}`,
    member_indices: groupMembers.map(m => m.index),
    member_task_ids: groupMembers.filter(m => m.task_id).map(m => m.task_id!),
    completed_member_indices: [],
    dispatch_cmd_to_stage: dispatchCmdToStage,
    api_members_pending_wait: apiMembersPendingWait,
    results: {},
  };

  // Build parallel batch: mark all as in_progress AND dispatch agents
  const commands: PipelineCommand[] = [];

  // First: update_task(in_progress) for each
  for (const m of groupMembers) {
    if (m.task_id) {
      commands.push({
        command_id: makeCommandId(),
        state_version: state.state_version,
        action: 'update_task' as const,
        taskId: m.task_id,
        status: 'in_progress' as const,
      });
    }
  }

  // Then: dispatch agents for each member (track command_id → stage_index)
  for (const m of groupMembers) {
    const promptContent = buildStagePrompt(state, m, cwd);
    const promptFile = writeTempFile(cwd, `stage-${m.type}`, makeCommandId(), promptContent);
    const agentDef = STAGE_DEFINITIONS[m.type];

    if (m.providerType === 'subscription') {
      const cmdId = makeCommandId();
      dispatchCmdToStage[cmdId] = m.index;
      commands.push({
        command_id: cmdId,
        state_version: state.state_version,
        action: 'spawn_agent' as const,
        subagent_type: `dev-buddy:${agentDef.agent_type}`,
        name: `${m.type}-${m.index}`,
        model: m.model,
        prompt_file: promptFile,
      });
    } else if (m.providerType === 'api') {
      const cmdId = makeCommandId();
      dispatchCmdToStage[cmdId] = m.index;
      apiMembersPendingWait.push(m.index);
      const isReview = m.type === 'plan-review' || m.type === 'code-review';
      commands.push({
        command_id: cmdId,
        state_version: state.state_version,
        action: 'spawn_background' as const,
        command: buildApiTaskRunnerCommand(m, cwd, isReview),
        timeout_ms: 300000,
        system_prompt_file: isReview ? 'docs/review-guidelines.md' : undefined,
        stage_index: m.index,
      });
    } else if (m.providerType === 'cli') {
      const cmdId = makeCommandId();
      dispatchCmdToStage[cmdId] = m.index;
      commands.push({
        command_id: cmdId,
        state_version: state.state_version,
        action: 'spawn_agent' as const,
        subagent_type: 'dev-buddy:cli-executor',
        name: `cli-${m.type}-${m.index}`,
        prompt_file: promptFile,
      });
    }
  }

  return emitCommand(state, {
    action: 'parallel_batch',
    commands,
  });
}
