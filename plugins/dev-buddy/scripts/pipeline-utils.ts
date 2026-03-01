/**
 * Shared pipeline utilities — single source of truth for phase detection.
 *
 * Both orchestrator.ts and guidance-hook.ts import from here,
 * eliminating the duplicated determinePhase logic.
 */

import fs from 'fs';
import path from 'path';
import type { PipelineConfig, StageEntry } from '../types/pipeline.ts';
import { isValidStageEntry } from '../types/stage-definitions.ts';
import type { StageType } from '../types/stage-definitions.ts';

// ─── Phase Token Contract ───────────────────────────────────────────

/** Machine-readable phase identifier. Rules:
 *  - lowercase snake_case only
 *  - no spaces, parentheses, or embedded counts
 *  - used for routing/matching, never for display
 *  - Dynamic: layer-2 phases generated as {stage_type}_{index} (e.g., 'plan_review_1')
 *  - Static within-stage sub-phases: 'idle', 'complete', 'requirements_gathering',
 *    'requirements_team_pending', 'requirements_team_exploring', 'root_cause_analysis',
 *    'plan_drafting', 'implementation_failed', 'plan_rejected', 'code_rejected'
 */
export type PhaseToken = string;

/** Result from determinePhase — phase is machine token, message is human display text */
export interface PhaseResult {
  phase: PhaseToken;
  message: string;
}

export interface AnalysisFile {
  name: string;
  file: string;
  data: unknown;
}

/** Stage output entry: null = not yet produced, non-null = has data (check status field) */
export type StageOutputEntry = { status: string; clarification_questions?: string[] } | null;

export interface PipelineProgress {
  userStory: Record<string, unknown> | null;
  plan: unknown | null;
  pipelineTasks: unknown | null;
  analysisFiles: AnalysisFile[];
  implResult: { status: string } | null;
  /** Dynamic stage output map keyed by output file name.
   *  Populated from stages[] array in pipeline-tasks.json (preferred),
   *  or derived from resolved_config with legacy naming (fallback).
   *  Empty object when neither source is present (fallback to idle). */
  stageOutputs: Record<string, StageOutputEntry>;
}

// ─── Path Helpers ───────────────────────────────────────────────────

/** Compute the .vcp/task directory path. Resolves at call time from env/cwd. */
export function computeTaskDir(): string {
  return path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.vcp', 'task');
}

// ─── File Helpers ───────────────────────────────────────────────────

