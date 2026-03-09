/**
 * Pipeline driver — phase handlers for init, resume, requirements, and specialist shutdown.
 *
 * Functions that need routeByPhase accept it as a PhaseRouter callback to avoid circular imports.
 */

import fs from 'fs';
import path from 'path';

import type { StageType } from '../types/stage-definitions.ts';
import type { PipelineCommand } from '../types/commands.ts';
import { makeCommandId, REQ_STEP, DISPATCH_STEP } from '../types/commands.ts';
import type { PipelineState } from '../types/driver-state.ts';
import {
  getTaskPath,
  writeTempFile,
  readPipelineTasks,
  emitCommand,
} from './driver-state-io.ts';
import { driverLog } from './vcp-logger.ts';

/** Callback type for routeByPhase — avoids circular imports. */
export type PhaseRouter = (state: PipelineState, cwd: string) => PipelineCommand;

// ─── Phase: Init ────────────────────────────────────────────────────────────

export function handleInitPhase(state: PipelineState, cwd: string): PipelineCommand {
  driverLog('phase-init', 'info', `step=${state.step}`);
  // Init is a single-step transition to requirements or main_loop
  if (state.pipeline === 'feature') {
    driverLog('phase-transition', 'info', 'init → requirements');
    state.phase = 'requirements';
  } else {
    driverLog('phase-transition', 'info', 'init → main_loop');
    state.phase = 'main_loop';
  }
  state.step = 0;
  return emitCommand(state, {
    action: 'noop',
    message: 'Init complete — transitioning to next phase.',
  });
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

  // Restore description if available
  if (typeof tasksData.description === 'string') {
    state.description = tasksData.description;
  }

  // Rebuild stages from tasks file (task_id ignored — no longer tracked)
  state.stages = stages.map((s, i) => ({
    index: i,
    type: String(s.type ?? '') as StageType,
    provider: String(s.provider ?? ''),
    model: String(s.model ?? ''),
    providerType: (String(s.providerType ?? 'subscription')) as 'subscription' | 'api' | 'cli',
    output_file: String(s.output_file ?? ''),
    parallel_group_id: typeof s.parallel_group_id === 'number' ? s.parallel_group_id : null,
    current_version: typeof s.current_version === 'number' ? s.current_version : 1,
    status: detectStageStatus(s, cwd) as 'pending' | 'in_progress' | 'completed' | 'needs_changes' | 'rejected' | 'failed',
    iteration_count: typeof s.iteration_count === 'number' ? s.iteration_count : 0,
  }));

  // Find first non-completed stage to set dispatch index, mapping dispatch_step by status.
  const nextNonComplete = state.stages.findIndex(s => s.status !== 'completed');
  if (nextNonComplete >= 0) {
    const resumeStage = state.stages[nextNonComplete];
    if (resumeStage.status === 'needs_changes') {
      state.current_dispatch_index = nextNonComplete;
      state.dispatch_step = DISPATCH_STEP.FIX_FLOW;
    } else if (resumeStage.status === 'in_progress' && resumeStage.providerType === 'api') {
      state.current_dispatch_index = nextNonComplete;
      state.dispatch_step = DISPATCH_STEP.AGENT; // May need wait_for_task
    } else if (resumeStage.status === 'in_progress') {
      state.current_dispatch_index = nextNonComplete;
      state.dispatch_step = DISPATCH_STEP.READ_OUTPUT;
    } else if (resumeStage.status === 'rejected' || resumeStage.status === 'failed') {
      // Reset to pending so findNextActionableStage → dispatchStage handles them.
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

export function findGroupStart(state: PipelineState, stageIndex: number): number {
  const groupId = state.stages[stageIndex].parallel_group_id;
  for (let i = stageIndex - 1; i >= 0; i--) {
    if (state.stages[i].parallel_group_id !== groupId) return i + 1;
  }
  return 0;
}

// ─── Phase: Requirements (Feature Pipeline) ─────────────────────────────────

export function handleRequirementsPhase(state: PipelineState, cwd: string, routeByPhase: PhaseRouter): PipelineCommand {
  driverLog('phase-requirements', 'info', `step=${state.step} phase=${state.phase}`);
  switch (state.step) {
    case REQ_STEP.CHECK_STAGE: {
      // Check requirements stage exists
      const reqStage = state.stages.find(s => s.type === 'requirements');
      if (!reqStage) {
        // No requirements stage — skip
        state.phase = 'main_loop';
        return routeByPhase(state, cwd);
      }
      // Advance to VCP detection
      state.step = REQ_STEP.VCP_DETECT;
      return emitCommand(state, {
        action: 'read_file',
        path: path.join(cwd, '.vcp', 'config.json'),
      });
    }

    case REQ_STEP.VCP_DETECT: {
      // VCP detection result handled in report handler, now create team
      state.step = REQ_STEP.CREATE_TEAM;
      return emitCommand(state, {
        action: 'noop',
        message: 'VCP detection complete.',
      });
    }

    case REQ_STEP.CREATE_TEAM: {
      // Create team for specialist spawn
      state.step = REQ_STEP.SPAWN_SPECS;
      return emitCommand(state, {
        action: 'create_team',
        team_name: state.team_name,
      });
    }

    case REQ_STEP.SPAWN_SPECS: {
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
        pending_questions: [],
        qa_transcript: [],
      };
      state.phase = 'requirements_team_pending';
      state.step = REQ_STEP.VERIFY_SPAWN;

      const spawnCommands: PipelineCommand[] = specialists.map(s => ({
        command_id: makeCommandId(),
        state_version: state.state_version,
        action: 'spawn_teammate' as const,
        subagent_type: 'general-purpose',
        name: s.name,
        team_name: state.team_name,
        prompt_file: s.prompt_file,
      }));

      // Map sub-command IDs → specialist indices for post-iteration validation
      const spawnMapping: Record<string, number> = {};
      spawnCommands.forEach((cmd, idx) => { spawnMapping[cmd.command_id] = idx; });
      state.batch_cmd_to_stage = spawnMapping;

      return emitCommand(state, {
        action: 'parallel_batch',
        commands: spawnCommands,
      });
    }

    case REQ_STEP.VERIFY_SPAWN: {
      // Spawn verification — check which specialists succeeded
      state.phase = 'requirements_team_exploring';
      state.step = REQ_STEP.QA_RELAY;
      if (state.specialists) {
        state.specialists.interactive_loop_active = true;
      }
      return emitCommand(state, {
        action: 'receive_messages',
      });
    }

    case REQ_STEP.QA_RELAY: {
      const specs = state.specialists!;

      // (B) Active relay with answer: emit send_message to specialist
      if (specs.active_relay?.answer) {
        driverLog('qa-relay-answer', 'info', `specialist=${specs.active_relay.specialist_name}`);
        const relay = specs.active_relay;
        const content = `Answer to your question: "${relay.question}"\n\n${relay.answer}`;
        const contentFile = writeTempFile(cwd, `qa-reply-${relay.specialist_name}`, makeCommandId(), content);
        // Do NOT clear active_relay here — cleared in send_message report handler
        return emitCommand(state, {
          action: 'send_message',
          recipient: relay.specialist_name,
          content_file: contentFile,
          summary: 'Answer to your question',
        });
      }

      // (C) Active relay without answer: emit ask_user
      if (specs.active_relay && !specs.active_relay.answer) {
        return emitCommand(state, {
          action: 'ask_user',
          question: specs.active_relay.question,
          context: `${specs.active_relay.specialist_name} needs this information to continue their analysis`,
        });
      }

      // (D) Pending questions in queue: pop first → start relay
      if (specs.pending_questions.length > 0) {
        const nextQ = specs.pending_questions.shift()!;
        driverLog('qa-relay-question', 'info', `specialist=${nextQ.specialist_name}`);
        specs.active_relay = { specialist_name: nextQ.specialist_name, question: nextQ.question };
        return emitCommand(state, {
          action: 'ask_user',
          question: nextQ.question,
          context: `${nextQ.specialist_name} needs this information to continue their analysis`,
        });
      }

      // (E) Normal polling: check if all done
      const allDone = specs.approved_specialists.every(
        s => s.status === 'completed' || s.status === 'shutdown' || s.status === 'failed'
      );

      if (allDone) {
        driverLog('specialists-complete', 'info', 'All specialists done — advancing to analysis read');
        specs.interactive_loop_active = false;
        state.step = REQ_STEP.READ_ANALYSES;
        return routeByPhase(state, cwd);
      }

      // Still waiting — receive messages from specialists
      return emitCommand(state, {
        action: 'receive_messages',
      });
    }

    case REQ_STEP.READ_ANALYSES: {
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
        state.step = REQ_STEP.SHUTDOWN_SPECS;
        return routeByPhase(state, cwd);
      }

      // Map sub-command IDs → specialist indices for post-iteration validation
      const readMapping: Record<string, number> = {};
      readCmds.forEach((cmd, idx) => { readMapping[cmd.command_id] = idx; });
      state.batch_cmd_to_stage = readMapping;

      return emitCommand(state, {
        action: 'parallel_batch',
        commands: readCmds,
      });
    }

    case REQ_STEP.SHUTDOWN_SPECS: {
      // Guard: if no specialists completed, don't attempt synthesis
      const completedCount = state.specialists?.approved_specialists
        .filter(s => s.status === 'completed').length ?? 0;
      if (completedCount === 0 && (state.specialists?.approved_specialists.length ?? 0) > 0) {
        state.terminal_state = 'implementation_failed';
        state.terminal_reason = 'All specialist spawns failed — no analysis available for synthesis';
        return emitCommand(state, {
          action: 'noop',
          message: 'All specialists failed. Cannot proceed with requirements synthesis.',
        });
      }

      // Shut down specialists BEFORE spawning requirements-gatherer.
      const activeSpecialists = state.specialists?.approved_specialists
        .filter(s => s.status === 'spawned' || s.status === 'completed') || [];

      if (activeSpecialists.length === 0) {
        // No specialists to shutdown — skip to delete_team
        state.step = REQ_STEP.DELETE_TEAM;
        return routeByPhase(state, cwd);
      }

      const shutdownCommands: PipelineCommand[] = activeSpecialists.map(s => ({
        command_id: makeCommandId(),
        state_version: state.state_version,
        action: 'shutdown_teammate' as const,
        recipient: s.name,
        max_retries: 2,
      }));

      state.step = REQ_STEP.MARK_SHUTDOWN; // Advance BEFORE emitting
      return emitCommand(state, {
        action: 'parallel_batch',
        commands: shutdownCommands,
      });
    }

    case REQ_STEP.MARK_SHUTDOWN: {
      // Specialist shutdown batch acknowledged — mark specialists as shutdown
      if (state.specialists) {
        for (const s of state.specialists.approved_specialists) {
          if (s.status === 'spawned' || s.status === 'completed') {
            s.status = 'shutdown';
          }
        }
        state.specialists.interactive_loop_active = false;
      }
      state.step = REQ_STEP.DELETE_TEAM;
      return routeByPhase(state, cwd);
    }

    case REQ_STEP.DELETE_TEAM: {
      // Delete team to ensure clean foreground context for requirements-gatherer.
      state.step = REQ_STEP.SYNTHESIS;
      return emitCommand(state, {
        action: 'delete_team',
        team_name: state.team_name,
      });
    }

    case REQ_STEP.SYNTHESIS: {
      // Synthesize via requirements-gatherer (no team = guaranteed foreground agent).
      driverLog('requirements-synthesis', 'info', 'Spawning requirements-gatherer (foreground)');
      const promptContent = buildSynthesisPrompt(state, cwd);
      const promptFile = writeTempFile(cwd, 'prompt', makeCommandId(), promptContent);
      state.step = REQ_STEP.MANIFEST_READ; // Advance BEFORE emitting so we don't re-dispatch synthesis
      return emitCommand(state, {
        action: 'spawn_agent',
        subagent_type: 'dev-buddy:requirements-gatherer',
        name: 'requirements-gatherer',
        model: state.stages.find(s => s.type === 'requirements')?.model || 'opus',
        prompt_file: promptFile,
      });
    }

    case REQ_STEP.MANIFEST_READ: {
      // Wait for requirements-gatherer to complete by reading output file.
      state.manifest_retry_count = state.manifest_retry_count || 0;
      const reqStage = state.stages.find(s => s.type === 'requirements');
      const outputFile = reqStage?.output_file || 'user-story/manifest.json';
      return emitCommand(state, {
        action: 'read_file',
        path: getTaskPath(cwd, outputFile),
      });
    }

    case REQ_STEP.MANIFEST_ESCALATE: {
      // Retry exhausted — ask user whether to retry synthesis or abort.
      driverLog('manifest-escalate', 'info', 'Escalating manifest failure to user');
      return emitCommand(state, {
        action: 'escalate',
        error: 'Requirements manifest could not be validated.',
        context: state.manifest_failure_reason
          || 'The requirements-gatherer completed, but the manifest is still missing or invalid.',
        recovery_options: [
          { label: 'Retry requirements synthesis', description: 'Run the requirements-gatherer again' },
          { label: 'Abort pipeline', description: 'Stop the pipeline' },
        ],
      });
    }

    case REQ_STEP.COMPLETE: {
      // Requirements-gatherer completed — mark requirements stage complete, enter main loop.
      driverLog('requirements-complete', 'info', 'Transitioning to main_loop');
      const reqStage = state.stages.find(s => s.type === 'requirements');
      if (reqStage) {
        reqStage.status = 'completed';
      }
      state.phase = 'main_loop';
      state.step = 0;
      return routeByPhase(state, cwd);
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
    {
      name: 'technical-analyst',
      type: 'technical',
      expected_analysis_file: 'analysis-technical.json',
      scope: 'Technical feasibility, stack compatibility, API design, data models, integration points',
    },
    {
      name: 'ux-domain-analyst',
      type: 'ux-domain',
      expected_analysis_file: 'analysis-ux-domain.json',
      scope: 'User experience, domain modeling, workflow design, accessibility, edge cases',
    },
    {
      name: 'security-analyst',
      type: 'security',
      expected_analysis_file: 'analysis-security.json',
      scope: 'Authentication, authorization, input validation, data protection, threat modeling',
    },
    {
      name: 'performance-analyst',
      type: 'performance',
      expected_analysis_file: 'analysis-performance.json',
      scope: 'Latency, throughput, resource usage, caching strategy, scalability bottlenecks',
    },
    {
      name: 'architecture-analyst',
      type: 'architecture',
      expected_analysis_file: 'analysis-architecture.json',
      scope: 'Module boundaries, dependency direction, layering, coupling, extension points',
    },
  ];

  const teamListing = specialists.map(s => s.name).join(', ');
  const vcpActive = state.vcp_detection.detected;

  return specialists.map(s => {
    const lines: string[] = [];

    // Role
    lines.push(`# ${s.type.charAt(0).toUpperCase() + s.type.slice(1)} Analyst`);
    lines.push('');

    // Mission
    lines.push('## Mission');
    if (state.description) {
      lines.push(`Analyze the following feature request from the ${s.type} perspective:`);
      lines.push('');
      lines.push(`> ${state.description}`);
    } else {
      lines.push(`Analyze the current task from the ${s.type} perspective.`);
    }
    lines.push('');

    // Scope
    lines.push('## Scope');
    lines.push(`Focus areas: ${s.scope}`);
    lines.push(`Do NOT duplicate analysis that belongs to other specialists.`);
    lines.push('');

    // Output schema
    lines.push('## Output');
    lines.push(`Write your analysis as JSON to \`.vcp/task/${s.expected_analysis_file}\`.`);
    lines.push('');
    lines.push('Required schema:');
    lines.push('```json');
    lines.push('{');
    lines.push('  "findings": [{ "category": "...", "description": "...", "severity": "high|medium|low", "recommendation": "..." }],');
    lines.push('  "questions_for_user": ["Questions you could not resolve from code alone"],');
    lines.push('  "out_of_scope": ["Items deliberately left for other specialists"],');
    lines.push('  "assumptions": ["Assumptions made during analysis"]');

    // Security-specific fields
    if (s.name === 'security-analyst') {
      if (vcpActive) {
        state.vcp_detection.context_injected = true;
        lines.push(', "vcp_active": true');
        lines.push(', "vcp_standards_referenced": ["standard-id-1", "standard-id-2"]');
      }
      lines.push(', "threat_model": { "attack_surface": [], "mitigations": [] }');
    }

    lines.push('}');
    lines.push('```');
    lines.push('');

    // VCP note for security analyst
    if (s.name === 'security-analyst' && vcpActive) {
      lines.push('## VCP Standards');
      lines.push('This project uses VCP standards. Reference applicable VCP rules in each finding:');
      lines.push('```json');
      lines.push('{ "category": "...", "vcp_rule": "core-security §3.2", ... }');
      lines.push('```');
      lines.push('');
    }

    // Team
    lines.push('## Team');
    lines.push(`Your siblings: ${teamListing}`);
    lines.push('Each specialist writes to their own analysis file. Do not read or modify other specialists\' files.');
    lines.push('');

    // Q&A protocol
    lines.push('## Asking User Questions');
    lines.push('');
    lines.push('If you need clarification to continue your analysis:');
    lines.push('1. SendMessage to lead with summary starting with [QUESTION]:');
    lines.push('   SendMessage(recipient: "lead", summary: "[QUESTION] What auth framework does this project use?")');
    lines.push('2. Put the FULL question text in the summary — the lead only sees the summary, not content_file.');
    lines.push('3. Keep questions concise (under 200 characters in summary).');
    lines.push('4. Wait for the lead to relay the user\'s answer before continuing.');
    lines.push('5. You may ask multiple questions (one at a time, sequentially).');
    lines.push('');
    lines.push('Do NOT use AskUserQuestion directly — it won\'t reach the user from a background teammate.');
    lines.push('');

    // Completion protocol
    lines.push('## Completion');
    lines.push('When analysis is complete:');
    lines.push('1. Write your analysis JSON to the output file above.');
    lines.push('2. SendMessage to lead with summary containing "complete" or "analysis written".');

    const prompt = lines.join('\n');
    const promptFile = writeTempFile(cwd, `specialist-${s.name}`, makeCommandId(), prompt);
    return { name: s.name, type: s.type, expected_analysis_file: s.expected_analysis_file, prompt_file: promptFile };
  });
}

function buildSynthesisPrompt(state: PipelineState, _cwd: string): string {
  const approved = state.specialists?.approved_specialists
    .filter(s => s.status === 'completed' || s.status === 'shutdown')
    .map(s => s.name) || [];

  const lines = ['Synthesis mode.'];

  if (state.description) {
    lines.push(`FEATURE REQUEST: ${state.description}`);
  }

  lines.push(`APPROVED SPECIALISTS: ${approved.join(', ')}`);

  // Include Q&A transcript so requirements-gatherer can filter already-answered questions
  if (state.specialists?.qa_transcript.length) {
    lines.push('', 'Q&A CONTEXT (questions already answered during specialist exploration):');
    for (const qa of state.specialists.qa_transcript) {
      lines.push(`- [${qa.specialist_name}] Q: ${qa.question}`);
      lines.push(`  A: ${qa.answer}`);
    }
  }

  lines.push(
    'Read the validated analysis files from .vcp/task/.',
    'Validate scope with user via AskUserQuestion.',
    'Get explicit approval before writing user-story.',
  );
  return lines.join('\n');
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
