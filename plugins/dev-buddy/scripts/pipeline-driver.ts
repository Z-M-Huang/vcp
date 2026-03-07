#!/usr/bin/env bun
/**
 * Pipeline driver — TypeScript state machine for orchestrating the dev-buddy pipeline.
 *
 * Outputs JSON commands to stdout. The SKILL.md executor loop calls this script,
 * parses the command, executes it via Claude Code tools, and reports back.
 *
 * CLI:
 *   bun pipeline-driver.ts init    --pipeline feature|bugfix --cwd <dir>
 *   bun pipeline-driver.ts next    --cwd <dir>
 *   bun pipeline-driver.ts report  --cwd <dir> --id <cmd_id> --result-file <path>
 *   bun pipeline-driver.ts status  --cwd <dir>
 *   bun pipeline-driver.ts reset   --cwd <dir>
 *
 * Logic is split across focused modules in scripts/:
 *   driver-state-io.ts    — constants, paths, state I/O, emitCommand, derivation helpers
 *   driver-phases.ts      — init, resume, task chain, requirements, specialist shutdown
 *   driver-main-loop.ts   — main loop dispatch, stage dispatch, parallel groups
 *   driver-rca.ts         — RCA consolidation (bugfix pipeline)
 *   driver-phased-impl.ts — phased implementation sub-state machine
 *   driver-reports.ts     — report processing, user answer handling, stage result processing
 */

import fs from 'fs';

import type { PipelineCommand, CommandReport } from '../types/commands.ts';
import { makeCommandId } from '../types/commands.ts';
import { createInitialState } from '../types/driver-state.ts';
import type { PipelineState } from '../types/driver-state.ts';
import { loadPipelineConfig } from './pipeline-config.ts';

// ─── Module Imports ─────────────────────────────────────────────────────────

import {
  getTaskDir,
  deriveTeamName,
  computeConfigHash,
  resolveStages,
  readState,
  writeState,
  readPipelineTasks,
  writePipelineTasks,
  buildPipelineTasksJson,
  emitCommand,
  emitAndSave,
} from './driver-state-io.ts';

import {
  handleInitPhase,
  handleResumePhase,
  handleTaskChainCreation,
  handleTaskChainDependencies,
  handleRequirementsPhase,
  handleSpecialistShutdown,
} from './driver-phases.ts';

import {
  handleMainLoop,
} from './driver-main-loop.ts';

import {
  checkRcaConsolidationNeeded,
  handleRcaConsolidation,
} from './driver-rca.ts';

import {
  handlePhasedImplementation,
} from './driver-phased-impl.ts';

import {
  handleReport,
} from './driver-reports.ts';

// ─── INIT Command ───────────────────────────────────────────────────────────

function handleInit(
  pipelineType: 'feature' | 'bugfix',
  cwd: string,
): PipelineCommand {
  const config = loadPipelineConfig();
  const pipeline = pipelineType === 'feature'
    ? config.feature_pipeline
    : config.bugfix_pipeline;
  const teamName = deriveTeamName(cwd);
  const configHash = computeConfigHash(config);

  // Check for existing state (resume detection)
  const existingTasks = readPipelineTasks(cwd);
  if (existingTasks) {
    // Existing pipeline detected — return ask_user for resume decision
    const state = createInitialState(pipelineType, teamName, configHash);
    state.phase = 'resume_detection';

    const existingHash = existingTasks.config_hash as string | undefined;
    const hashMatch = existingHash === configHash;

    const cmd = emitCommand(state, {
      action: 'ask_user',
      question: 'Previous pipeline detected. How would you like to proceed?',
      options: [
        { label: 'Resume', description: 'Continue from where it left off' },
        { label: 'Start fresh', description: 'Reset and begin new pipeline' },
        { label: 'Show status', description: 'Show detailed progress first' },
      ],
      context: hashMatch
        ? 'Config matches the saved pipeline.'
        : 'Config has changed since this pipeline was created.',
    });

    writeState(cwd, state);
    return cmd;
  }

  // Fresh start
  const state = createInitialState(pipelineType, teamName, configHash);
  const resolved = resolveStages(pipeline, config);

  // Populate stages
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

  // Transition to team creation phase
  state.phase = 'init';
  state.step = 1;

  // First command: create the pipeline team
  const cmd = emitCommand(state, {
    action: 'create_team',
    team_name: teamName,
  });

  // Write state AFTER emitCommand so pending_command is persisted
  writeState(cwd, state);
  return cmd;
}

// ─── NEXT Command (Main State Machine) ─────────────────────────────────────

function handleNext(cwd: string): PipelineCommand {
  const state = readState(cwd);
  if (!state) {
    return {
      command_id: makeCommandId(),
      state_version: 0,
      action: 'escalate',
      error: 'No pipeline state found. Run init first.',
      context: 'Pipeline not initialized',
    } as PipelineCommand;
  }

  // Increment state version on every next call
  state.state_version++;

  // If there's an unacknowledged pending command, replay it
  if (state.pending_command) {
    // Update state version on the replayed command
    state.pending_command.state_version = state.state_version;
    writeState(cwd, state);
    return state.pending_command;
  }

  // Check terminal state
  if (state.terminal_state) {
    return emitAndSave(state, cwd, {
      action: 'done',
      summary: state.terminal_reason || 'Pipeline completed.',
      terminal_state: state.terminal_state,
      terminal_reason: state.terminal_reason ?? undefined,
    });
  }

  // Check paused state
  if (state.paused) {
    return emitAndSave(state, cwd, {
      action: 'pause',
      reason: state.pause_reason || 'Pipeline is paused.',
      resume_condition: 'User must explicitly confirm to resume.',
    });
  }

  // Route by phase
  const cmd = routeByPhase(state, cwd);
  writeState(cwd, state);
  return cmd;
}

