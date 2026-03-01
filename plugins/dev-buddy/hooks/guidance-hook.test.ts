import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// Set env before importing module (TASK_DIR is resolved at load time)
const TEST_PROJECT_DIR = join(import.meta.dir, '.test-project-guidance');
const TEST_TASK_DIR = join(TEST_PROJECT_DIR, '.vcp', 'task');
process.env.CLAUDE_PROJECT_DIR = TEST_PROJECT_DIR;

// Import after env is set
import {
  discoverAnalysisFiles,
  determinePhase,
} from './guidance-hook.ts';

import type { PipelineProgress, StageOutputEntry } from '../scripts/pipeline-utils.ts';

// ── Helpers for building test PipelineProgress objects ─────────────────

/** Build a minimal feature-implement pipeline-tasks snapshot.
 *  Includes top-level stages[] (new format) so tests exercise the primary code path. */
function makeFeaturePipelineTasks(stages: Array<{ type: string; output_file: string; provider?: string; current_version?: number }> = []) {
  return {
    pipeline_type: 'feature-implement',
    team_name: 'pipeline-test-abc123',
    resolved_config: {
      feature_pipeline: stages.map(s => ({ type: s.type, provider: s.provider ?? 'anthropic-subscription', model: 'sonnet' })),
      bugfix_pipeline: [],
      max_iterations: 10,
      team_name_pattern: 'pipeline-{BASENAME}-{HASH}',
    },
    stages: stages.map(s => ({
      type: s.type,
      provider: s.provider ?? 'anthropic-subscription',
      output_file: s.output_file,
      current_version: s.current_version ?? 1,
    })),
  };
}

/** Build a minimal bug-fix pipeline-tasks snapshot.
 *  Includes top-level stages[] (new format) so tests exercise the primary code path. */
function makeBugFixPipelineTasks(stages: Array<{ type: string; output_file: string; provider?: string; current_version?: number }> = []) {
  return {
    pipeline_type: 'bug-fix',
    team_name: 'pipeline-test-abc123',
    resolved_config: {
      feature_pipeline: [],
      bugfix_pipeline: stages.map(s => ({ type: s.type, provider: s.provider ?? 'anthropic-subscription', model: 'sonnet' })),
      max_iterations: 10,
      team_name_pattern: 'pipeline-{BASENAME}-{HASH}',
    },
    stages: stages.map(s => ({
      type: s.type,
      provider: s.provider ?? 'anthropic-subscription',
      output_file: s.output_file,
      current_version: s.current_version ?? 1,
    })),
  };
}

/** Default feature pipeline stages (matching DEFAULT_CONFIG with versioned naming) */
const DEFAULT_FEATURE_STAGES = [
  { type: 'requirements', output_file: 'user-story/manifest.json' },
  { type: 'planning', output_file: 'plan/manifest.json' },
  { type: 'plan-review', output_file: 'plan-review-anthropic-subscription-sonnet-1-v1.json' },
  { type: 'plan-review', output_file: 'plan-review-anthropic-subscription-opus-2-v1.json' },
  { type: 'plan-review', output_file: 'plan-review-anthropic-subscription-sonnet-3-v1.json' },
  { type: 'implementation', output_file: 'impl-result.json' },
  { type: 'code-review', output_file: 'code-review-anthropic-subscription-sonnet-1-v1.json' },
  { type: 'code-review', output_file: 'code-review-anthropic-subscription-opus-2-v1.json' },
  { type: 'code-review', output_file: 'code-review-anthropic-subscription-sonnet-3-v1.json' },
];

/** Default bug-fix pipeline stages (matching DEFAULT_CONFIG with versioned naming) */
const DEFAULT_BUGFIX_STAGES = [
  { type: 'rca', output_file: 'rca-anthropic-subscription-sonnet-1-v1.json' },
  { type: 'rca', output_file: 'rca-anthropic-subscription-opus-2-v1.json' },
  { type: 'plan-review', output_file: 'plan-review-anthropic-subscription-sonnet-1-v1.json' },
  { type: 'implementation', output_file: 'impl-result.json' },
  { type: 'code-review', output_file: 'code-review-anthropic-subscription-sonnet-1-v1.json' },
  { type: 'code-review', output_file: 'code-review-anthropic-subscription-opus-2-v1.json' },
  { type: 'code-review', output_file: 'code-review-anthropic-subscription-sonnet-3-v1.json' },
];

