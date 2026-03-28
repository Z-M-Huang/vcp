import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_CONFIG,
  DEFAULT_V3_CONFIG,
  validateDevBuddyConfig,
  migrateV2ToV3,
  validatePipelineName,
} from '../pipeline-config.ts';
import type { PipelineConfig, DevBuddyConfig } from '../../types/pipeline.ts';

// ─── DEFAULT_CONFIG (v4) ────────────────────────────────────────────────────

describe('DEFAULT_CONFIG', () => {
  test('has version 4.0', () => {
    expect(DEFAULT_CONFIG.version).toBe('4.0');
  });

  test('has all 6 stage types', () => {
    const stages = Object.keys(DEFAULT_CONFIG.stages);
    expect(stages).toContain('requirements');
    expect(stages).toContain('planning');
    expect(stages).toContain('plan-review');
    expect(stages).toContain('implementation');
    expect(stages).toContain('code-review');
    expect(stages).toContain('rca');
  });

  test('each stage has inline executors with system_prompt, preset, model', () => {
    for (const [, stage] of Object.entries(DEFAULT_CONFIG.stages)) {
      expect(Array.isArray(stage.executors)).toBe(true);
      for (const exec of stage.executors) {
        expect(exec.system_prompt).toBeTruthy();
        expect(exec.preset).toBeTruthy();
        expect(exec.model).toBeTruthy();
      }
    }
  });

  test('has no top-level executors key', () => {
    expect((DEFAULT_CONFIG as Record<string, unknown>).executors).toBeUndefined();
  });

  test('has max_tdd_iterations', () => {
    expect(DEFAULT_CONFIG.max_tdd_iterations).toBe(5);
  });

  test('rca last executor is non-parallel (synthesizer)', () => {
    const rcaExecutors = DEFAULT_CONFIG.stages.rca.executors;
    expect(rcaExecutors.length).toBeGreaterThan(1);
    const last = rcaExecutors[rcaExecutors.length - 1];
    expect(last.parallel).not.toBe(true);
  });

  test('has default pipelines: feature and bug-fix', () => {
    expect(DEFAULT_CONFIG.pipelines).toHaveProperty('feature');
    expect(DEFAULT_CONFIG.pipelines).toHaveProperty('bug-fix');
    expect(DEFAULT_CONFIG.pipelines['feature']).toContain('requirements');
    expect(DEFAULT_CONFIG.pipelines['bug-fix']).toContain('rca');
  });

  test('DEFAULT_V3_CONFIG alias points to same object', () => {
    expect(DEFAULT_V3_CONFIG).toBe(DEFAULT_CONFIG);
  });
});

// ─── validatePipelineName ────────────────────────────────────────────────────

describe('validatePipelineName', () => {
  test('accepts valid names', () => {
    expect(() => validatePipelineName('feature')).not.toThrow();
    expect(() => validatePipelineName('bug-fix')).not.toThrow();
    expect(() => validatePipelineName('hotfix-2')).not.toThrow();
    expect(() => validatePipelineName('a')).not.toThrow();
  });

  test('rejects empty name', () => {
    expect(() => validatePipelineName('')).toThrow(/1-50 characters/);
  });

  test('rejects names over 50 chars', () => {
    expect(() => validatePipelineName('a'.repeat(51))).toThrow(/1-50 characters/);
  });

  test('rejects names starting with hyphen', () => {
    expect(() => validatePipelineName('-feature')).toThrow(/invalid/);
  });

  test('rejects uppercase', () => {
    expect(() => validatePipelineName('Feature')).toThrow(/invalid/);
  });

  test('rejects prototype pollution names', () => {
    expect(() => validatePipelineName('__proto__')).toThrow(/forbidden/);
    expect(() => validatePipelineName('constructor')).toThrow(/forbidden/);
    expect(() => validatePipelineName('prototype')).toThrow(/forbidden/);
  });
});

// ─── validateDevBuddyConfig ─────────────────────────────────────────────────

