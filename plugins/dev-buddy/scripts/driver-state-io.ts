/**
 * Pipeline driver — state I/O, path helpers, stage resolution, and command emission.
 *
 * Pure utilities with no cross-module dependencies within driver-*.ts.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import type { PipelineConfig, StageEntry } from '../types/pipeline.ts';
import type { StageType } from '../types/stage-definitions.ts';
import {
  STAGE_DEFINITIONS,
  getOutputFileName,
} from '../types/stage-definitions.ts';
import { atomicWriteFile } from './pipeline-config.ts';
import { readPresets } from './preset-utils.ts';
import type { PipelineCommand, CommandPayload } from '../types/commands.ts';
import { makeCommandId } from '../types/commands.ts';
import type {
  PipelineState,
  StageState,
} from '../types/driver-state.ts';

// ─── Constants ──────────────────────────────────────────────────────────────

export const PIPELINE_TASKS_FILE = 'pipeline-tasks.json';
export const PIPELINE_STATE_FILE = 'pipeline-state.json';
const TMP_DIR = '.tmp';

// ─── Path Helpers ───────────────────────────────────────────────────────────

export function getTaskDir(cwd: string): string {
  return path.join(cwd, '.vcp', 'task');
}

export function getTaskPath(cwd: string, filename: string): string {
  return path.join(getTaskDir(cwd), filename);
}

export function getTmpPath(cwd: string, filename: string): string {
  const tmpDir = path.join(getTaskDir(cwd), TMP_DIR);
  fs.mkdirSync(tmpDir, { recursive: true });
  return path.join(tmpDir, filename);
}

// ─── Team Name Derivation ───────────────────────────────────────────────────

/**
 * Derive deterministic team name from project path.
 * Format: pipeline-{BASENAME}-{HASH} (first 6 chars of SHA-256).
 */