/** Build an empty stageOutputs record from a stages array */
function emptyStageOutputs(stages: Array<{ output_file: string }>): Record<string, StageOutputEntry> {
  const out: Record<string, StageOutputEntry> = {};
  for (const s of stages) out[s.output_file] = null;
  return out;
}

describe('guidance-hook', () => {
  beforeEach(() => {
    mkdirSync(TEST_TASK_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  describe('discoverAnalysisFiles', () => {
    test('returns empty array when no analysis files exist', () => {
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toEqual([]);
    });

    test('discovers a single analysis file', () => {
      writeFileSync(
        join(TEST_TASK_DIR, 'analysis-technical.json'),
        JSON.stringify({ specialist: 'technical', summary: 'test' })
      );
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('technical');
      expect(result[0].file).toBe('analysis-technical.json');
      expect((result[0].data as Record<string, unknown>).specialist).toBe('technical');
    });

    test('discovers multiple analysis files', () => {
      const specialists = ['technical', 'ux-domain', 'security', 'performance', 'architecture'];
      for (const s of specialists) {
        writeFileSync(
          join(TEST_TASK_DIR, `analysis-${s}.json`),
          JSON.stringify({ specialist: s, summary: `${s} findings` })
        );
      }
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toHaveLength(5);
      const names = result.map(r => r.name).sort();
      expect(names).toEqual(['architecture', 'performance', 'security', 'technical', 'ux-domain']);
    });

    test('ignores non-analysis JSON files', () => {
      writeFileSync(
        join(TEST_TASK_DIR, 'pipeline-tasks.json'),
        JSON.stringify({ requirements: 'T1' })
      );
      writeFileSync(
        join(TEST_TASK_DIR, 'user-story.json'),
        JSON.stringify({ title: 'test' })
      );
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toEqual([]);
    });

    test('skips analysis files with invalid JSON', () => {
      writeFileSync(
        join(TEST_TASK_DIR, 'analysis-technical.json'),
        JSON.stringify({ specialist: 'technical' })
      );
      writeFileSync(
        join(TEST_TASK_DIR, 'analysis-broken.json'),
        'not valid json{'
      );
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('technical');
    });

    test('returns empty array when .task directory does not exist', () => {
      rmSync(TEST_TASK_DIR, { recursive: true, force: true });
      const result = discoverAnalysisFiles(TEST_TASK_DIR);
      expect(result).toEqual([]);
    });
  });

  describe('determinePhase', () => {
    test('returns requirements_gathering when no pipeline tasks exist', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: null,
        analysisFiles: [],
        implResult: null,
        stageOutputs: {},
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('requirements_gathering');
    });

    test('returns requirements_team_pending when pipeline tasks exist but no analyses', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: makeFeaturePipelineTasks(DEFAULT_FEATURE_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs: emptyStageOutputs(DEFAULT_FEATURE_STAGES),
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('requirements_team_pending');
      expect(result.message).toContain('pipeline team');
    });

    test('returns requirements_team_exploring when analysis files exist', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: makeFeaturePipelineTasks(DEFAULT_FEATURE_STAGES),
        analysisFiles: [
          { name: 'technical', file: 'analysis-technical.json', data: {} },
        ],
        implResult: null,
        stageOutputs: emptyStageOutputs(DEFAULT_FEATURE_STAGES),
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('requirements_team_exploring');
      expect(result.message).toContain('Do NOT start synthesis yet');
      expect(result.message).toContain('Technical');
    });

    test('does not return synthesizing phase even with multiple analyses', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: makeFeaturePipelineTasks(DEFAULT_FEATURE_STAGES),
        analysisFiles: [
          { name: 'technical', file: 'analysis-technical.json', data: {} },
          { name: 'ux-domain', file: 'analysis-ux-domain.json', data: {} },
          { name: 'security', file: 'analysis-security.json', data: {} },
          { name: 'performance', file: 'analysis-performance.json', data: {} },
          { name: 'architecture', file: 'analysis-architecture.json', data: {} },
        ],
        implResult: null,
        stageOutputs: emptyStageOutputs(DEFAULT_FEATURE_STAGES),
      };
      const result = determinePhase(progress);
      // Should still be exploring, never synthesizing
      expect(result.phase).toBe('requirements_team_exploring');
      expect(result.phase).not.toContain('synthesizing');
      expect(result.message).toContain('5');
    });

    test('returns plan_drafting when user story exists but no plan', () => {
      const stageOutputs = emptyStageOutputs(DEFAULT_FEATURE_STAGES);
      // user-story/manifest.json exists (requirements stage done)
      stageOutputs['user-story/manifest.json'] = { status: 'complete' };
      const progress: PipelineProgress = {
        userStory: { title: 'test' },
        plan: null,
        pipelineTasks: makeFeaturePipelineTasks(DEFAULT_FEATURE_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('plan_drafting');
    });

    test('fallback message mentions team fallback', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: null,
        analysisFiles: [],
        implResult: null,
        stageOutputs: {},
      };
      const result = determinePhase(progress);
      expect(result.message).toContain('requirements-gatherer');
    });

    test('pending phase message mentions fallback for team failure', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: makeFeaturePipelineTasks(DEFAULT_FEATURE_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs: emptyStageOutputs(DEFAULT_FEATURE_STAGES),
      };
      const result = determinePhase(progress);
      expect(result.message).toContain('spawning fails');
    });

    // ─── Bug-Fix Pipeline Phase Transitions ───────────────────────────

    test('bug-fix: returns root_cause_analysis (pending) at startup before any RCA files', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: makeBugFixPipelineTasks(DEFAULT_BUGFIX_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs: emptyStageOutputs(DEFAULT_BUGFIX_STAGES),
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('root_cause_analysis');
      expect(result.message).toContain('pending');
    });

    test('bug-fix: returns root_cause_analysis (in progress) when one RCA done', () => {
      const stageOutputs = emptyStageOutputs(DEFAULT_BUGFIX_STAGES);
      stageOutputs['rca-anthropic-subscription-sonnet-1-v1.json'] = { status: 'complete' };
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: makeBugFixPipelineTasks(DEFAULT_BUGFIX_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('root_cause_analysis');
      expect(result.message).toContain('rca-anthropic-subscription-sonnet-1-v1.json: done');
      expect(result.message).toContain('rca-anthropic-subscription-opus-2-v1.json: running');
    });

    test('bug-fix: returns root_cause_analysis (consolidation) when both RCAs done', () => {
      const stageOutputs = emptyStageOutputs(DEFAULT_BUGFIX_STAGES);
      stageOutputs['rca-anthropic-subscription-sonnet-1-v1.json'] = { status: 'complete' };
      stageOutputs['rca-anthropic-subscription-opus-2-v1.json'] = { status: 'complete' };
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: makeBugFixPipelineTasks(DEFAULT_BUGFIX_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('root_cause_analysis');
      expect(result.message).toContain('Consolidation');
    });

    test('bug-fix: skips Sonnet/Opus plan reviews, goes to Codex validation', () => {
      const stageOutputs = emptyStageOutputs(DEFAULT_BUGFIX_STAGES);
      stageOutputs['rca-anthropic-subscription-sonnet-1-v1.json'] = { status: 'complete' };
      stageOutputs['rca-anthropic-subscription-opus-2-v1.json'] = { status: 'complete' };
      const progress: PipelineProgress = {
        userStory: { title: 'Fix: test bug' },
        plan: { steps: [] },
        pipelineTasks: makeBugFixPipelineTasks(DEFAULT_BUGFIX_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs,
      };
      const result = determinePhase(progress);
      // Bug-fix pipeline has plan-review as the first non-layer-1 stage after rca
      // It should go to plan_review phase (the bug-fix plan validation stage)
      expect(result.phase).toContain('plan_review');
      expect(result.message).toContain('RCA + Plan Validation');
    });

    test('bug-fix: proceeds to implementation after Codex plan validation approved', () => {
      const stageOutputs = emptyStageOutputs(DEFAULT_BUGFIX_STAGES);
      stageOutputs['rca-anthropic-subscription-sonnet-1-v1.json'] = { status: 'complete' };
      stageOutputs['rca-anthropic-subscription-opus-2-v1.json'] = { status: 'complete' };
      stageOutputs['plan-review-anthropic-subscription-sonnet-1-v1.json'] = { status: 'approved' };
      const progress: PipelineProgress = {
        userStory: { title: 'Fix: test bug' },
        plan: { steps: [] },
        pipelineTasks: makeBugFixPipelineTasks(DEFAULT_BUGFIX_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('implementation');
    });

    test('bug-fix: does NOT fall into requirements_team_pending at startup', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: makeBugFixPipelineTasks(DEFAULT_BUGFIX_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs: emptyStageOutputs(DEFAULT_BUGFIX_STAGES),
      };
      const result = determinePhase(progress);
      expect(result.phase).not.toBe('requirements_team_pending');
      expect(result.phase).not.toBe('requirements_gathering');
    });

    test('feature-implement: still returns requirements_team_pending (regression check)', () => {
      const progress: PipelineProgress = {
        userStory: null,
        plan: null,
        pipelineTasks: makeFeaturePipelineTasks(DEFAULT_FEATURE_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs: emptyStageOutputs(DEFAULT_FEATURE_STAGES),
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('requirements_team_pending');
    });

    test('feature-implement: still requires plan review before code review (regression check)', () => {
      const stageOutputs = emptyStageOutputs(DEFAULT_FEATURE_STAGES);
      stageOutputs['user-story/manifest.json'] = { status: 'complete' };
      stageOutputs['plan/manifest.json'] = { status: 'complete' };
      const progress: PipelineProgress = {
        userStory: { title: 'test' },
        plan: { steps: [] },
        pipelineTasks: makeFeaturePipelineTasks(DEFAULT_FEATURE_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs,
      };
      const result = determinePhase(progress);
      // Should be in plan review phase (first plan-review stage)
      expect(result.phase).toContain('plan_review');
    });

    test('returns idle when pipeline-tasks.json has no resolved_config', () => {
      const progress: PipelineProgress = {
        userStory: { title: 'test' },
        plan: { steps: [] },
        pipelineTasks: { requirements: 'T1', plan: 'T2' }, // no resolved_config
        analysisFiles: [],
        implResult: null,
        stageOutputs: {}, // no stageOutputs when no resolved_config
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('idle');
    });

    test('feature-implement: returns complete when all stages approved', () => {
      const stageOutputs: Record<string, StageOutputEntry> = {
        'user-story/manifest.json': { status: 'complete' },
        'plan/manifest.json': { status: 'complete' },
        'plan-review-anthropic-subscription-sonnet-1-v1.json': { status: 'approved' },
        'plan-review-anthropic-subscription-opus-2-v1.json': { status: 'approved' },
        'plan-review-anthropic-subscription-sonnet-3-v1.json': { status: 'approved' },
        'impl-result.json': { status: 'complete' },
        'code-review-anthropic-subscription-sonnet-1-v1.json': { status: 'approved' },
        'code-review-anthropic-subscription-opus-2-v1.json': { status: 'approved' },
        'code-review-anthropic-subscription-sonnet-3-v1.json': { status: 'approved' },
      };
      const progress: PipelineProgress = {
        userStory: { title: 'test' },
        plan: { steps: [] },
        pipelineTasks: makeFeaturePipelineTasks(DEFAULT_FEATURE_STAGES),
        analysisFiles: [],
        implResult: { status: 'complete' },
        stageOutputs,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('complete');
    });

    test('feature-implement: returns fix phase when a plan review needs_changes', () => {
      const stageOutputs: Record<string, StageOutputEntry> = {
        'user-story/manifest.json': { status: 'complete' },
        'plan/manifest.json': { status: 'complete' },
        'plan-review-anthropic-subscription-sonnet-1-v1.json': { status: 'needs_changes' },
        'plan-review-anthropic-subscription-opus-2-v1.json': null,
        'plan-review-anthropic-subscription-sonnet-3-v1.json': null,
        'impl-result.json': null,
        'code-review-anthropic-subscription-sonnet-1-v1.json': null,
        'code-review-anthropic-subscription-opus-2-v1.json': null,
        'code-review-anthropic-subscription-sonnet-3-v1.json': null,
      };
      const progress: PipelineProgress = {
        userStory: { title: 'test' },
        plan: { steps: [] },
        pipelineTasks: makeFeaturePipelineTasks(DEFAULT_FEATURE_STAGES),
        analysisFiles: [],
        implResult: null,
        stageOutputs,
      };
      const result = determinePhase(progress);
      expect(result.phase).toContain('fix_plan_review');
      expect(result.message).toContain('Fix Plan');
    });

    test('malformed stages[] falls back to resolved_config', () => {
      // stages[] has an entry missing output_file — validation should discard entire array
      const malformedPipelineTasks = {
        pipeline_type: 'feature-implement',
        team_name: 'pipeline-test-abc123',
        resolved_config: {
          feature_pipeline: [
            { type: 'requirements', provider: 'anthropic-subscription', model: 'opus' },
            { type: 'planning', provider: 'anthropic-subscription', model: 'opus' },
            { type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet' },
            { type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet' },
            { type: 'code-review', provider: 'anthropic-subscription', model: 'sonnet' },
          ],
          bugfix_pipeline: [],
          max_iterations: 10,
          team_name_pattern: 'pipeline-{BASENAME}-{HASH}',
        },
        stages: [
          { type: 'requirements', output_file: 'user-story.json' },
          { type: 'planning' }, // missing output_file — malformed
        ],
      };
      // Legacy naming used because stages[] is invalid
      const stageOutputs: Record<string, StageOutputEntry> = {
        'user-story.json': { status: 'complete' },
        'plan-refined.json': { status: 'complete' },
        'plan-review-1.json': { status: 'approved' },
        'impl-result.json': { status: 'complete' },
        'code-review-1.json': { status: 'approved' },
      };
      const progress: PipelineProgress = {
        userStory: { title: 'test' },
        plan: { steps: [] },
        pipelineTasks: malformedPipelineTasks,
        analysisFiles: [],
        implResult: { status: 'complete' },
        stageOutputs,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('complete');
    });

    test('legacy fallback: works with resolved_config when stages[] absent', () => {
      // Simulate old-format pipeline-tasks.json without top-level stages[]
      const legacyPipelineTasks = {
        pipeline_type: 'feature-implement',
        team_name: 'pipeline-test-abc123',
        resolved_config: {
          feature_pipeline: [
            { type: 'requirements', provider: 'anthropic-subscription', model: 'opus' },
            { type: 'planning', provider: 'anthropic-subscription', model: 'opus' },
            { type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet' },
            { type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet' },
            { type: 'code-review', provider: 'anthropic-subscription', model: 'sonnet' },
          ],
          bugfix_pipeline: [],
          max_iterations: 10,
          team_name_pattern: 'pipeline-{BASENAME}-{HASH}',
        },
        // No top-level stages[] — legacy format
      };
      // Legacy naming: plan-review-1.json, code-review-1.json
      const stageOutputs: Record<string, StageOutputEntry> = {
        'user-story.json': { status: 'complete' },
        'plan-refined.json': { status: 'complete' },
        'plan-review-1.json': { status: 'approved' },
        'impl-result.json': { status: 'complete' },
        'code-review-1.json': { status: 'approved' },
      };
      const progress: PipelineProgress = {
        userStory: { title: 'test' },
        plan: { steps: [] },
        pipelineTasks: legacyPipelineTasks,
        analysisFiles: [],
        implResult: { status: 'complete' },
        stageOutputs,
      };
      const result = determinePhase(progress);
      expect(result.phase).toBe('complete');
    });
  });
});
