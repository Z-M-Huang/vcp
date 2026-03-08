/**
 * Pipeline driver — phase handlers for init, resume, task chain, requirements, and specialist shutdown.
 *
 * Functions that need routeByPhase accept it as a PhaseRouter callback to avoid circular imports.
 */

import fs from 'fs';
import path from 'path';

import type { StageType } from '../types/stage-definitions.ts';
import type { PipelineCommand } from '../types/commands.ts';
import { makeCommandId } from '../types/commands.ts';
import type { PipelineState } from '../types/driver-state.ts';
import {
  getTaskPath,
  writeTempFile,
  readPipelineTasks,
  emitCommand,
  deriveSubject,
  deriveDescription,
  buildResolvedStageInfo,
} from './driver-state-io.ts';

/** Callback type for routeByPhase — avoids circular imports. */
export type PhaseRouter = (state: PipelineState, cwd: string) => PipelineCommand;

// ─── Phase: Init ────────────────────────────────────────────────────────────

export function handleInitPhase(state: PipelineState, cwd: string): PipelineCommand {
  switch (state.step) {
    case 0:
      // Need to create team first (happens on "start fresh" resume path)
      state.step = 1;
      return emitCommand(state, {
        action: 'create_team',
        team_name: state.team_name,
      });

    case 1:
      // Team was just created, now verify task tools
      state.step = 2;
      return emitCommand(state, { action: 'list_tasks' });

    case 2:
      // Task tools verified, now create task chain
      state.phase = 'task_chain_creation';
      state.step = 0;
      return handleTaskChainCreation(state, cwd);

    default:
      return emitCommand(state, {
        action: 'escalate',
        error: `Unexpected init step: ${state.step}`,
        context: 'Init phase',
      });
  }
}

// ─── Phase: Resume Detection ────────────────────────────────────────────────

export function handleResumePhase(state: PipelineState, _cwd: string): PipelineCommand {
  // Resume is initiated by ask_user response in report handler.
  // If we get here with no pending command, we need the user's choice.
  return emitCommand(state, {
    action: 'ask_user',
    question: 'Pipeline state found. How would you like to proceed?',
    options: [
      { label: 'Resume', description: 'Continue from where it left off' },
      { label: 'Start fresh', description: 'Reset and begin new pipeline' },
    ],
  });
}

/**
 * Migration guard: rebuild state.stages from an existing pipeline-tasks.json.
 * Handles both new-format (created by driver) and legacy-format (created by old SKILL.md).
 * Creates a backup of pipeline-tasks.json before any migration.
 */