describe('validateDevBuddyConfig', () => {
  test('accepts valid config', () => {
    expect(() => validateDevBuddyConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  test('rejects wrong version', () => {
    const config = { ...DEFAULT_CONFIG, version: '3.0' as '4.0' };
    expect(() => validateDevBuddyConfig(config)).toThrow(/version/);
  });

  test('rejects missing stage', () => {
    const stages = { ...DEFAULT_CONFIG.stages };
    delete (stages as Record<string, unknown>)['requirements'];
    const config = { ...DEFAULT_CONFIG, stages };
    expect(() => validateDevBuddyConfig(config)).toThrow(/Missing stage/);
  });

  test('rejects executor without system_prompt', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages.planning.executors = [{ system_prompt: '', preset: 'x', model: 'y' }];
    expect(() => validateDevBuddyConfig(config)).toThrow(/system_prompt/);
  });

  test('rejects empty pipelines object', () => {
    const config = { ...DEFAULT_CONFIG, pipelines: {} };
    expect(() => validateDevBuddyConfig(config)).toThrow(/At least 1 pipeline/);
  });

  test('rejects invalid pipeline name', () => {
    const config = { ...DEFAULT_CONFIG, pipelines: { 'Bad Name': ['requirements'] as any } };
    expect(() => validateDevBuddyConfig(config)).toThrow(/invalid/);
  });

  test('rejects pipeline with invalid stage type', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.pipelines['test'] = ['nonexistent' as any];
    expect(() => validateDevBuddyConfig(config)).toThrow(/invalid stage type/);
  });

  test('rejects implementation stage with more than 1 executor', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages.implementation.executors = [
      { system_prompt: 'implementer', preset: 'anthropic-subscription', model: 'sonnet' },
      { system_prompt: 'implementer', preset: 'anthropic-subscription', model: 'opus' },
    ];
    expect(() => validateDevBuddyConfig(config)).toThrow(/implementation.*maximum 1/);
  });

  test('rejects last executor as parallel when multiple executors (synthesizer rule)', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages.planning.executors = [
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'sonnet', parallel: true },
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'opus', parallel: true },
    ];
    expect(() => validateDevBuddyConfig(config)).toThrow(/last executor must be non-parallel/);
  });

  test('accepts multiple executors when last is non-parallel', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages.planning.executors = [
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'sonnet', parallel: true },
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'opus' },
    ];
    expect(() => validateDevBuddyConfig(config)).not.toThrow();
  });

  test('rejects non-boolean parallel value', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages.planning.executors = [
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'opus', parallel: 'yes' as unknown as boolean },
    ];
    expect(() => validateDevBuddyConfig(config)).toThrow(/parallel must be a boolean/);
  });

  test('rejects zero executors in active pipeline stage', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages.planning.executors = [];
    expect(() => validateDevBuddyConfig(config)).toThrow(/must have at least 1 executor/);
  });

  test('accepts any stage in any pipeline (no allowed_pipelines constraint)', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.pipelines['test'] = ['rca', 'requirements', 'planning'];
    expect(() => validateDevBuddyConfig(config)).not.toThrow();
  });
});

// ─── migrateV2ToV3 ──────────────────────────────────────────────────────────

describe('migrateV2ToV3', () => {
  test('converts v2 StageEntry arrays to inline executors', () => {
    const v2: PipelineConfig = {
      feature_pipeline: [
        { type: 'requirements', provider: 'anthropic-subscription', model: 'opus' },
        { type: 'planning', provider: 'anthropic-subscription', model: 'opus' },
        { type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet' },
      ],
      bugfix_pipeline: [
        { type: 'rca', provider: 'anthropic-subscription', model: 'sonnet' },
        { type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet' },
      ],
      max_iterations: 10,
      team_name_pattern: 'test-{BASENAME}-{HASH}',
    };

    const v3 = migrateV2ToV3(v2);
    expect(v3.version).toBe('3.0');
    expect((v3 as Record<string, unknown>).executors).toBeUndefined();

    // Check inline executors
    expect(v3.stages.planning.executors[0].system_prompt).toBe('planner');
    expect(v3.stages.planning.executors[0].preset).toBe('anthropic-subscription');
    expect(v3.stages.planning.executors[0].model).toBe('opus');

    // Check v3 format has feature_pipeline/bugfix_pipeline
    expect(v3.feature_pipeline).toContain('requirements');
    expect(v3.bugfix_pipeline).toContain('rca');
  });
});
