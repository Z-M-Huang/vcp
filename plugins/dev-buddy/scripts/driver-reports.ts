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
import { DISPATCH_STEP, REQ_STEP } from '../types/commands.ts';
import type {
  PipelineState,
  StageState,
} from '../types/driver-state.ts';
import {
  getTaskDir,
  getTaskPath,
  readState,
  writeState,
  writePipelineTasks,
  buildPipelineTasksJson,
  resolveStages,
} from './driver-state-io.ts';
import { driverLog } from './vcp-logger.ts';
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
  driverLog('report-ack', 'info', `action=${pendingAction} cmd=${commandId}`);

  // Mark command as acknowledged
  state.pending_command = null;
  const historyEntry = state.command_history.find(h => h.command_id === commandId);
  if (historyEntry) historyEntry.acknowledged = true;

  // Check for user interruption
  if (report.interrupted) {
    driverLog('interrupted', 'warn', `User interrupted: ${report.user_message || 'No message'}`);
    state.paused = true;
    state.pause_reason = `User interruption: ${report.user_message || 'No message'}`;
    writeState(cwd, state);
    return null;
  }

  // Check for errors
  if (!report.ok && report.error) {
    driverLog('report-error', 'error', `action=${pendingAction} error=${report.error}`);
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

  // Defense-in-depth: any read_file error at requirements manifest read step.
  if (action === 'read_file'
    && state.step === REQ_STEP.MANIFEST_READ
    && (state.phase === 'requirements' || state.phase === 'requirements_team_pending' || state.phase === 'requirements_team_exploring')
  ) {
    state.manifest_retry_count = (state.manifest_retry_count || 0) + 1;
    driverLog('manifest-read-error', 'warn', `read_file error at step ${REQ_STEP.MANIFEST_READ}, attempt ${state.manifest_retry_count}/3: ${report.error}`);
    if (state.manifest_retry_count >= 3) {
      state.step = REQ_STEP.MANIFEST_ESCALATE;
      state.manifest_failure_kind = 'missing';
      state.manifest_failure_reason = 'user-story/manifest.json not found after 3 read attempts';
    }
    return;
  }

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
    state.phase = 'main_loop';
    state.step = 0;
    return;
  }

  // Specialist / requirements / planning phase errors
  if (isDispatchAction) {
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
      // Team created — continue
      break;

    case 'ask_user':
    case 'escalate': {
      const answer = report.answer || '';
      processUserAnswer(state, cwd, answer);
      break;
    }

    case 'spawn_agent':
    case 'spawn_teammate': {
      // Agent completed. If in main loop dispatch, advance to read output.
      if (state.phase === 'main_loop' && state.current_dispatch_index !== null && state.dispatch_step === DISPATCH_STEP.AGENT) {
        state.dispatch_step = DISPATCH_STEP.READ_OUTPUT;
      }

      // Requirements synthesis: agent completed → try fast-path manifest validation.
      // On success: advance directly to COMPLETE (skip read_file round-trip).
      // On failure: fall through to MANIFEST_READ retry path (don't terminate).
      if (state.step === REQ_STEP.MANIFEST_READ && (
        state.phase === 'requirements' ||
        state.phase === 'requirements_team_pending' ||
        state.phase === 'requirements_team_exploring'
      )) {
        const reqStage = state.stages.find(s => s.type === 'requirements');
        const outputFile = reqStage?.output_file || 'user-story/manifest.json';
        const manifestPath = getTaskPath(cwd, outputFile);
        try {
          const content = fs.readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(content) as Record<string, unknown>;
          if (typeof manifest.title === 'string' && manifest.title.length > 0
            && typeof manifest.ac_count === 'number') {
            driverLog('manifest-validated', 'info', `In-process validation passed — advancing to step ${REQ_STEP.COMPLETE}`);
            state.step = REQ_STEP.COMPLETE;
            state.manifest_retry_count = 0;
          } else {
            driverLog('manifest-not-ready', 'warn', 'Manifest exists but not yet valid; falling through to MANIFEST_READ retry path');
          }
        } catch {
          driverLog('manifest-not-ready', 'warn', 'Manifest not yet readable; falling through to MANIFEST_READ retry path');
        }
      }
      break;
    }

    case 'spawn_background': {
      // Background task launched — store task_id for polling.
      if (report.task_id) {
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
        // Keep dispatch_step at AGENT — will emit wait_for_task on next handleMainLoopDispatch
        if (state.phase === 'main_loop' && state.current_dispatch_index !== null && state.dispatch_step === DISPATCH_STEP.AGENT) {
          state.dispatch_step = DISPATCH_STEP.AGENT;
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
      const waitCmdTaskId = pendingCommand && 'task_id' in pendingCommand
        ? (pendingCommand as WaitForTaskCmd).task_id
        : null;
      const bgTaskId = waitCmdTaskId || report.task_id || report.command_id;
      if (report.still_running) {
        // Re-poll: dispatch_step stays at AGENT
        const bt = state.background_tasks[bgTaskId]
          || Object.values(state.background_tasks).find(b => b.command_id === bgTaskId);
        if (bt) bt.poll_attempts++;
        break;
      }
      // Completed — clean up background_tasks entry
      if (state.background_tasks[bgTaskId]) {
        const bt = state.background_tasks[bgTaskId];
        if (bt.stage_index !== null && state.active_parallel_group) {
          const group = state.active_parallel_group;
          if (
            group.api_members_pending_wait.includes(bt.stage_index) &&
            !group.completed_member_indices.includes(bt.stage_index)
          ) {
            group.completed_member_indices.push(bt.stage_index);
            group.api_members_pending_wait = group.api_members_pending_wait.filter(
              idx => idx !== bt.stage_index
            );

            const allDone = group.member_indices.every(
              idx => group.completed_member_indices.includes(idx)
            );
            if (allDone) {
              const firstMember = group.member_indices[0];
              if (firstMember !== undefined) {
                state.current_dispatch_index = firstMember;
                state.dispatch_step = DISPATCH_STEP.READ_OUTPUT;
              }
              state.active_parallel_group = null;
            }
          }
        }
        delete state.background_tasks[bgTaskId];
      }
      // Advance to read output for single-stage dispatch
      if (state.phase === 'main_loop' && state.current_dispatch_index !== null) {
        state.dispatch_step = DISPATCH_STEP.READ_OUTPUT;
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

      // Requirements output file ready — validate manifest.
      if (state.step === REQ_STEP.MANIFEST_READ && (
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
          state.step = REQ_STEP.COMPLETE;
        } else {
          state.manifest_retry_count = (state.manifest_retry_count || 0) + 1;
          if (state.manifest_retry_count >= 5) {
            state.step = REQ_STEP.MANIFEST_ESCALATE;
            state.manifest_failure_kind = 'invalid';
            state.manifest_failure_reason = 'Requirements manifest invalid after 5 retries (missing title or ac_count)';
            console.error(JSON.stringify({
              error: 'Requirements manifest validation failed after max retries',
              manifest_retry_count: state.manifest_retry_count,
              content_preview: report.content?.slice(0, 200),
            }));
          }
        }
      }

      // VCP detection (step transitions: CHECK_STAGE emits read_file, VCP_DETECT step processes it)
      if (state.phase === 'requirements' && state.step === REQ_STEP.VCP_DETECT) {
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
            state.phased_state.last_review_approved = false;
          }
        }
      }

      // Main loop dispatch: reading output file after agent completes
      if (state.phase === 'main_loop' && state.current_dispatch_index !== null && state.dispatch_step === DISPATCH_STEP.READ_OUTPUT) {
        const stage = state.stages[state.current_dispatch_index];
        if (stage && report.content) {
          try {
            const resultData = JSON.parse(report.content) as Record<string, unknown>;
            processStageResult(state, cwd, stage, resultData);
          } catch {
            // Malformed output — escalation will happen on next dispatch step
          }
        }
        state.dispatch_step = DISPATCH_STEP.PROCESS;
      }
      break;
    }

    case 'write_file':
    case 'write_multi_file':
      break;

    case 'send_message': {
      // Q&A relay: answer sent to specialist → persist transcript, clear active_relay
      if (state.phase === 'requirements_team_exploring' && state.specialists?.active_relay?.answer) {
        const relay = state.specialists.active_relay;
        state.specialists.qa_transcript.push({
          specialist_name: relay.specialist_name,
          question: relay.question,
          answer: relay.answer,
        });
        state.specialists.active_relay = undefined;

        const specialist = state.specialists.approved_specialists.find(
          s => s.name === relay.specialist_name
        );
        if (specialist?.deferred_completion) {
          const stillHasPendingQ = state.specialists.pending_questions.some(
            q => q.specialist_name === relay.specialist_name
          );
          if (!stillHasPendingQ) {
            specialist.status = 'completed';
            delete specialist.deferred_completion;
          }
        }
      }
      break;
    }

    case 'receive_messages': {
      if (state.phase === 'requirements_team_exploring' && state.specialists && report.messages) {
        const completionMessages: Array<{ from: string; specialist: typeof state.specialists.approved_specialists[0] }> = [];
        for (const msg of report.messages) {
          const specialist = state.specialists.approved_specialists.find(s => s.name === msg.from);
          if (!specialist) continue;

          const summary = msg.summary || '';
          const summaryLower = summary.toLowerCase();

          if (summaryLower.startsWith('[question]')) {
            const question = summary.replace(/^\[QUESTION\]\s*/i, '');
            if (question.trim()) {
              state.specialists.pending_questions.push({
                specialist_name: msg.from,
                question: question.trim(),
              });
            }
          } else if (specialist.status === 'spawned' && (
            summaryLower.includes('complete') || summaryLower.includes('done') ||
            summaryLower.includes('finished') || summaryLower.includes('analysis written')
          )) {
            completionMessages.push({ from: msg.from, specialist });
          }
        }

        for (const { from, specialist } of completionMessages) {
          const hasPendingQ = state.specialists.pending_questions.some(
            q => q.specialist_name === from
          );
          const hasActiveRelay = state.specialists.active_relay?.specialist_name === from;
          if (hasPendingQ || hasActiveRelay) {
            specialist.deferred_completion = true;
          } else {
            specialist.status = 'completed';
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

          // Route specialist spawn failures (requirements_team_pending phase)
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

          // Log failed analysis file reads (requirements READ_ANALYSES step)
          if (state.step === REQ_STEP.READ_ANALYSES && state.batch_cmd_to_stage && result.ok === false && (
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

          // Log specialist shutdown failures (best-effort)
          if (state.phase === 'specialist_shutdown' && result.ok === false) {
            console.error(JSON.stringify({
              warning: 'Specialist shutdown failed',
              command_id: cmdId,
              error: result.error || 'unknown',
            }));
          }

          // Route phased reviewer batch spawn failures
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
              if (result.ok === false) {
                const failedStage = state.stages[stageIdx];
                if (failedStage) failedStage.status = 'failed';
                continue;
              }

              // Register spawn_background task_id → stage_index deterministically
              if (result.task_id) {
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

              if (!group.api_members_pending_wait.includes(stageIdx)) {
                group.completed_member_indices.push(stageIdx);
              }
            }
          }
        }
      }

      // Post-iteration: specialist spawn batch (requirements_team_pending)
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

      // Post-iteration: analysis file read batch (requirements READ_ANALYSES step)
      if (state.step === REQ_STEP.READ_ANALYSES && state.batch_cmd_to_stage && (
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
        state.step = REQ_STEP.SHUTDOWN_SPECS;
        state.batch_cmd_to_stage = undefined;
      }

      // Post-iteration: phased reviewer spawn batch (phased_implementation step 3)
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

      // RCA disagreement detection
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
          const firstMember = group.member_indices[0];
          if (firstMember !== undefined) {
            state.current_dispatch_index = firstMember;
            state.dispatch_step = DISPATCH_STEP.READ_OUTPUT;
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
  // Requirements manifest escalation: user chose retry or abort
  if (state.step === REQ_STEP.MANIFEST_ESCALATE && (
    state.phase === 'requirements' ||
    state.phase === 'requirements_team_pending' ||
    state.phase === 'requirements_team_exploring'
  )) {
    const lowerAnswer = answer.toLowerCase();
    if (lowerAnswer.includes('retry')) {
      driverLog('manifest-escalation', 'info', 'User chose to retry requirements synthesis');
      state.manifest_retry_count = 0;
      state.manifest_failure_kind = undefined;
      state.manifest_failure_reason = undefined;
      state.step = REQ_STEP.SYNTHESIS;
    } else if (lowerAnswer.includes('abort')) {
      driverLog('manifest-escalation', 'info', 'User chose to abort pipeline');
      state.terminal_state = state.manifest_failure_kind === 'missing'
        ? 'requirements_manifest_missing'
        : 'requirements_manifest_invalid';
      state.terminal_reason = state.manifest_failure_reason
        || 'Requirements manifest validation failed.';
    }
    return;
  }

  // Q&A relay: specialist question answered by user
  if (state.phase === 'requirements_team_exploring' && state.specialists?.active_relay) {
    state.specialists.active_relay.answer = answer;
    return;
  }

  if (state.phase === 'resume_detection') {
    const lowerAnswer = answer.toLowerCase();
    if (lowerAnswer.includes('fresh') || lowerAnswer.includes('reset') || lowerAnswer.includes('start fresh')) {
      // Reset and reinitialize
      resetPipelineDir(cwd);
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
      rebuildStateFromTasks(state, cwd);
      if (state.stages.length === 0) {
        state.phase = 'resume_detection';
      } else {
        state.phase = 'main_loop';
        state.step = 0;
      }
    } else if (lowerAnswer.includes('status') || lowerAnswer.includes('show')) {
      state.phase = 'resume_detection';
    }
    return;
  }

  if (state.phase === 'rca_consolidation' && state.step === 2) {
    if (state.rca_consolidation) {
      state.rca_consolidation.chosen_diagnosis_source = answer;
    }
    return;
  }

  if (state.phase === 'phased_implementation' && state.step === 6) {
    const lowerAnswer = answer.toLowerCase();
    if (lowerAnswer.includes('abort')) {
      state.terminal_state = 'user_aborted';
      state.terminal_reason = 'User aborted during phased implementation escalation.';
    }
    return;
  }

  // needs_clarification / partial: user response (dispatch step CLARIFY)
  if (state.phase === 'main_loop' && state.dispatch_step === DISPATCH_STEP.CLARIFY) {
    const lowerAnswer = answer.toLowerCase();
    if (lowerAnswer.includes('abort')) {
      state.terminal_state = 'user_aborted';
      state.terminal_reason = 'User aborted after partial/clarification prompt.';
      state.current_dispatch_index = null;
      state.dispatch_step = 0;
    }
    return;
  }

  // Rejected stage recovery
  if (state.phase === 'main_loop' && (state.terminal_state === 'plan_rejected' || state.terminal_state === 'code_rejected')) {
    const lowerAnswer = answer.toLowerCase();
    if (lowerAnswer.includes('needs_changes') || lowerAnswer.includes('treat')) {
      state.terminal_state = null;
      state.terminal_reason = null;
      const rejectedStage = state.stages.find(s => s.status === 'rejected');
      if (rejectedStage) {
        rejectedStage.status = 'needs_changes';
        rejectedStage.iteration_count++;
        const counterKey = `${rejectedStage.type}_${rejectedStage.index}`;
        state.global_iteration_counters[counterKey] =
          (state.global_iteration_counters[counterKey] || 0) + 1;
        state.current_dispatch_index = rejectedStage.index;
        state.dispatch_step = DISPATCH_STEP.FIX_FLOW;
      }
    }
    return;
  }
}

// ─── Result Processing ──────────────────────────────────────────────────────

export function processStageResult(
  state: PipelineState,
  cwd: string,
  stage: StageState,
  resultData: Record<string, unknown>,
): void {
  // Resolve the status field with three fallback layers:
  // 1. Top-level `status` (standard)
  // 2. Nested `review.status` (some API models nest it)
  // 3. Singleton manifest inference (planning/requirements/implementation have no status)
  const topStatus = resultData.status as string | undefined;
  const nestedStatus = !topStatus && resultData.review && typeof resultData.review === 'object'
    ? (resultData.review as Record<string, unknown>).status as string | undefined
    : undefined;
  const inferredStatus = ('artifact' in resultData || 'step_count' in resultData || 'ac_count' in resultData)
    ? 'complete'
    : undefined;
  const rawStatus = topStatus ?? nestedStatus ?? inferredStatus;

  // Normalize common synonyms from API models
  const STATUS_SYNONYMS: Record<string, string> = {
    passed: 'approved',
    pass: 'approved',
    completed: 'complete',
    done: 'complete',
    fail: 'failed',
    failure: 'failed',
    reject: 'rejected',
    denied: 'rejected',
    changes_needed: 'needs_changes',
    changes_required: 'needs_changes',
  };
  const status = rawStatus
    ? (STATUS_SYNONYMS[rawStatus.toLowerCase()] ?? rawStatus.toLowerCase())
    : undefined;

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
      stage.status = 'failed';
      state.terminal_reason = `Stage ${stage.type} returned unknown status: "${status || '(empty)'}"`;
      break;
  }

  // Update pipeline-tasks.json
  const config = loadPipelineConfig();
  writePipelineTasks(cwd, buildPipelineTasksJson(state, config));
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function resetPipelineDir(cwd: string): void {
  const taskDir = getTaskDir(cwd);
  if (fs.existsSync(taskDir)) {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
  fs.mkdirSync(taskDir, { recursive: true });
}