export function rebuildStateFromTasks(state: PipelineState, cwd: string): void {
  const tasksData = readPipelineTasks(cwd);
  if (!tasksData) return;

  const stages = tasksData.stages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(stages) || stages.length === 0) return;

  // Backup old tasks file for safety
  const tasksPath = getTaskPath(cwd, 'pipeline-tasks.json');
  const backupPath = tasksPath + '.bak';
  try {
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(tasksPath, backupPath);
    }
  } catch { /* best-effort backup */ }

  // Restore team_name from pipeline-tasks.json
  if (typeof tasksData.team_name === 'string') {
    state.team_name = tasksData.team_name;
  }

  // Restore config_hash if available
  if (typeof tasksData.config_hash === 'string') {
    state.config_hash = tasksData.config_hash;
  }

  // Rebuild stages from tasks file
  state.stages = stages.map((s, i) => ({
    index: i,
    type: String(s.type ?? '') as StageType,
    provider: String(s.provider ?? ''),
    model: String(s.model ?? ''),
    providerType: (String(s.providerType ?? 'subscription')) as 'subscription' | 'api' | 'cli',
    output_file: String(s.output_file ?? ''),
    task_id: typeof s.task_id === 'string' ? s.task_id : null,
    parallel_group_id: typeof s.parallel_group_id === 'number' ? s.parallel_group_id : null,
    current_version: typeof s.current_version === 'number' ? s.current_version : 1,
    status: detectStageStatus(s, cwd) as 'pending' | 'in_progress' | 'completed' | 'needs_changes' | 'rejected' | 'failed',
    iteration_count: typeof s.iteration_count === 'number' ? s.iteration_count : 0,
  }));

  // Find first non-completed stage to set dispatch index, mapping dispatch_step by status.
  // Only set current_dispatch_index for stages that are mid-dispatch (in_progress/needs_changes/
  // rejected/failed). Pending stages are left for findNextActionableStage → dispatchStage,
  // which correctly emits update_task(in_progress) and updates pipeline-tasks.json first.
  const nextNonComplete = state.stages.findIndex(s => s.status !== 'completed');
  if (nextNonComplete >= 0) {
    const resumeStage = state.stages[nextNonComplete];
    if (resumeStage.status === 'needs_changes') {
      state.current_dispatch_index = nextNonComplete;
      state.dispatch_step = 10; // Enter fix flow directly
    } else if (resumeStage.status === 'in_progress' && resumeStage.providerType === 'api') {
      state.current_dispatch_index = nextNonComplete;
      state.dispatch_step = 1; // May need wait_for_task
    } else if (resumeStage.status === 'in_progress') {
      state.current_dispatch_index = nextNonComplete;
      state.dispatch_step = 2; // Read output file
    } else if (resumeStage.status === 'rejected' || resumeStage.status === 'failed') {
      // Reset to pending so findNextActionableStage → dispatchStage handles them.
      // This ensures update_task(in_progress) and pipeline-tasks.json sync happen first.
      resumeStage.status = 'pending';
    }
    // pending/rejected→pending/failed→pending: no current_dispatch_index
    // → normal main loop picks it up via dispatchStage
  }
}

/**
 * Infer stage status from output file existence.
 * If the stage's output file exists and contains valid content, mark as completed.
 */
export function detectStageStatus(
  stage: Record<string, unknown>,
  cwd: string,
): string {
  const outputFile = String(stage.output_file ?? '');
  if (!outputFile) return 'pending';

  const outputPath = getTaskPath(cwd, outputFile);
  try {
    if (!fs.existsSync(outputPath)) return 'pending';
    const content = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    if (content && typeof content === 'object') {
      if (content.status === 'rejected') return 'rejected';
      if (content.status === 'needs_changes') return 'needs_changes';
      if (content.status === 'failed') return 'failed';
      return 'completed';
    }
    return 'completed'; // Non-JSON or non-object content but file exists → treat as complete
  } catch {
    return 'pending';
  }
}

// ─── Phase: Task Chain Creation ─────────────────────────────────────────────

export function handleTaskChainCreation(state: PipelineState, cwd: string): PipelineCommand {
  // Post-batch: report handler set step >= stages.length → move to dependencies
  if (state.step >= state.stages.length) {
    state.phase = 'task_chain_dependencies';
    state.step = 0;
    return handleTaskChainDependencies(state, cwd, handleTaskChainDependencies);
  }

  // Idempotency: filter to stages without task_ids (handles partial replay)
  const stagesToCreate = state.stages
    .map((stage, idx) => ({ stage, idx }))
    .filter(({ stage }) => !stage.task_id);

  if (stagesToCreate.length === 0) {
    // All stages already have task_ids — skip to dependencies
    state.phase = 'task_chain_dependencies';
    state.step = 0;
    return handleTaskChainDependencies(state, cwd, handleTaskChainDependencies);
  }

  // Build batch of create_task sub-commands
  const batchCmdToStage: Record<string, number> = {};
  const commands = stagesToCreate.map(({ stage, idx }) => {
    const cmdId = makeCommandId();
    batchCmdToStage[cmdId] = idx;
    const resolvedInfo = buildResolvedStageInfo(stage, state);
    return {
      command_id: cmdId,
      action: 'create_task' as const,
      subject: deriveSubject(resolvedInfo),
      description: deriveDescription(state, stage, resolvedInfo, cwd),
      activeForm: `Setting up ${stage.type}...`,
    };
  });

  state.batch_cmd_to_stage = batchCmdToStage;
  // Do NOT advance state.step — report handler does that after successful processing
  return emitCommand(state, {
    action: 'parallel_batch',
    commands,
  });
}