/**
 * Core state machine routing. Determines the next command based on current phase.
 */
function routeByPhase(state: PipelineState, cwd: string): PipelineCommand {
  switch (state.phase) {
    case 'init':
      return handleInitPhase(state, cwd);
    case 'resume_detection':
      return handleResumePhase(state, cwd);
    case 'task_chain_creation':
      return handleTaskChainCreation(state, cwd);
    case 'task_chain_dependencies':
      return handleTaskChainDependencies(state, cwd, routeByPhase);
    case 'requirements':
    case 'requirements_team_pending':
    case 'requirements_team_exploring':
      return handleRequirementsPhase(state, cwd, routeByPhase);
    case 'main_loop':
      return handleMainLoop(
        state, cwd, routeByPhase,
        handleRcaConsolidation,
        (s, c) => handlePhasedImplementation(s, c, routeByPhase),
        checkRcaConsolidationNeeded,
      );
    case 'rca_consolidation':
      return handleRcaConsolidation(state, cwd);
    case 'phased_implementation':
      return handlePhasedImplementation(state, cwd, routeByPhase);
    case 'specialist_shutdown':
      return handleSpecialistShutdown(state, cwd, routeByPhase);
    default:
      // If we have stages, try the main loop
      if (state.stages.length > 0) {
        state.phase = 'main_loop';
        return handleMainLoop(
          state, cwd, routeByPhase,
          handleRcaConsolidation,
          (s, c) => handlePhasedImplementation(s, c, routeByPhase),
          checkRcaConsolidationNeeded,
        );
      }
      return emitCommand(state, {
        action: 'escalate',
        error: `Unknown phase: ${state.phase}`,
        context: 'Pipeline driver entered an unexpected state.',
      });
  }
}

// ─── STATUS Command ─────────────────────────────────────────────────────────

function handleStatus(cwd: string): void {
  const state = readState(cwd);
  if (!state) {
    console.log(JSON.stringify({ phase: 'idle', message: 'No pipeline state found.' }));
    return;
  }

  const stagesSummary = state.stages.map(s => ({
    index: s.index,
    type: s.type,
    status: s.status,
    provider: s.provider,
    model: s.model,
    output_file: s.output_file,
    task_id: s.task_id,
  }));

  console.log(JSON.stringify({
    phase: state.phase,
    step: state.step,
    pipeline: state.pipeline,
    team_name: state.team_name,
    state_version: state.state_version,
    terminal_state: state.terminal_state,
    paused: state.paused,
    stages: stagesSummary,
  }, null, 2));
}

// ─── RESET Command ──────────────────────────────────────────────────────────

function resetPipeline(cwd: string): void {
  const taskDir = getTaskDir(cwd);
  if (fs.existsSync(taskDir)) {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
  fs.mkdirSync(taskDir, { recursive: true });
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  // Parse --cwd
  let cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cwdIdx = args.indexOf('--cwd');
  if (cwdIdx >= 0 && args[cwdIdx + 1]) {
    cwd = args[cwdIdx + 1];
  }

  // Parse --pipeline
  let pipelineType: 'feature' | 'bugfix' = 'feature';
  const pipelineIdx = args.indexOf('--pipeline');
  if (pipelineIdx >= 0 && args[pipelineIdx + 1]) {
    pipelineType = args[pipelineIdx + 1] === 'bugfix' ? 'bugfix' : 'feature';
  }

  // Parse --id
  let commandId = '';
  const idIdx = args.indexOf('--id');
  if (idIdx >= 0 && args[idIdx + 1]) {
    commandId = args[idIdx + 1];
  }

  // Parse --result-file
  let resultFile = '';
  const rfIdx = args.indexOf('--result-file');
  if (rfIdx >= 0 && args[rfIdx + 1]) {
    resultFile = args[rfIdx + 1];
  }

  try {
    switch (command) {
      case 'init': {
        const cmd = handleInit(pipelineType, cwd);
        console.log(JSON.stringify(cmd));
        break;
      }

      case 'next': {
        const cmd = handleNext(cwd);
        console.log(JSON.stringify(cmd));
        break;
      }

      case 'report': {
        if (!commandId) {
          console.error(JSON.stringify({ error: 'Missing --id parameter' }));
          process.exit(1);
        }
        let report: CommandReport;
        if (resultFile) {
          report = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as CommandReport;
        } else {
          // Read from stdin
          const stdin = fs.readFileSync('/dev/stdin', 'utf-8');
          report = JSON.parse(stdin) as CommandReport;
        }
        report.command_id = commandId;
        const result = handleReport(cwd, commandId, report);
        if (result === 'mismatch') {
          // handleReport already wrote error to stderr
          process.exit(1);
        } else if (result) {
          console.log(JSON.stringify(result));
        } else {
          console.log(JSON.stringify({ ok: true, acknowledged: commandId }));
        }
        break;
      }

      case 'status':
        handleStatus(cwd);
        break;

      case 'reset':
        resetPipeline(cwd);
        console.log(JSON.stringify({ ok: true, message: 'Pipeline reset complete.' }));
        break;

      default:
        console.error('Usage: bun pipeline-driver.ts {init|next|report|status|reset} [options]');
        console.error('');
        console.error('Commands:');
        console.error('  init    --pipeline feature|bugfix --cwd <dir>');
        console.error('  next    --cwd <dir>');
        console.error('  report  --cwd <dir> --id <cmd_id> --result-file <path>');
        console.error('  status  --cwd <dir>');
        console.error('  reset   --cwd <dir>');
        process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ error: message }));
    process.exit(1);
  }
}