export function deriveTeamName(cwd: string): string {
  // Canonicalize path
  const resolved = fs.realpathSync(cwd);
  const canonical = resolved
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`)
    .replace(/\/$/, '');

  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 6);

  // Sanitize basename
  const raw = path.basename(canonical);
  let basename = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
  if (!basename) basename = 'project';

  return `pipeline-${basename}-${hash}`;
}

// ─── Config Hash ────────────────────────────────────────────────────────────

export function computeConfigHash(config: PipelineConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

// ─── Stage Resolution ───────────────────────────────────────────────────────

export interface ResolvedStageInfo {
  index: number;
  type: StageType;
  provider: string;
  model: string;
  providerType: 'subscription' | 'api' | 'cli';
  outputFile: string;
  stageIndex: number; // 1-based among same type
  parallel: boolean;
  parallelGroupId: number | null;
  phasedReviews?: StageEntry['phased_reviews'];
}

/**
 * Resolve pipeline stages from config, computing output files, provider types,
 * and parallel group assignments.
 */
export function resolveStages(
  pipeline: StageEntry[],
  _config: PipelineConfig,
): ResolvedStageInfo[] {
  const presets = readPresets();
  const typeCounters: Partial<Record<StageType, number>> = {};
  const resolved: ResolvedStageInfo[] = [];

  // First pass: resolve each stage
  for (let i = 0; i < pipeline.length; i++) {
    const entry = pipeline[i];
    const stageType = entry.type as StageType;
    typeCounters[stageType] = (typeCounters[stageType] || 0) + 1;
    const stageIndex = typeCounters[stageType]!;
    const outputFile = getOutputFileName(stageType, stageIndex, entry.provider, entry.model, 1);
    const preset = presets.presets[entry.provider];
    const providerType = preset ? preset.type as 'subscription' | 'api' | 'cli' : 'subscription';

    resolved.push({
      index: i,
      type: stageType,
      provider: entry.provider,
      model: entry.model,
      providerType,
      outputFile,
      stageIndex,
      parallel: entry.parallel === true,
      parallelGroupId: null,
      phasedReviews: entry.phased_reviews,
    });
  }

  // Second pass: assign parallel group IDs
  let groupCounter = 0;
  let i = 0;
  while (i < resolved.length) {
    const stage = resolved[i];
    if (
      stage.parallel &&
      (stage.type === 'plan-review' || stage.type === 'code-review')
    ) {
      // Find consecutive same-type parallel stages
      let j = i + 1;
      while (
        j < resolved.length &&
        resolved[j].type === stage.type &&
        resolved[j].parallel
      ) {
        j++;
      }
      if (j - i >= 2) {
        groupCounter++;
        for (let k = i; k < j; k++) {
          resolved[k].parallelGroupId = groupCounter;
        }
      }
      i = j;
    } else {
      i++;
    }
  }

  return resolved;
}

// ─── State I/O ──────────────────────────────────────────────────────────────

export function readState(cwd: string): PipelineState | null {
  const statePath = getTaskPath(cwd, PIPELINE_STATE_FILE);
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as PipelineState;
  } catch {
    return null;
  }
}

export function writeState(cwd: string, state: PipelineState): void {
  atomicWriteFile(getTaskPath(cwd, PIPELINE_STATE_FILE), state);
}

export function readPipelineTasks(cwd: string): Record<string, unknown> | null {
  const tasksPath = getTaskPath(cwd, PIPELINE_TASKS_FILE);
  try {
    if (!fs.existsSync(tasksPath)) return null;
    return JSON.parse(fs.readFileSync(tasksPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function writePipelineTasks(cwd: string, data: Record<string, unknown>): void {
  atomicWriteFile(getTaskPath(cwd, PIPELINE_TASKS_FILE), data);
}

// ─── Pipeline Tasks JSON Builder ────────────────────────────────────────────

export function buildPipelineTasksJson(state: PipelineState, config: PipelineConfig): Record<string, unknown> {
  return {
    team_name: state.team_name,
    pipeline_type: state.pipeline === 'feature' ? 'feature-implement' : 'bug-fix',
    config_hash: state.config_hash,
    ...(state.description ? { description: state.description } : {}),
    resolved_config: config,
    stages: state.stages.map(s => ({
      type: s.type,
      provider: s.provider,
      providerType: s.providerType,
      model: s.model,
      output_file: s.output_file,
      task_id: s.task_id,
      parallel_group_id: s.parallel_group_id,
      current_version: s.current_version,
    })),
  };
}

// ─── Temp File Helpers ──────────────────────────────────────────────────────

export function writeTempFile(cwd: string, prefix: string, cmdId: string, content: string): string {
  const filename = `${prefix}-${cmdId}.md`;
  const tmpPath = getTmpPath(cwd, filename);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  return tmpPath;
}

// ─── Command Emitters ───────────────────────────────────────────────────────

export function emitCommand(state: PipelineState, cmd: CommandPayload): PipelineCommand {
  const command = {
    ...cmd,
    command_id: makeCommandId(),
    state_version: state.state_version,
  } as PipelineCommand;
  state.pending_command = command;
  state.command_history.push({
    command_id: command.command_id,
    action: command.action,
    timestamp: new Date().toISOString(),
    acknowledged: false,
  });
  return command;
}

/** Emit a command, save state, and return it. */
export function emitAndSave(
  state: PipelineState,
  cwd: string,
  cmd: CommandPayload,
): PipelineCommand {
  const result = emitCommand(state, cmd);
  writeState(cwd, state);
  return result;
}

// ─── Subject / Description Derivation ────────────────────────────────────────

export function deriveSubject(stage: ResolvedStageInfo): string {
  const def = STAGE_DEFINITIONS[stage.type];
  const modelSuffix = stage.providerType === 'cli'
    ? ' - Codex'
    : stage.model
      ? ` - ${stage.model.charAt(0).toUpperCase() + stage.model.slice(1)}`
      : '';

  if (def.singleton) {
    switch (stage.type) {
      case 'requirements': return 'Gather requirements';
      case 'planning': return 'Create implementation plan';
      case 'implementation': return 'Implementation';
      default: return `${stage.type}${modelSuffix}`;
    }
  }

  switch (stage.type) {
    case 'plan-review': return `Plan Review ${stage.stageIndex}${modelSuffix}`;
    case 'code-review': return `Code Review ${stage.stageIndex}${modelSuffix}`;
    case 'rca': return `RCA ${stage.stageIndex}${modelSuffix}`;
    default: return `${stage.type} ${stage.stageIndex}${modelSuffix}`;
  }
}

/** Reconstruct a ResolvedStageInfo from a StageState for subject/description derivation. */
export function buildResolvedStageInfo(stage: StageState, state?: PipelineState): ResolvedStageInfo {
  let stageIndex = 1;
  if (state) {
    stageIndex = computeStageIndex(state, stage);
  }
  return {
    index: stage.index,
    type: stage.type,
    provider: stage.provider,
    model: stage.model,
    providerType: stage.providerType,
    outputFile: stage.output_file,
    stageIndex,
    parallel: stage.parallel_group_id !== null,
    parallelGroupId: stage.parallel_group_id,
  };
}

/** Compute 1-based stage index among same-type stages. */
export function computeStageIndex(state: PipelineState, stage: StageState): number {
  let count = 0;
  for (const s of state.stages) {
    if (s.type === stage.type) {
      count++;
      if (s.index === stage.index) return count;
    }
  }
  return 1;
}

/**
 * Derive a rich task description for a pipeline stage.
 */
export function deriveDescription(
  state: PipelineState,
  stage: StageState,
  _info: ResolvedStageInfo,
  _cwd: string,
): string {
  const providerLabel = `${stage.provider} (${stage.providerType})`;
  const modelLabel = stage.model;

  switch (stage.type) {
    case 'requirements':
      return [
        `PHASE: Requirements Gathering (team-based)`,
        `AGENT: Special — spawn 5+ specialist teammates, then synthesize via requirements-gatherer`,
        `MODEL: ${modelLabel}`,
        `PROVIDER: ${providerLabel}`,
        `INPUT: User's initial request (from conversation context)`,
        `OUTPUT: .vcp/task/user-story/manifest.json`,
        `COMPLETION: .vcp/task/user-story/manifest.json exists with ac_count field`,
      ].join('\n');

    case 'planning':
      return [
        `PHASE: Planning`,
        `AGENT: dev-buddy:planner`,
        `MODEL: ${modelLabel}`,
        `PROVIDER: ${providerLabel}`,
        `INPUT: .vcp/task/user-story/ (all sections)`,
        `OUTPUT: .vcp/task/plan/manifest.json`,
        `COMPLETION: .vcp/task/plan/manifest.json exists with step_count field`,
      ].join('\n');

    case 'plan-review': {
      const agentType = stage.providerType === 'cli' ? 'dev-buddy:cli-executor' : 'dev-buddy:plan-reviewer';
      const cliNote = stage.providerType === 'cli'
        ? `\nNOTE: CLI executor runs cli-executor.ts with --preset ${stage.provider} --model ${stage.model} --output-file .vcp/task/${stage.output_file}`
        : '';
      const bugfixLabel = state.pipeline === 'bugfix' ? ' (RCA + Plan Validation)' : '';
      return [
        `PHASE: Plan Review${bugfixLabel}`,
        `AGENT: ${agentType}`,
        `MODEL: ${modelLabel}`,
        `PROVIDER: ${providerLabel}`,
        `INPUT: .vcp/task/user-story/acceptance-criteria.json, .vcp/task/user-story/scope.json, .vcp/task/plan/manifest.json`,
        `OUTPUT: .vcp/task/${stage.output_file}`,
        `RESULT HANDLING: Read output → check status → handle per result rules`,
        `COMPLETION: .vcp/task/${stage.output_file} exists with status field${cliNote}`,
      ].join('\n');
    }

    case 'implementation': {
      const bugfixNote = state.pipeline === 'bugfix'
        ? '\nNOTE: This is a bug fix — make the smallest possible change that addresses the root cause.'
        : '';
      return [
        `PHASE: Implementation${state.pipeline === 'bugfix' ? ' (Bug Fix)' : ''}`,
        `AGENT: dev-buddy:implementer`,
        `MODEL: ${modelLabel}`,
        `PROVIDER: ${providerLabel}`,
        `INPUT: .vcp/task/user-story/ (all sections), .vcp/task/plan/manifest.json`,
        `OUTPUT: .vcp/task/impl-result.json`,
        `COMPLETION: .vcp/task/impl-result.json exists with status='complete'${bugfixNote}`,
      ].join('\n');
    }

    case 'code-review': {
      const agentType = stage.providerType === 'cli' ? 'dev-buddy:cli-executor' : 'dev-buddy:code-reviewer';
      const cliNote = stage.providerType === 'cli'
        ? `\nNOTE: CLI executor runs cli-executor.ts with --preset ${stage.provider} --model ${stage.model} --output-file .vcp/task/${stage.output_file}`
        : '';
      return [
        `PHASE: Code Review`,
        `AGENT: ${agentType}`,
        `MODEL: ${modelLabel}`,
        `PROVIDER: ${providerLabel}`,
        `INPUT: .vcp/task/user-story/acceptance-criteria.json, .vcp/task/plan/manifest.json, .vcp/task/impl-result.json`,
        `OUTPUT: .vcp/task/${stage.output_file}`,
        `RESULT HANDLING: Read output → check status → handle per result rules`,
        `COMPLETION: .vcp/task/${stage.output_file} exists with status field${cliNote}`,
      ].join('\n');
    }

    case 'rca':
      return [
        `PHASE: Root Cause Analysis`,
        `AGENT: dev-buddy:root-cause-analyst`,
        `MODEL: ${modelLabel}`,
        `PROVIDER: ${providerLabel}`,
        `INPUT: Bug description from conversation context`,
        `OUTPUT: .vcp/task/${stage.output_file}`,
        `COMPLETION: .vcp/task/${stage.output_file} exists with root_cause.summary`,
      ].join('\n');

    default:
      return `Stage: ${stage.type}, Provider: ${providerLabel}, Model: ${modelLabel}`;
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

export function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i <= end; i++) result.push(i);
  return result;
}