// ─── Phase: Task Chain Dependencies ─────────────────────────────────────────

export function handleTaskChainDependencies(state: PipelineState, _cwd: string, _routeByPhase?: PhaseRouter): PipelineCommand {
  // Post-batch: report handler set step >= stages.length → show status + transition
  if (state.step >= state.stages.length) {
    if (state.pipeline === 'feature') {
      state.phase = 'requirements';
      state.step = 0;
    } else {
      state.phase = 'main_loop';
      state.step = 0;
    }
    return emitCommand(state, {
      action: 'show_status',
      message: `Pipeline initialized with ${state.stages.length} stages. Starting execution.`,
    });
  }

  // Build batch of update_task sub-commands for all stages with predecessors
  const batchCmdToStage: Record<string, number> = {};
  const commands: Array<{
    command_id: string;
    action: 'update_task';
    taskId: string;
    addBlockedBy: string[];
  }> = [];

  for (let i = 0; i < state.stages.length; i++) {
    const stage = state.stages[i];
    if (!stage.task_id) continue;

    const predecessors = computePredecessors(state, i);
    if (predecessors.length === 0) continue;

    const cmdId = makeCommandId();
    batchCmdToStage[cmdId] = i;
    commands.push({
      command_id: cmdId,
      action: 'update_task',
      taskId: stage.task_id,
      addBlockedBy: predecessors,
    });
  }

  if (commands.length === 0) {
    // No dependencies to wire — go straight to show_status
    state.step = state.stages.length;
    return handleTaskChainDependencies(state, _cwd);
  }

  state.batch_cmd_to_stage = batchCmdToStage;
  // Do NOT advance state.step — report handler does that
  return emitCommand(state, {
    action: 'parallel_batch',
    commands,
  });
}

/**
 * Compute predecessor task IDs for a given stage index using fan-out/fan-in rules.
 */
function computePredecessors(state: PipelineState, stageIndex: number): string[] {
  if (stageIndex === 0) return [];

  const stage = state.stages[stageIndex];
  const prevStage = state.stages[stageIndex - 1];

  // Same parallel group as previous stage → same predecessors (fan-out)
  if (
    stage.parallel_group_id !== null &&
    prevStage.parallel_group_id === stage.parallel_group_id
  ) {
    // Find the first stage in this group and copy its predecessors
    const groupStart = findGroupStart(state, stageIndex);
    if (groupStart > 0) {
      return computePredecessorsForGroupStart(state, groupStart);
    }
    return [];
  }

  // Check if previous stage was in a parallel group (fan-in)
  if (prevStage.parallel_group_id !== null && stage.parallel_group_id !== prevStage.parallel_group_id) {
    // Fan-in: depend on ALL members of the previous group
    const groupMembers = state.stages
      .filter(s => s.parallel_group_id === prevStage.parallel_group_id && s.task_id)
      .map(s => s.task_id!);
    return groupMembers;
  }

  // Sequential: depend on previous stage
  if (prevStage.task_id) {
    return [prevStage.task_id];
  }

  return [];
}

export function findGroupStart(state: PipelineState, stageIndex: number): number {
  const groupId = state.stages[stageIndex].parallel_group_id;
  for (let i = stageIndex - 1; i >= 0; i--) {
    if (state.stages[i].parallel_group_id !== groupId) return i + 1;
  }
  return 0;
}

function computePredecessorsForGroupStart(state: PipelineState, groupStartIndex: number): string[] {
  if (groupStartIndex === 0) return [];
  const prevStage = state.stages[groupStartIndex - 1];
  if (prevStage.parallel_group_id !== null) {
    // Previous was also a group — fan-in
    const groupMembers = state.stages
      .filter(s => s.parallel_group_id === prevStage.parallel_group_id && s.task_id)
      .map(s => s.task_id!);
    return groupMembers;
  }
  return prevStage.task_id ? [prevStage.task_id] : [];
}

// ─── Phase: Requirements (Feature Pipeline) ─────────────────────────────────

