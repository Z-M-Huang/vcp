/**
 * Pipeline driver — report processing (handleReport, processReport, processUserAnswer, processStageResult).
 */

import fs from 'fs';
import path from 'path';

import { loadPipelineConfig } from './pipeline-config.ts';
import type {
  PipelineCommand,
  CommandReport,
  WaitForTaskCmd,
} from '../types/commands.ts';
import type {
  PipelineState,
  StageState,
} from '../types/driver-state.ts';
import {
  getTaskDir,
  readState,
  writeState,
  writePipelineTasks,
  buildPipelineTasksJson,
  resolveStages,
} from './driver-state-io.ts';
import { rebuildStateFromTasks } from './driver-phases.ts';

// ─── REPORT Command ─────────────────────────────────────────────────────────

export function handleReport(cwd: string, commandId: string, report: CommandReport): PipelineCommand | null | 'mismatch' {
  const state = readState(cwd);
  if (!state) {
    console.error(JSON.stringify({ error: 'No pipeline state found.' }));
    return 'mismatch';
  }

  // Verify command ID matches pending command
  if (!state.pending_command || state.pending_command.command_id !== commandId) {
    console.error(JSON.stringify({
      error: `Command ID mismatch. Expected: ${state.pending_command?.command_id}, got: ${commandId}`,
    }));
    return 'mismatch';
  }

  // Save full pending command before clearing (needed for wait_for_task correlation)
  const pendingCommand = state.pending_command;
  const pendingAction = pendingCommand.action;

  // Mark command as acknowledged
  state.pending_command = null;
  const historyEntry = state.command_history.find(h => h.command_id === commandId);
  if (historyEntry) historyEntry.acknowledged = true;

  // Check for user interruption
  if (report.interrupted) {
    state.paused = true;
    state.pause_reason = `User interruption: ${report.user_message || 'No message'}`;
    writeState(cwd, state);
    return null;
  }

  // Check for errors
  if (!report.ok && report.error) {
    // Handle error based on context
    handleReportError(state, cwd, pendingAction, report);
    writeState(cwd, state);
    return null;
  }

  // Process action-specific results
  processReport(state, cwd, pendingAction, report, pendingCommand);
  writeState(cwd, state);
  return null;
}

export function handleReportError(
  state: PipelineState,
  cwd: string,
  action: string,
  report: CommandReport,
): void {
  console.error(JSON.stringify({
    event: 'report_error',
    action,
    error: report.error,
    phase: state.phase,
  }));

  const isDispatchAction = action === 'spawn_agent' || action === 'spawn_background' || action === 'wait_for_task';

  // Main loop dispatch errors
  if (state.phase === 'main_loop' && state.current_dispatch_index !== null) {
    const stage = state.stages[state.current_dispatch_index];
    if (stage && isDispatchAction) {
      stage.status = 'failed';
      const config = loadPipelineConfig();
      writePipelineTasks(cwd, buildPipelineTasksJson(state, config));
    }
    state.current_dispatch_index = null;
    state.dispatch_step = 0;
    return;
  }

  // Phased implementation errors — mark impl stage failed, exit to main loop
  if (state.phase === 'phased_implementation' && isDispatchAction) {
    const ps = state.phased_state;
    if (ps) {
      const implStage = state.stages[ps.impl_stage_index];
      if (implStage) implStage.status = 'failed';
    }
    state.terminal_state = 'implementation_failed';
    state.terminal_reason = `Phased implementation failed: ${report.error}`;
    state.phased_state = null;
    state.phase = 'main_loop';
    state.step = 0;
    return;
  }

  // RCA consolidation errors — do NOT mark consolidation complete
  if (state.phase === 'rca_consolidation') {
    // Leave rca_consolidation.consolidation_complete = false
    // Return to main loop so escalation can happen on next `next` call
    state.phase = 'main_loop';
    state.step = 0;
    return;
  }

  // Specialist / requirements / planning phase errors
  if (isDispatchAction) {
    // Generic: if a dispatch action fails outside main_loop, transition to main_loop
    // so the stuck state can be detected and escalated
    state.phase = 'main_loop';
    state.step = 0;
  }
}