/** Check if a file exists */
export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** Write JSON data to a file, creating parent directories as needed */
export function writeJson(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Safely read and parse JSON file */
export function readJson(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Check if a JSON file exists and has content */
export function checkJsonExists(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

/** Get status field from a JSON file */
export function getJsonStatus(filePath: string): string | null {
  if (!checkJsonExists(filePath)) return null;
  const data = readJson(filePath) as Record<string, unknown> | null;
  if (!data || typeof data.status !== 'string') return null;
  return data.status;
}

/** Discover all specialist analysis files dynamically */
export function discoverAnalysisFiles(taskDir: string): AnalysisFile[] {
  try {
    if (!fs.existsSync(taskDir)) return [];
    return fs.readdirSync(taskDir)
      .filter((f: string) => f.startsWith('analysis-') && f.endsWith('.json'))
      .map((f: string) => {
        const name = f.replace('analysis-', '').replace('.json', '');
        return { name, file: f, data: readJson(path.join(taskDir, f)) };
      })
      .filter((entry: AnalysisFile) => entry.data !== null);
  } catch {
    return [];
  }
}

/** Compute legacy output file name for backward-compatible pipelines without stages[].
 *  Singletons return canonical names; multi-instance returns {type}-{index}.json. */
function getLegacyOutputFileName(type: StageType, index: number): string {
  switch (type) {
    case 'requirements': return 'user-story.json';
    case 'planning': return 'plan-refined.json';
    case 'implementation': return 'impl-result.json';
    default: return `${type}-${index}.json`;
  }
}

/** Read user story acceptance criteria: multi-file first, legacy fallback.
 *  Returns the AC array or null if not found. */
export function readUserStoryACs(taskDir: string): Array<{ id: string }> | null {
  // Multi-file: acceptance-criteria.json is the AC array directly
  const multiFileACs = readJson(path.join(taskDir, 'user-story', 'acceptance-criteria.json'));
  if (Array.isArray(multiFileACs) && multiFileACs.length > 0) {
    return multiFileACs as Array<{ id: string }>;
  }
  // Legacy: user-story.json has acceptance_criteria property
  const legacyStory = readJson(path.join(taskDir, 'user-story.json')) as Record<string, unknown> | null;
  if (legacyStory && Array.isArray(legacyStory.acceptance_criteria)) {
    return legacyStory.acceptance_criteria as Array<{ id: string }>;
  }
  return null;
}

/** Get progress from artifact files */
export function getProgress(taskDir: string): PipelineProgress {
  const pipelineTasks = readJson(path.join(taskDir, 'pipeline-tasks.json'));
  const stageOutputs: Record<string, StageOutputEntry> = {};

  // Populate stageOutputs from pipeline-tasks.json.
  // Prefer stages[] array (new format with provider-model-version naming),
  // fall back to resolved_config derivation (legacy {type}-{index} naming).
  if (pipelineTasks && typeof pipelineTasks === 'object') {
    const pt = pipelineTasks as Record<string, unknown>;
    const rawStages = pt.stages;

    // Validate stages[] entries: every entry must be a known stage type with a safe output filename.
    // If any entry is malformed, discard the entire array and fall back to legacy.
    const stagesArray = Array.isArray(rawStages) && rawStages.length > 0
      && rawStages.every(isValidStageEntry)
      ? rawStages as Array<{ type: string; output_file: string }>
      : undefined;

    if (stagesArray) {
      // New path: read output_file directly from stages array
      for (const stage of stagesArray) {
        const data = readJson(path.join(taskDir, stage.output_file)) as Record<string, unknown> | null;
        if (data && typeof data.status === 'string') {
          stageOutputs[stage.output_file] = {
            status: data.status,
            clarification_questions: Array.isArray(data.clarification_questions)
              ? data.clarification_questions as string[]
              : undefined,
          };
        } else {
          stageOutputs[stage.output_file] = null;
        }
      }
    } else {
      // Legacy fallback: derive from resolved_config + old {type}-{index}.json naming
      const resolvedConfig = pt.resolved_config as PipelineConfig | undefined;
      if (resolvedConfig) {
        const pipelineType = typeof pt.pipeline_type === 'string' ? pt.pipeline_type : 'feature-implement';
        const pipeline = pipelineType === 'bug-fix'
          ? resolvedConfig.bugfix_pipeline
          : resolvedConfig.feature_pipeline;

        if (Array.isArray(pipeline)) {
          const typeCounters: Partial<Record<StageType, number>> = {};
          for (const stage of pipeline) {
            const stageType = stage.type as StageType;
            typeCounters[stageType] = (typeCounters[stageType] || 0) + 1;
            const outputFile = getLegacyOutputFileName(stageType, typeCounters[stageType]!);
            const data = readJson(path.join(taskDir, outputFile)) as Record<string, unknown> | null;
            if (data && typeof data.status === 'string') {
              stageOutputs[outputFile] = {
                status: data.status,
                clarification_questions: Array.isArray(data.clarification_questions)
                  ? data.clarification_questions as string[]
                  : undefined,
              };
            } else {
              stageOutputs[outputFile] = null;
            }
          }
        }
      }
    }
  }

  // Multi-file artifacts: try manifest first, fall back to legacy single file
  const userStoryManifest = readJson(path.join(taskDir, 'user-story', 'manifest.json')) as Record<string, unknown> | null;
  const userStory = userStoryManifest ?? readJson(path.join(taskDir, 'user-story.json')) as Record<string, unknown> | null;

  const planManifest = readJson(path.join(taskDir, 'plan', 'manifest.json'));
  const plan = planManifest ?? readJson(path.join(taskDir, 'plan-refined.json'));

  return {
    userStory,
    plan,
    pipelineTasks,
    implResult: readJson(path.join(taskDir, 'impl-result.json')) as { status: string } | null,
    stageOutputs,
    analysisFiles: discoverAnalysisFiles(taskDir),
  };
}

// ─── Pipeline Type ───────────────────────────────────────────────────

export type PipelineType = 'feature-implement' | 'bug-fix';

/** Extract pipeline type from pipeline-tasks.json data */
export function getPipelineType(pipelineTasks: unknown): PipelineType {
  if (!pipelineTasks || typeof pipelineTasks !== 'object') return 'feature-implement';
  const pt = (pipelineTasks as Record<string, unknown>).pipeline_type;
  return pt === 'bug-fix' ? 'bug-fix' : 'feature-implement';
}

/** Extract the active pipeline array from resolved_config based on pipeline type. */
function getActivePipeline(resolvedConfig: PipelineConfig, pipelineType: PipelineType): StageEntry[] {
  if (pipelineType === 'bug-fix') {
    return resolvedConfig.bugfix_pipeline || [];
  }
  return resolvedConfig.feature_pipeline || [];
}

// ─── Phase Detection ────────────────────────────────────────────────

/** Determine current phase from pipeline progress using two-layer approach.
 *
 * LAYER 1: Within-stage sub-phases (checked first, before any output file checks).
 *   These detect progress WITHIN a stage before its output file exists.
 *   Static phase tokens: requirements_gathering, requirements_team_pending,
 *   requirements_team_exploring, root_cause_analysis, plan_drafting.
 *
 * LAYER 2: Generic stage iteration from resolved_config.
 *   Iterates the active pipeline stages checking stageOutputs by output file name.
 *   Dynamic phase tokens: {stage_type}_{index} (e.g., plan_review_1, code_review_2).
 */
export function determinePhase(progress: PipelineProgress): PhaseResult {
  const pipelineType = getPipelineType(progress.pipelineTasks);

  // ── LAYER 1: Within-stage sub-phases ──────────────────────────────

  // No pipeline-tasks.json at all — pipeline hasn't started
  if (!progress.pipelineTasks) {
    return {
      phase: 'requirements_gathering',
      message: '**Phase: Requirements Gathering**\nUse requirements-gatherer agent (opus) to create user-story.json.\nIf teams are available, create agent team for specialist exploration first; otherwise use requirements-gatherer directly.'
    };
  }

  // Bug-fix: RCA sub-phases (only when user story not yet written)
  if (pipelineType === 'bug-fix' && !progress.userStory) {
    // Count RCA output files from stageOutputs
    const rcaEntries = Object.entries(progress.stageOutputs)
      .filter(([key]) => key.startsWith('rca-'));
    const rcaDoneCount = rcaEntries.filter(([, v]) => v !== null).length;
    const rcaTotalCount = rcaEntries.length;

    if (rcaTotalCount > 0 && rcaDoneCount === rcaTotalCount) {
      return {
        phase: 'root_cause_analysis',
        message: '**Phase: RCA Consolidation**\nBoth RCA analyses complete. Consolidate findings, write user-story.json + plan-refined.json.'
      };
    }
    if (rcaDoneCount > 0) {
      // Show individual status
      const statusParts = rcaEntries
        .map(([key, v]) => `${key}: ${v !== null ? 'done' : 'running'}`)
        .join(', ');
      return {
        phase: 'root_cause_analysis',
        message: `**Phase: Root Cause Analysis**\nRCA in progress. ${statusParts}.`
      };
    }
    // No RCA files yet — pipeline just started
    return {
      phase: 'root_cause_analysis',
      message: '**Phase: Root Cause Analysis**\nRCA pending. Spawn root-cause-analyst stages per resolved bugfix_pipeline config.'
    };
  }

  // Feature pipeline: requirements sub-phases (only when user story not yet written)
  if (pipelineType === 'feature-implement' && !progress.userStory) {
    const hasAnyAnalysis = progress.analysisFiles.length > 0;

    if (hasAnyAnalysis) {
      const completed = progress.analysisFiles.map(f =>
        f.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('/')
      );
      return {
        phase: 'requirements_team_exploring',
        message: `**Phase: Requirements Gathering (Team Exploring)**\n${completed.length} specialist analysis file(s) received: ${completed.join(', ')}.\n**Do NOT start synthesis yet.** Wait for ALL specialist teammates to complete and go idle before spawning requirements-gatherer.\nUse AskUserQuestion with findings as they arrive via messages.`
      };
    }

    // pipeline-tasks.json exists but no analyses yet
    return {
      phase: 'requirements_team_pending',
      message: '**Phase: Requirements Gathering (Team Pending)**\nPipeline initialized. Spawn specialist teammates into the pipeline team.\nIf spawning fails, fall back to spawning requirements-gatherer directly in Standard Mode.'
    };
  }

  // No plan yet (for both pipeline types)
  if (!progress.plan) {
    if (pipelineType === 'bug-fix') {
      return {
        phase: 'plan_drafting',
        message: '**Phase: Planning**\nConsolidation incomplete — write plan-refined.json from RCA findings.'
      };
    }
    return {
      phase: 'plan_drafting',
      message: '**Phase: Planning**\nUse planner agent (opus) to create plan-refined.json'
    };
  }

  // ── LAYER 2: Generic stage iteration ──────────────────────────────

  // Build stage iteration list: prefer stages[] (new format), fall back to resolved_config (legacy)
  const pt = progress.pipelineTasks as Record<string, unknown>;
  const rawStages2 = pt.stages;

  // Validate stages[] entries: every entry must be a known stage type with a safe output filename.
  // If any entry is malformed, discard entirely and fall back to legacy.
  const validStages = Array.isArray(rawStages2) && rawStages2.length > 0
    && rawStages2.every(isValidStageEntry)
    ? rawStages2 as Array<{ type: string; output_file: string }>
    : undefined;

  let stageList: Array<{ type: StageType; outputFile: string }>;

  if (validStages) {
    // New path: stage type + output file read directly from stages[]
    stageList = validStages.map(s => ({ type: s.type as StageType, outputFile: s.output_file }));
  } else {
    // Legacy fallback: derive from resolved_config + old {type}-{index}.json naming
    const resolvedConfig = pt.resolved_config as PipelineConfig | undefined;

    if (!resolvedConfig) {
      return {
        phase: 'idle',
        message: '**Phase: Unknown**\nPipeline tasks file has no resolved_config or stages (old format). Reset pipeline to continue.'
      };
    }

    const activePipeline = getActivePipeline(resolvedConfig, pipelineType);
    const legacyCounters: Partial<Record<StageType, number>> = {};
    stageList = activePipeline.map(stage => {
      const t = stage.type as StageType;
      legacyCounters[t] = (legacyCounters[t] || 0) + 1;
      return { type: t, outputFile: getLegacyOutputFileName(t, legacyCounters[t]!) };
    });
  }

  // Iterate stages in order. Per-type counters generate phase tokens.
  // Layer-1 stages (requirements, planning, rca) are skipped (handled above).
  const typeCounters: Partial<Record<StageType, number>> = {};
  for (let i = 0; i < stageList.length; i++) {
    const { type: stageType, outputFile } = stageList[i];

    // Track per-type index for ALL stages (including skipped ones) so counters stay correct
    typeCounters[stageType] = (typeCounters[stageType] || 0) + 1;
    const typeIndex = typeCounters[stageType]!;

    // Skip layer-1 stage types (handled above)
    if (stageType === 'requirements' || stageType === 'planning' || stageType === 'rca') {
      continue;
    }

    const entry = progress.stageOutputs[outputFile];

    // Implementation stage: check impl-result separately
    if (stageType === 'implementation') {
      const implStatus = progress.implResult?.status;
      if (!implStatus || implStatus === 'partial') {
        return {
          phase: 'implementation',
          message: '**Phase: Implementation**\nUse implementer agent to implement plan-refined.json'
        };
      }
      if (implStatus === 'failed') {
        return {
          phase: 'implementation_failed',
          message: '**Phase: Implementation Failed**\nCheck impl-result.json for failure details.'
        };
      }
      // 'complete' — continue to next stage
      continue;
    }

    // Review stages (plan-review, code-review): check stageOutputs
    if (entry === null || entry === undefined) {
      // Stage output not yet produced — this is the active stage
      const stageLabel = stageType === 'plan-review' ? 'Plan Review' : 'Code Review';
      const isBugFixPlanReview = pipelineType === 'bug-fix' && stageType === 'plan-review';
      return {
        phase: `${stageType.replace('-', '_')}_${typeIndex}`,
        message: isBugFixPlanReview
          ? `**Phase: RCA + Plan Validation**\n→ Run stage ${typeIndex} ${stageLabel} (${outputFile})`
          : `**Phase: ${stageLabel}**\n→ Run stage ${typeIndex} ${stageLabel} (${outputFile})`
      };
    }

    const status = entry.status;

    if (status === 'needs_clarification') {
      const questions = entry.clarification_questions || [];
      return {
        phase: `clarification_${stageType.replace('-', '_')}_${typeIndex}`,
        message: `**Phase: Clarification Needed**\nStage ${stageType} ${typeIndex} needs clarification. Answer questions or use AskUserQuestion:\n${questions.map(q => `- ${q}`).join('\n')}`
      };
    }
    if (status === 'needs_changes') {
      return {
        phase: `fix_${stageType.replace('-', '_')}_${typeIndex}`,
        message: `**Phase: Fix ${stageType === 'plan-review' ? 'Plan' : 'Code'}**\nStage ${stageType} ${typeIndex} needs changes. Create fix + re-review tasks.`
      };
    }
    if (status === 'rejected') {
      const rejectedPhase = stageType === 'plan-review' ? 'plan_rejected' : 'code_rejected';
      return {
        phase: rejectedPhase,
        message: `**Phase: ${stageType === 'plan-review' ? 'Plan' : 'Code'} Rejected**\nStage ${stageType} ${typeIndex} rejected. Major rework required.`
      };
    }
    // 'approved' — continue to next stage
  }

  // All stages have approved status
  return {
    phase: 'complete',
    message: '**Phase: Complete**\nAll reviews approved. Pipeline finished.'
  };
}