export function handleRequirementsPhase(state: PipelineState, cwd: string, routeByPhase: PhaseRouter): PipelineCommand {
  switch (state.step) {
    case 0: {
      // Mark requirements task as in_progress
      const reqStage = state.stages.find(s => s.type === 'requirements');
      if (reqStage?.task_id) {
        state.step = 1;
        return emitCommand(state, {
          action: 'update_task',
          taskId: reqStage.task_id,
          status: 'in_progress',
        });
      }
      // No requirements stage — skip
      state.phase = 'main_loop';
      return routeByPhase(state, cwd);
    }

    case 1: {
      // VCP detection: try reading .vcp/config.json
      state.step = 2;
      return emitCommand(state, {
        action: 'read_file',
        path: path.join(cwd, '.vcp', 'config.json'),
      });
    }

    case 2: {
      // Spawn specialists as parallel batch
      const specialists = buildSpecialistBatch(state, cwd);
      state.specialists = {
        approved_specialists: specialists.map(s => ({
          name: s.name,
          type: s.type,
          expected_analysis_file: s.expected_analysis_file,
          status: 'spawned' as const,
        })),
        spawn_failures: [],
        interactive_loop_active: false,
      };
      state.phase = 'requirements_team_pending';
      state.step = 3;

      const spawnCommands: PipelineCommand[] = specialists.map(s => ({
        command_id: makeCommandId(),
        state_version: state.state_version,
        action: 'spawn_teammate' as const,
        subagent_type: 'general-purpose',
        name: s.name,
        team_name: state.team_name,
        prompt_file: s.prompt_file,
      }));

      return emitCommand(state, {
        action: 'parallel_batch',
        commands: spawnCommands,
      });
    }

    case 3: {
      // Spawn verification — check which specialists succeeded
      state.phase = 'requirements_team_exploring';
      state.step = 4;
      if (state.specialists) {
        state.specialists.interactive_loop_active = true;
      }
      return emitCommand(state, {
        action: 'receive_messages',
      });
    }

    case 4: {
      // Interactive loop: check if specialists are done, then advance to validation
      const allDone = state.specialists?.approved_specialists.every(
        s => s.status === 'completed' || s.status === 'shutdown' || s.status === 'failed'
      ) ?? true;

      if (allDone) {
        // All specialists finished — advance to validation
        if (state.specialists) state.specialists.interactive_loop_active = false;
        state.step = 5;
        return routeByPhase(state, cwd);
      }

      // Still waiting — receive messages from specialists
      return emitCommand(state, {
        action: 'receive_messages',
      });
    }

    case 5: {
      // Validate analysis files
      const expectedFiles = state.specialists?.approved_specialists
        .map(s => s.expected_analysis_file) || [];
      const readCmds: PipelineCommand[] = expectedFiles.map(f => ({
        command_id: makeCommandId(),
        state_version: state.state_version,
        action: 'read_file' as const,
        path: getTaskPath(cwd, f),
      }));

      if (readCmds.length === 0) {
        state.step = 6;
        return routeByPhase(state, cwd);
      }

      state.step = 6; // Advance BEFORE emitting so we don't re-enter step 5
      return emitCommand(state, {
        action: 'parallel_batch',
        commands: readCmds,
      });
    }

    case 6: {
      // Synthesize via requirements-gatherer
      const promptContent = buildSynthesisPrompt(state, cwd);
      const promptFile = writeTempFile(cwd, 'prompt', makeCommandId(), promptContent);
      state.step = 7; // Advance BEFORE emitting so we don't re-dispatch synthesis
      return emitCommand(state, {
        action: 'spawn_agent',
        subagent_type: 'dev-buddy:requirements-gatherer',
        name: 'requirements-gatherer',
        model: state.stages.find(s => s.type === 'requirements')?.model || 'opus',
        prompt_file: promptFile,
      });
    }

    case 7: {
      // Shutdown specialists
      state.phase = 'specialist_shutdown';
      state.step = 0;
      return handleSpecialistShutdown(state, cwd, routeByPhase);
    }

    default:
      return emitCommand(state, {
        action: 'escalate',
        error: `Unexpected requirements step: ${state.step}`,
        context: 'Requirements phase',
      });
  }
}