function processReport(
  state: PipelineState,
  cwd: string,
  action: string,
  report: CommandReport,
  pendingCommand?: PipelineCommand,
): void {
  switch (action) {
    case 'create_team':
      // Team created — continue init
      break;

    case 'create_task': {
      // Task chain creation is now batched via parallel_batch — see that handler.
      // Fix/re-review task creation in main loop dispatch (steps 10-11)
      if (state.phase === 'main_loop' && state.current_dispatch_index !== null && report.taskId) {
        if (state.dispatch_step === 11) {
          // Fix task created — no further tracking needed (step 12 handles re-review)
        } else if (state.dispatch_step === 12) {
          // Re-review task created — save original task_id before overwriting
          const stage = state.stages[state.current_dispatch_index];
          if (stage) {
            state.original_review_task_id = stage.task_id;
            stage.task_id = report.taskId;
          }
        }
      }
      break;
    }

    case 'list_tasks': {
      // Check task completion from the task list data
      if (report.tasks && Array.isArray(report.tasks)) {
        for (const task of report.tasks as Array<{ id?: string; status?: string }>) {
          if (task.status === 'completed' && task.id) {
            // Update stage status if this task belongs to a stage
            const stage = state.stages.find(s => s.task_id === task.id);
            if (stage && stage.status === 'in_progress') {
              // Stage's task is complete — move to read output
              state.current_dispatch_index = stage.index;
              state.dispatch_step = 2; // read_file step
            }
          }
        }
      }
      break;
    }

    case 'update_task':
      // Do NOT advance dispatch_step here for main loop dispatch.
      break;

    case 'ask_user': {
      const answer = report.answer || '';
      processUserAnswer(state, cwd, answer);
      break;
    }

    case 'spawn_agent':
    case 'spawn_teammate': {
      // Agent completed. If in main loop dispatch, advance to read output.
      if (state.phase === 'main_loop' && state.current_dispatch_index !== null && state.dispatch_step === 1) {
        state.dispatch_step = 2;
      }
      break;
    }

    case 'spawn_background': {
      // Background task launched — store task_id for polling.
      if (report.task_id) {
        // Use current_dispatch_index (main loop) or command's stage_index (phased mode)
        const stageIdx = state.current_dispatch_index
          ?? (pendingCommand && 'stage_index' in pendingCommand
              ? (pendingCommand as { stage_index?: number }).stage_index ?? null
              : null);
        // Clean up any stale background_tasks for this stage (re-review cycles)
        if (stageIdx !== null) {
          for (const [oldId, bt] of Object.entries(state.background_tasks)) {
            if (bt.stage_index === stageIdx) {
              delete state.background_tasks[oldId];
            }
          }
        }
        state.background_tasks[report.task_id] = {
          command_id: report.task_id,
          stage_index: stageIdx,
          started_at: new Date().toISOString(),
          timeout_ms: 300000,
          poll_attempts: 0,
          last_poll_result: null,
          deadline: new Date(Date.now() + 300000).toISOString(),
        };
        // Advance dispatch to waiting step
        if (state.phase === 'main_loop' && state.current_dispatch_index !== null && state.dispatch_step === 1) {
          state.dispatch_step = 1; // Will emit wait_for_task on next handleMainLoopDispatch
        }
      } else {
        // No task_id returned — dispatch failure
        if (state.phase === 'main_loop' && state.current_dispatch_index !== null) {
          const stage = state.stages[state.current_dispatch_index];
          if (stage) stage.status = 'failed';
          state.current_dispatch_index = null;
          state.dispatch_step = 0;
        }
      }
      break;
    }

    case 'wait_for_task': {
      // Use the original wait command's task_id for reliable correlation.
      const waitCmdTaskId = pendingCommand && 'task_id' in pendingCommand
        ? (pendingCommand as WaitForTaskCmd).task_id
        : null;
      const bgTaskId = waitCmdTaskId || report.task_id || report.command_id;
      if (report.still_running) {
        // Re-poll: dispatch_step stays at 1
        const bt = state.background_tasks[bgTaskId]
          || Object.values(state.background_tasks).find(b => b.command_id === bgTaskId);
        if (bt) bt.poll_attempts++;
        break;
      }
      // Completed — clean up background_tasks entry
      if (state.background_tasks[bgTaskId]) {
        // Mark API parallel group member as completed if applicable
        const bt = state.background_tasks[bgTaskId];
        if (bt.stage_index !== null && state.active_parallel_group) {
          const group = state.active_parallel_group;
          if (
            group.api_members_pending_wait.includes(bt.stage_index) &&
            !group.completed_member_indices.includes(bt.stage_index)
          ) {
            group.completed_member_indices.push(bt.stage_index);
            // Remove from pending wait list
            group.api_members_pending_wait = group.api_members_pending_wait.filter(
              idx => idx !== bt.stage_index
            );

            // Check if ALL group members are now complete
            const allDone = group.member_indices.every(
              idx => group.completed_member_indices.includes(idx)
            );
            if (allDone) {
              const firstMember = group.member_indices[0];
              if (firstMember !== undefined) {
                state.current_dispatch_index = firstMember;
                state.dispatch_step = 2; // read_file step
              }
              state.active_parallel_group = null;
            }
          }
        }
        delete state.background_tasks[bgTaskId];
      }
      // Advance to read output (dispatch_step 1 → 2) for single-stage dispatch
      if (state.phase === 'main_loop' && state.current_dispatch_index !== null) {
        state.dispatch_step = 2;
      }
      break;
    }

    case 'read_file': {
      // Process read_file based on context
      if (state.phase === 'phased_implementation' && state.step === 1) {
        if (report.content) {
          try {
            const manifest = JSON.parse(report.content) as Record<string, unknown>;
            if (state.phased_state && typeof manifest.step_count === 'number') {
              state.phased_state.total_steps = manifest.step_count as number;
            }
          } catch {
            // Invalid JSON
          }
        }
        state.step = 1;
      }

      // Requirements output file ready — validate manifest before advancing to specialist shutdown.
      // Phase may be requirements_team_exploring (set at step 3) or requirements.
      if (state.step === 7 && (
        state.phase === 'requirements' ||
        state.phase === 'requirements_team_pending' ||
        state.phase === 'requirements_team_exploring'
      )) {
        let manifestValid = false;
        if (report.content) {
          try {
            const manifest = JSON.parse(report.content) as Record<string, unknown>;
            manifestValid = typeof manifest.title === 'string' && manifest.title.length > 0
              && typeof manifest.ac_count === 'number';
          } catch {
            // Invalid JSON — not valid
          }
        }
        if (manifestValid) {
          state.step = 8;
        } else {
          state.manifest_retry_count = (state.manifest_retry_count || 0) + 1;
          if (state.manifest_retry_count >= 5) {
            state.terminal_state = 'requirements_manifest_invalid';
            state.terminal_reason = 'Requirements manifest invalid after 5 retries (missing title or ac_count)';
            console.error(JSON.stringify({
              error: 'Requirements manifest validation failed after max retries',
              manifest_retry_count: state.manifest_retry_count,
              content_preview: report.content?.slice(0, 200),
            }));
          }
          // Stay at step 7 — natural retry via handleReportError on next next() call
        }
      }

      // VCP detection
      if (state.phase === 'requirements' && state.step === 2) {
        if (report.content) {
          try {
            const config = JSON.parse(report.content) as Record<string, unknown>;
            if (config.pluginRoot) {
              state.vcp_detection.detected = true;
              state.vcp_detection.source_config_path = path.join(cwd, '.vcp', 'config.json');
            }
          } catch {
            // VCP not detected
          }
        }
      }

      // Phased review verdict reads (step 30)
      if (state.phase === 'phased_implementation' && state.step === 30 && state.phased_state) {
        if (report.content) {
          try {
            const reviewData = JSON.parse(report.content) as Record<string, unknown>;
            const status = String(reviewData.status || '').toLowerCase();
            if (status === 'needs_changes' || status === 'rejected') {
              state.phased_state.last_review_approved = false;
            }
          } catch {
            // Invalid review JSON — treat as needs_changes for safety
            state.phased_state.last_review_approved = false;
          }
        }
      }

      // Main loop dispatch step 2: reading output file after agent completes
      if (state.phase === 'main_loop' && state.current_dispatch_index !== null && state.dispatch_step === 2) {
        const stage = state.stages[state.current_dispatch_index];
        if (stage && report.content) {
          try {
            const resultData = JSON.parse(report.content) as Record<string, unknown>;
            processStageResult(state, cwd, stage, resultData);
          } catch {
            // Malformed output — escalation will happen on next dispatch step
          }
        }
        state.dispatch_step = 3;
      }
      break;
    }

    case 'write_file':
    case 'write_multi_file':
      break;

    case 'receive_messages': {
      // Track specialist completion from received messages
      if (state.phase === 'requirements_team_exploring' && state.specialists && report.messages) {
        for (const msg of report.messages) {
          const specialist = state.specialists.approved_specialists.find(s => s.name === msg.from);
          if (specialist && specialist.status === 'spawned') {
            const summaryLower = (msg.summary || '').toLowerCase();
            if (summaryLower.includes('complete') || summaryLower.includes('done') || summaryLower.includes('finished') || summaryLower.includes('analysis written')) {
              specialist.status = 'completed';
            }
          }
        }
      }
      break;
    }

    case 'shutdown_teammate':
      break;

    case 'parallel_batch': {
      // Collect RCA root causes for disagreement detection
      const rcaRootCauses: string[] = [];

      if (report.batch_results) {
        for (const [cmdId, result] of Object.entries(report.batch_results as Record<string, CommandReport>)) {
          // Route batched task creation results via deterministic cmd_id → stage mapping
          if (state.phase === 'task_chain_creation' && state.batch_cmd_to_stage) {
            const stageIdx = state.batch_cmd_to_stage[cmdId];
            if (stageIdx !== undefined && stageIdx < state.stages.length) {
              if (result.ok === false) {
                state.stages[stageIdx].status = 'failed';
              } else if (result.taskId) {
                state.stages[stageIdx].task_id = result.taskId;
              }
            }
          }

          // Log failed dependency wiring sub-commands
          if (state.phase === 'task_chain_dependencies' && state.batch_cmd_to_stage && result.ok === false) {
            const stageIdx = state.batch_cmd_to_stage[cmdId];
            if (stageIdx !== undefined) {
              console.error(JSON.stringify({
                warning: `Batch update_task failed for stage ${stageIdx}`,
                command_id: cmdId,
                error: result.error || 'unknown',
              }));
            }
          }

          // Route phased review read_file verdict results (multi-reviewer batch)
          if (state.phase === 'phased_implementation' && state.step === 30 && state.phased_state && result.content) {
            try {
              const reviewData = JSON.parse(result.content) as Record<string, unknown>;
              const status = String(reviewData.status || '').toLowerCase();
              if (status === 'needs_changes' || status === 'rejected') {
                state.phased_state.last_review_approved = false;
              }
            } catch {
              state.phased_state.last_review_approved = false;
            }
          }

          // RCA consolidation: collect root causes for disagreement detection
          if (state.phase === 'rca_consolidation' && state.rca_consolidation && result.content) {
            try {
              const rcaData = JSON.parse(result.content) as Record<string, unknown>;
              const raw = rcaData.root_cause || rcaData.diagnosis || rcaData.summary || '';
              const rootCause = (typeof raw === 'object' && raw !== null
                ? JSON.stringify(raw)
                : String(raw)
              ).trim().toLowerCase();
              if (rootCause) rcaRootCauses.push(rootCause);
            } catch { /* malformed RCA output — skip for disagreement check */ }
          }

          // Fix 1: Route specialist spawn failures (requirements_team_pending phase)
          if (state.phase === 'requirements_team_pending' && state.batch_cmd_to_stage && state.specialists) {
            const specialistIdx = state.batch_cmd_to_stage[cmdId];
            if (specialistIdx !== undefined && result.ok === false) {
              const specialist = state.specialists.approved_specialists[specialistIdx];
              if (specialist) {
                specialist.status = 'failed';
                state.specialists.spawn_failures.push(specialist.name);
                console.error(JSON.stringify({
                  warning: `Specialist spawn failed: ${specialist.name}`,
                  command_id: cmdId,
                  error: result.error || 'unknown',
                }));
              }
            }
          }

          // Fix 2: Log failed analysis file reads (requirements step 5)
          if (state.step === 5 && state.batch_cmd_to_stage && result.ok === false && (
            state.phase === 'requirements' ||
            state.phase === 'requirements_team_pending' ||
            state.phase === 'requirements_team_exploring'
          )) {
            const specialistIdx = state.batch_cmd_to_stage[cmdId];
            console.error(JSON.stringify({
              warning: `Analysis file read failed for specialist index ${specialistIdx}`,
              command_id: cmdId,
              error: result.error || 'unknown',
            }));
          }

          // Fix 3: Log specialist shutdown failures (best-effort)
          if (state.phase === 'specialist_shutdown' && result.ok === false) {
            console.error(JSON.stringify({
              warning: 'Specialist shutdown failed',
              command_id: cmdId,
              error: result.error || 'unknown',
            }));
          }

          // Fix 5: Route phased reviewer batch spawn failures
          if (state.phase === 'phased_implementation' && state.step === 3 && result.ok === false) {
            const implStage = state.stages.find(s => s.type === 'implementation');
            if (implStage) implStage.status = 'failed';
            state.terminal_state = 'phased_reviewer_spawn_failed';
            state.terminal_reason = `Phased reviewer spawn failed (batch sub-command ${cmdId})`;
            console.error(JSON.stringify({
              error: 'Phased reviewer batch spawn failure — marking implementation failed',
              command_id: cmdId,
              sub_error: result.error || 'unknown',
            }));
          }

          // Track parallel group dispatch completions using the cmd→stage map.
          if (state.active_parallel_group) {
            const group = state.active_parallel_group;
            const stageIdx = group.dispatch_cmd_to_stage[cmdId];
            if (stageIdx !== undefined && !group.completed_member_indices.includes(stageIdx)) {
              // Check if sub-command failed — mark stage failed and skip completion
              if (result.ok === false) {
                const failedStage = state.stages[stageIdx];
                if (failedStage) failedStage.status = 'failed';
                continue;
              }

              // Register spawn_background task_id → stage_index deterministically
              if (result.task_id) {
                // Clear any prior background_tasks entry for this stage (stale cleanup)
                for (const [oldId, bt] of Object.entries(state.background_tasks)) {
                  if (bt.stage_index === stageIdx) {
                    delete state.background_tasks[oldId];
                  }
                }
                state.background_tasks[result.task_id] = {
                  command_id: result.task_id,
                  stage_index: stageIdx,
                  started_at: new Date().toISOString(),
                  timeout_ms: 300000,
                  poll_attempts: 0,
                  last_poll_result: null,
                  deadline: new Date(Date.now() + 300000).toISOString(),
                };
              }

              // For subscription/cli agents: mark member complete immediately.
              // For API agents: spawn_background returns task_id but the actual work is still running.
              if (!group.api_members_pending_wait.includes(stageIdx)) {
                group.completed_member_indices.push(stageIdx);
              }
            }
          }
        }
      }

      // Post-iteration: batch task chain creation phase transition
      if (state.phase === 'task_chain_creation' && state.batch_cmd_to_stage) {
        // Validate: log warning for any expected cmd_ids missing from results
        const resultKeys = report.batch_results ? Object.keys(report.batch_results) : [];
        for (const [cmdId, stageIdx] of Object.entries(state.batch_cmd_to_stage)) {
          if (!resultKeys.includes(cmdId)) {
            console.error(JSON.stringify({
              warning: `Batch create_task missing result for stage ${stageIdx}`,
              command_id: cmdId,
            }));
          }
        }
        // Sync pipeline-tasks.json once (not per-task)
        writePipelineTasks(cwd, buildPipelineTasksJson(state, loadPipelineConfig()));
        // Advance step and transition phase
        state.step = state.stages.length;
        state.phase = 'task_chain_dependencies';
        state.step = 0;
        state.batch_cmd_to_stage = undefined;
      }

      // Post-iteration: batch task chain dependencies phase transition
      if (state.phase === 'task_chain_dependencies' && state.batch_cmd_to_stage) {
        state.step = state.stages.length;
        state.batch_cmd_to_stage = undefined;
      }

      // Post-iteration: Fix 1 — specialist spawn batch (requirements_team_pending)
      if (state.phase === 'requirements_team_pending' && state.batch_cmd_to_stage && state.specialists) {
        const resultKeys = report.batch_results ? Object.keys(report.batch_results) : [];
        for (const [cmdId, specialistIdx] of Object.entries(state.batch_cmd_to_stage)) {
          if (!resultKeys.includes(cmdId)) {
            const specialist = state.specialists.approved_specialists[specialistIdx];
            if (specialist && specialist.status === 'spawned') {
              specialist.status = 'failed';
              state.specialists.spawn_failures.push(specialist.name);
              console.error(JSON.stringify({
                warning: `Specialist spawn missing result (treating as failed): ${specialist.name}`,
                command_id: cmdId,
              }));
            }
          }
        }
        state.batch_cmd_to_stage = undefined;
      }

      // Post-iteration: Fix 2 — analysis file read batch (requirements step 5)
      if (state.step === 5 && state.batch_cmd_to_stage && (
        state.phase === 'requirements' ||
        state.phase === 'requirements_team_pending' ||
        state.phase === 'requirements_team_exploring'
      )) {
        const resultKeys = report.batch_results ? Object.keys(report.batch_results) : [];
        for (const [cmdId, specialistIdx] of Object.entries(state.batch_cmd_to_stage)) {
          if (!resultKeys.includes(cmdId)) {
            console.error(JSON.stringify({
              warning: `Analysis file read missing result for specialist index ${specialistIdx}`,
              command_id: cmdId,
            }));
          }
        }
        state.step = 6;
        state.batch_cmd_to_stage = undefined;
      }

      // Post-iteration: Fix 5 — phased reviewer spawn batch (phased_implementation step 3)
      if (state.phase === 'phased_implementation' && state.step === 3 && state.batch_cmd_to_stage) {
        const resultKeys = report.batch_results ? Object.keys(report.batch_results) : [];
        for (const [cmdId] of Object.entries(state.batch_cmd_to_stage)) {
          if (!resultKeys.includes(cmdId)) {
            const implStage = state.stages.find(s => s.type === 'implementation');
            if (implStage) implStage.status = 'failed';
            state.terminal_state = 'phased_reviewer_spawn_failed';
            state.terminal_reason = `Phased reviewer spawn missing result (batch sub-command ${cmdId})`;
            console.error(JSON.stringify({
              error: 'Phased reviewer spawn missing result — marking implementation failed',
              command_id: cmdId,
            }));
            break;
          }
        }
        state.batch_cmd_to_stage = undefined;
      }

      // RCA disagreement detection: compare collected root causes
      if (state.phase === 'rca_consolidation' && state.rca_consolidation && rcaRootCauses.length > 1) {
        const first = rcaRootCauses[0];
        const allAgree = rcaRootCauses.every(rc => rc === first);
        if (!allAgree) {
          state.rca_consolidation.disagreement_detected = true;
        }
      }

      // Check if all non-API parallel group members are done dispatching.
      if (state.active_parallel_group) {
        const group = state.active_parallel_group;
        const nonApiMembers = group.member_indices.filter(idx => !group.api_members_pending_wait.includes(idx));
        const allNonApiDone = nonApiMembers.every(idx => group.completed_member_indices.includes(idx));
        const hasApiMembers = group.api_members_pending_wait.length > 0;

        if (allNonApiDone && !hasApiMembers) {
          // All members are subscription/cli and done — proceed to read_file chain
          const firstMember = group.member_indices[0];
          if (firstMember !== undefined) {
            state.current_dispatch_index = firstMember;
            state.dispatch_step = 2; // read_file step
          }
          state.active_parallel_group = null;
        }
      }
      break;
    }

    case 'noop':
    case 'show_status':
      break;

    default:
      break;
  }
}

