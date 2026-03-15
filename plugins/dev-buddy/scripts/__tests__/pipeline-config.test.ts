import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_V3_CONFIG,
  validateDevBuddyConfig,
  migrateV2ToV3,
} from '../pipeline-config.ts';
import type { PipelineConfig, DevBuddyConfig } from '../../types/pipeline.ts';

// ─── DEFAULT_V3_CONFIG ──────────────────────────────────────────────────────

describe('DEFAULT_V3_CONFIG', () => {
  test('has version 3.0', () => {
    expect(DEFAULT_V3_CONFIG.version).toBe('3.0');
  });

  test('has all 6 stage types', () => {
    const stages = Object.keys(DEFAULT_V3_CONFIG.stages);
    expect(stages).toContain('requirements');
    expect(stages).toContain('planning');
    expect(stages).toContain('plan-review');
    expect(stages).toContain('implementation');
    expect(stages).toContain('code-review');
    expect(stages).toContain('rca');
  });

  test('each stage has inline executors with system_prompt, preset, model', () => {
    for (const [, stage] of Object.entries(DEFAULT_V3_CONFIG.stages)) {
      expect(Array.isArray(stage.executors)).toBe(true);
      for (const exec of stage.executors) {
        expect(exec.system_prompt).toBeTruthy();
        expect(exec.preset).toBeTruthy();
        expect(exec.model).toBeTruthy();
      }
    }
  });

  test('has no top-level executors key', () => {
    expect((DEFAULT_V3_CONFIG as Record<string, unknown>).executors).toBeUndefined();
  });

  test('has max_tdd_iterations', () => {
    expect(DEFAULT_V3_CONFIG.max_tdd_iterations).toBe(5);
  });

  test('rca last executor is non-parallel (synthesizer)', () => {
    const rcaExecutors = DEFAULT_V3_CONFIG.stages.rca.executors;
    expect(rcaExecutors.length).toBeGreaterThan(1);
    const last = rcaExecutors[rcaExecutors.length - 1];
    expect(last.parallel).not.toBe(true);
  });
});

// ─── validateDevBuddyConfig ─────────────────────────────────────────────────

describe('validateDevBuddyConfig', () => {
  test('accepts valid config', () => {
    expect(() => validateDevBuddyConfig(DEFAULT_V3_CONFIG)).not.toThrow();
  });

  test('rejects wrong version', () => {
    const config = { ...DEFAULT_V3_CONFIG, version: '2.0' as '3.0' };
    expect(() => validateDevBuddyConfig(config)).toThrow(/version/);
  });

  test('rejects missing stage', () => {
    const stages = { ...DEFAULT_V3_CONFIG.stages };
    delete (stages as Record<string, unknown>)['requirements'];
    const config = { ...DEFAULT_V3_CONFIG, stages };
    expect(() => validateDevBuddyConfig(config)).toThrow(/Missing stage/);
  });

  test('rejects executor without system_prompt', () => {
    const config = structuredClone(DEFAULT_V3_CONFIG);
    config.stages.planning.executors = [{ system_prompt: '', preset: 'x', model: 'y' }];
    expect(() => validateDevBuddyConfig(config)).toThrow(/system_prompt/);
  });

  test('rejects rca in feature_pipeline', () => {
    const config = { ...DEFAULT_V3_CONFIG, feature_pipeline: ['rca' as const, ...DEFAULT_V3_CONFIG.feature_pipeline] };
    expect(() => validateDevBuddyConfig(config)).toThrow(/rca.*only allowed in bugfix/);
  });

  test('rejects implementation stage with more than 1 executor', () => {
    const config = structuredClone(DEFAULT_V3_CONFIG);
    config.stages.implementation.executors = [
      { system_prompt: 'implementer', preset: 'anthropic-subscription', model: 'sonnet' },
      { system_prompt: 'implementer', preset: 'anthropic-subscription', model: 'opus' },
    ];
    expect(() => validateDevBuddyConfig(config)).toThrow(/implementation.*maximum 1/);
  });

  test('rejects last executor as parallel when multiple executors (synthesizer rule)', () => {
    const config = structuredClone(DEFAULT_V3_CONFIG);
    config.stages.planning.executors = [
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'sonnet', parallel: true },
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'opus', parallel: true },
    ];
    expect(() => validateDevBuddyConfig(config)).toThrow(/last executor must be non-parallel/);
  });

  test('accepts multiple executors when last is non-parallel', () => {
    const config = structuredClone(DEFAULT_V3_CONFIG);
    config.stages.planning.executors = [
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'sonnet', parallel: true },
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'opus' },
    ];
    expect(() => validateDevBuddyConfig(config)).not.toThrow();
  });

  test('rejects non-boolean parallel value', () => {
    const config = structuredClone(DEFAULT_V3_CONFIG);
    config.stages.planning.executors = [
      { system_prompt: 'planner', preset: 'anthropic-subscription', model: 'opus', parallel: 'yes' as unknown as boolean },
    ];
    expect(() => validateDevBuddyConfig(config)).toThrow(/parallel must be a boolean/);
  });

  test('rejects zero executors in active pipeline stage', () => {
    const config = structuredClone(DEFAULT_V3_CONFIG);
    config.stages.planning.executors = [];
    expect(() => validateDevBuddyConfig(config)).toThrow(/must have at least 1 executor/);
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
  });
});