function buildSpecialistBatch(state: PipelineState, cwd: string): Array<{
  name: string;
  type: string;
  expected_analysis_file: string;
  prompt_file: string;
}> {
  const specialists = [
    { name: 'technical-analyst', type: 'technical', expected_analysis_file: 'analysis-technical.json' },
    { name: 'ux-domain-analyst', type: 'ux-domain', expected_analysis_file: 'analysis-ux-domain.json' },
    { name: 'security-analyst', type: 'security', expected_analysis_file: 'analysis-security.json' },
    { name: 'performance-analyst', type: 'performance', expected_analysis_file: 'analysis-performance.json' },
    { name: 'architecture-analyst', type: 'architecture', expected_analysis_file: 'analysis-architecture.json' },
  ];

  return specialists.map(s => {
    let prompt = `You are a ${s.type.charAt(0).toUpperCase() + s.type.slice(1)} Analyst. `;
    prompt += `Explore the codebase and domain. Write your analysis to .vcp/task/${s.expected_analysis_file}. `;
    prompt += `Message key findings to lead as you discover them.`;

    // VCP-aware security prompt
    if (s.name === 'security-analyst' && state.vcp_detection.detected) {
      state.vcp_detection.context_injected = true;
      prompt = `You are a Security Analyst. This project uses VCP standards. ` +
        `Perform VCP-aware security analysis. Write to .vcp/task/${s.expected_analysis_file}. ` +
        `Message key findings to lead as you discover them.`;
    }

    const promptFile = writeTempFile(cwd, `specialist-${s.name}`, makeCommandId(), prompt);
    return { ...s, prompt_file: promptFile };
  });
}

function buildSynthesisPrompt(state: PipelineState, _cwd: string): string {
  const approved = state.specialists?.approved_specialists
    .filter(s => s.status === 'completed' || s.status === 'spawned')
    .map(s => s.name) || [];

  return [
    `Synthesis mode.`,
    `APPROVED SPECIALISTS: ${approved.join(', ')}`,
    `Read the validated analysis files from .vcp/task/.`,
    `Validate scope with user via AskUserQuestion.`,
    `Get explicit approval before writing user-story.`,
  ].join('\n');
}

// ─── Phase: Specialist Shutdown ─────────────────────────────────────────────

export function handleSpecialistShutdown(state: PipelineState, _cwd: string, routeByPhase: PhaseRouter): PipelineCommand {
  if (!state.specialists) {
    state.phase = 'main_loop';
    state.step = 0;
    return emitCommand(state, {
      action: 'noop',
      message: 'No specialists to shut down.',
    });
  }

  const activeSpecialists = state.specialists.approved_specialists
    .filter(s => s.status === 'spawned' || s.status === 'completed');

  if (state.step >= activeSpecialists.length) {
    // All shutdown requests sent. Mark requirements complete, enter main loop.
    const reqStage = state.stages.find(s => s.type === 'requirements');
    if (reqStage) {
      reqStage.status = 'completed';
      if (reqStage.task_id) {
        state.phase = 'main_loop';
        state.step = 0;
        return emitCommand(state, {
          action: 'update_task',
          taskId: reqStage.task_id,
          status: 'completed',
        });
      }
    }
    state.phase = 'main_loop';
    state.step = 0;
    return routeByPhase(state, _cwd);
  }

  if (activeSpecialists.length === 0) {
    // No active specialists — skip to post-shutdown
    state.step = 0;
    return handleSpecialistShutdown(state, _cwd, routeByPhase);
  }

  // Batch all shutdown commands into a single parallel_batch
  const commands = activeSpecialists.map(specialist => ({
    command_id: makeCommandId(),
    action: 'shutdown_teammate' as const,
    recipient: specialist.name,
    max_retries: 2,
  }));

  state.step = activeSpecialists.length;
  return emitCommand(state, {
    action: 'parallel_batch',
    commands,
  });
}