function processUserAnswer(state: PipelineState, cwd: string, answer: string): void {
  if (state.phase === 'resume_detection') {
    const lowerAnswer = answer.toLowerCase();
    if (lowerAnswer.includes('fresh') || lowerAnswer.includes('reset') || lowerAnswer.includes('start fresh')) {
      // Reset and reinitialize
      resetPipelineDir(cwd);
      // Re-resolve stages from config (since reset wiped them)
      const config = loadPipelineConfig();
      const pipeline = state.pipeline === 'feature' ? config.feature_pipeline : config.bugfix_pipeline;
      const resolved = resolveStages(pipeline, config);
      state.stages = resolved.map(r => ({
        index: r.index,
        type: r.type,
        provider: r.provider,
        model: r.model,
        providerType: r.providerType,
        output_file: r.outputFile,
        task_id: null,
        parallel_group_id: r.parallelGroupId,
        current_version: 1,
        status: 'pending' as const,
        iteration_count: 0,
      }));
      // Write pipeline-tasks.json FIRST (hook contract)
      const taskDir = getTaskDir(cwd);
      fs.mkdirSync(taskDir, { recursive: true });
      writePipelineTasks(cwd, buildPipelineTasksJson(state, config));
      state.phase = 'init';
      state.step = 0;
    } else if (lowerAnswer.includes('resume')) {
      // Resume existing pipeline — rebuild state from pipeline-tasks.json
      rebuildStateFromTasks(state, cwd);
      if (state.stages.length === 0) {
        // Legacy pipeline-tasks.json with no recoverable stages — treat as corrupt
        state.phase = 'resume_detection';
      } else {
        state.phase = 'main_loop';
        state.step = 0;
      }
    } else if (lowerAnswer.includes('status') || lowerAnswer.includes('show')) {
      // Show status — re-enter resume detection to let user decide again
      state.phase = 'resume_detection';
    }
    return;
  }

  if (state.phase === 'rca_consolidation' && state.step === 2) {
    // RCA disagreement resolution
    if (state.rca_consolidation) {
      state.rca_consolidation.chosen_diagnosis_source = answer;
    }
    return;
  }

  if (state.phase === 'phased_implementation' && state.step === 6) {
    // Phased escalation response
    const lowerAnswer = answer.toLowerCase();
    if (lowerAnswer.includes('abort')) {
      state.terminal_state = 'user_aborted';
      state.terminal_reason = 'User aborted during phased implementation escalation.';
    }
    return;
  }

  // needs_clarification / partial: user response (dispatch step 14)
  if (state.phase === 'main_loop' && state.dispatch_step === 14) {
    const lowerAnswer = answer.toLowerCase();
    if (lowerAnswer.includes('abort')) {
      state.terminal_state = 'user_aborted';
      state.terminal_reason = 'User aborted after partial/clarification prompt.';
      state.current_dispatch_index = null;
      state.dispatch_step = 0;
    }
    return;
  }

  // Rejected stage recovery: user chose "Treat as needs_changes" or "Abort"
  if (state.phase === 'main_loop' && (state.terminal_state === 'plan_rejected' || state.terminal_state === 'code_rejected')) {
    const lowerAnswer = answer.toLowerCase();
    if (lowerAnswer.includes('needs_changes') || lowerAnswer.includes('treat')) {
      // Clear terminal state — allow pipeline to continue
      state.terminal_state = null;
      state.terminal_reason = null;
      // Find rejected stage and convert to needs_changes
      const rejectedStage = state.stages.find(s => s.status === 'rejected');
      if (rejectedStage) {
        rejectedStage.status = 'needs_changes';
        rejectedStage.iteration_count++;
        const counterKey = `${rejectedStage.type}_${rejectedStage.index}`;
        state.global_iteration_counters[counterKey] =
          (state.global_iteration_counters[counterKey] || 0) + 1;
        state.current_dispatch_index = rejectedStage.index;
        state.dispatch_step = 10; // fix flow
      }
    }
    return;
  }
}

