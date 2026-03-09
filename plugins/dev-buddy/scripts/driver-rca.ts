/**
 * Pipeline driver — RCA consolidation (bugfix pipeline).
 */

import fs from 'fs';

import type { PipelineCommand } from '../types/commands.ts';
import { makeCommandId } from '../types/commands.ts';
import type { PipelineState } from '../types/driver-state.ts';
import {
  getTaskPath,
  writeTempFile,
  emitCommand,
} from './driver-state-io.ts';
import { driverLog } from './vcp-logger.ts';

// ─── RCA Consolidation (Bugfix Pipeline) ────────────────────────────────────

export function checkRcaConsolidationNeeded(state: PipelineState, cwd: string): boolean {
  if (state.rca_consolidation?.consolidation_complete) return false;

  const rcaStages = state.stages.filter(s => s.type === 'rca');
  if (rcaStages.length === 0) return false;

  const allRcaComplete = rcaStages.every(s => s.status === 'completed');
  if (!allRcaComplete) return false;

  // Check if user-story already exists
  const manifestPath = getTaskPath(cwd, 'user-story/manifest.json');
  if (fs.existsSync(manifestPath)) return false;

  return true;
}

export function handleRcaConsolidation(state: PipelineState, cwd: string): PipelineCommand {
  driverLog('rca-consolidation', 'info', `step=${state.step}`);
  if (!state.rca_consolidation) {
    const rcaStages = state.stages.filter(s => s.type === 'rca');
    state.rca_consolidation = {
      rca_stage_indices: rcaStages.map(s => s.index),
      all_complete: true,
      disagreement_detected: false,
      chosen_diagnosis_source: null,
      consolidation_complete: false,
      artifacts_written: false,
    };
  }

  switch (state.step) {
    case 0: {
      // Read all RCA outputs
      const rcaStages = state.stages.filter(s => s.type === 'rca');
      const readCmds: PipelineCommand[] = rcaStages.map(s => ({
        command_id: makeCommandId(),
        state_version: state.state_version,
        action: 'read_file' as const,
        path: getTaskPath(cwd, s.output_file),
      }));

      state.step = 1;
      return emitCommand(state, {
        action: 'parallel_batch',
        commands: readCmds,
      });
    }

    case 1: {
      // RCA outputs read — check for disagreement.
      if (state.rca_consolidation!.disagreement_detected && !state.rca_consolidation!.chosen_diagnosis_source) {
        driverLog('rca-disagreement', 'warn', 'RCA analyses disagree — asking user');
        state.step = 2;
        return emitCommand(state, {
          action: 'ask_user',
          question: 'The RCA analyses disagree on the root cause. Which diagnosis should we use?',
          options: state.stages
            .filter(s => s.type === 'rca')
            .map(s => ({
              label: `RCA ${s.index + 1} (${s.model})`,
              description: `Use diagnosis from ${s.provider}/${s.model}`,
            })),
          context: 'RCA disagreement resolution',
        });
      }

      // No disagreement or already resolved — write artifacts
      state.step = 3;
      return handleRcaArtifactWriting(state, cwd);
    }

    case 2: {
      // User chose diagnosis — write artifacts
      state.step = 3;
      return handleRcaArtifactWriting(state, cwd);
    }

    case 3: {
      // Verify artifacts actually exist before marking complete
      const userStoryManifest = getTaskPath(cwd, 'user-story/manifest.json');
      const planManifest = getTaskPath(cwd, 'plan/manifest.json');
      const userStoryExists = fs.existsSync(userStoryManifest);
      const planExists = fs.existsSync(planManifest);

      if (!userStoryExists || !planExists) {
        return emitCommand(state, {
          action: 'escalate',
          error: `RCA artifact writing failed. Missing: ${!userStoryExists ? 'user-story/manifest.json' : ''} ${!planExists ? 'plan/manifest.json' : ''}`.trim(),
          context: 'RCA consolidation artifact verification',
        });
      }

      driverLog('rca-complete', 'info', 'Artifacts verified — consolidation done');
      state.rca_consolidation!.consolidation_complete = true;
      state.rca_consolidation!.artifacts_written = true;
      state.phase = 'main_loop';
      state.step = 0;
      return emitCommand(state, {
        action: 'noop',
        message: 'RCA consolidation complete. User story and plan artifacts written.',
      });
    }

    default:
      return emitCommand(state, {
        action: 'escalate',
        error: `Unexpected RCA consolidation step: ${state.step}`,
        context: 'RCA consolidation phase',
      });
  }
}

function handleRcaArtifactWriting(state: PipelineState, cwd: string): PipelineCommand {
  // Spawn requirements-gatherer in synthesis mode to create user-story and plan
  // from RCA data.
  const rcaStages = state.stages.filter(s => s.type === 'rca');
  const chosenSource = state.rca_consolidation?.chosen_diagnosis_source;

  const promptContent = [
    `MODE: RCA Consolidation — synthesize user-story and plan from bug analysis`,
    `RCA OUTPUT FILES:`,
    ...rcaStages.map(s => `  - .vcp/task/${s.output_file} (${s.provider}/${s.model})`),
    chosenSource ? `CHOSEN DIAGNOSIS: ${chosenSource}` : `NOTE: All RCAs agreed on root cause.`,
    `OUTPUT STRUCTURE:`,
    `  - .vcp/task/user-story/ (meta.json, requirements.json, acceptance-criteria.json, scope.json, test-criteria.json, manifest.json — manifest LAST)`,
    `  - .vcp/task/plan/ (meta.json, steps/*.json, test-plan.json, risk-assessment.json, dependencies.json, files.json, manifest.json — manifest LAST)`,
    `NOTE: Write manifest.json LAST in each directory to signal completion.`,
  ].join('\n');

  const promptFile = writeTempFile(cwd, 'rca-consolidation', makeCommandId(), promptContent);

  return emitCommand(state, {
    action: 'spawn_agent',
    subagent_type: 'dev-buddy:requirements-gatherer',
    name: 'rca-consolidation',
    model: rcaStages[0]?.model || 'opus',
    prompt_file: promptFile,
  });
}