// ─── Result Processing ──────────────────────────────────────────────────────

/**
 * Process the result of a completed stage by reading its output file.
 */
export function processStageResult(
  state: PipelineState,
  cwd: string,
  stage: StageState,
  resultData: Record<string, unknown>,
): void {
  const status = resultData.status as string;

  switch (status) {
    case 'approved':
    case 'complete':
      stage.status = 'completed';
      break;

    case 'needs_changes':
      stage.status = 'needs_changes';
      stage.iteration_count++;
      // Increment global counter
      const counterKey = `${stage.type}_${stage.index}`;
      state.global_iteration_counters[counterKey] =
        (state.global_iteration_counters[counterKey] || 0) + 1;
      break;

    case 'rejected':
      stage.status = 'rejected';
      if (stage.type === 'plan-review') {
        state.terminal_state = 'plan_rejected';
        state.terminal_reason = 'Plan was rejected by reviewer.';
      } else if (stage.type === 'code-review') {
        state.terminal_state = 'code_rejected';
        state.terminal_reason = 'Code was rejected by reviewer.';
      }
      break;

    case 'needs_clarification':
      // Set pending_user_decision so main loop dispatch step 3 asks the user
      state.pending_user_decision = {
        question: String(
          resultData.clarification_questions || resultData.questions || 'The reviewer needs clarification before proceeding.'
        ),
        options: [],
        context: `Stage ${stage.type} (${stage.provider}/${stage.model}) needs clarification.`,
      };
      break;

    case 'failed':
      stage.status = 'failed';
      if (stage.type === 'implementation') {
        state.terminal_state = 'implementation_failed';
        state.terminal_reason = 'Implementation failed.';
      }
      break;

    case 'partial':
      // Implementation partial — signal need for user intervention
      state.pending_user_decision = {
        question: 'Implementation is partial — manual intervention may be needed. Continue or abort?',
        options: [
          'Continue (accept partial implementation)',
          'Abort pipeline',
        ],
        context: `Stage ${stage.type} (${stage.provider}/${stage.model}) returned partial result.`,
      };
      break;

    default:
      // Unknown status — mark as failed to prevent infinite loop
      stage.status = 'failed';
      state.terminal_reason = `Stage ${stage.type} returned unknown status: "${status || '(empty)'}"`;
      break;
  }

  // Update pipeline-tasks.json
  const config = loadPipelineConfig();
  writePipelineTasks(cwd, buildPipelineTasksJson(state, config));
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Reset pipeline directory (used by processUserAnswer). */
function resetPipelineDir(cwd: string): void {
  const taskDir = getTaskDir(cwd);
  if (fs.existsSync(taskDir)) {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
  fs.mkdirSync(taskDir, { recursive: true });
}
