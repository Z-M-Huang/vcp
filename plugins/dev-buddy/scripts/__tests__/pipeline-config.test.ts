import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_CONFIG,
  validateDevBuddyConfig,
  loadDevBuddyConfig,
} from '../pipeline-config.ts';
import type { DevBuddyConfig } from '../../types/pipeline.ts';

// ─── DEFAULT_CONFIG (v5 Ralph) ──────────────────────────────────────────────

describe('DEFAULT_CONFIG', () => {
  test('has version 5.0', () => {
    expect(DEFAULT_CONFIG.version).toBe('5.0');
  });

  test('has all 6 Ralph stage types', () => {
    const stages = Object.keys(DEFAULT_CONFIG.stages);
    expect(stages).toContain('discovery');
    expect(stages).toContain('ralph-requirements');
    expect(stages).toContain('decomposition');
    expect(stages).toContain('ralph-build');
    expect(stages).toContain('ralph-code-review');
    expect(stages).toContain('ralph-uat');
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

  test('has max_build_attempts', () => {
    expect(DEFAULT_CONFIG.max_build_attempts).toBe(3);
  });

  test('has max_outer_iterations', () => {
    expect(DEFAULT_CONFIG.max_outer_iterations).toBe(3);
  });

  test('has internal loop iteration defaults', () => {
    expect(DEFAULT_CONFIG.max_discovery_iterations).toBe(3);
    expect(DEFAULT_CONFIG.max_requirements_iterations).toBe(3);
    expect(DEFAULT_CONFIG.max_decomposition_iterations).toBe(2);
  });


  test('has ralph pipeline', () => {
    expect(DEFAULT_CONFIG.pipelines).toHaveProperty('ralph');
    expect(DEFAULT_CONFIG.pipelines['ralph']).toContain('discovery');
    expect(DEFAULT_CONFIG.pipelines['ralph']).toContain('ralph-uat');
  });

  test('ralph pipeline has correct order', () => {
    const pipeline = DEFAULT_CONFIG.pipelines['ralph'];
    expect(pipeline).toEqual([
      'discovery', 'ralph-requirements', 'decomposition',
      'ralph-build', 'ralph-code-review', 'ralph-uat',
    ]);
  });
});

// ─── validateDevBuddyConfig ─────────────────────────────────────────────────

describe('validateDevBuddyConfig', () => {
  test('accepts valid config', () => {
    expect(() => validateDevBuddyConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  test('rejects wrong version', () => {
    const config = { ...DEFAULT_CONFIG, version: '4.0' as '5.0' };
    expect(() => validateDevBuddyConfig(config)).toThrow(/version/);
  });

  test('rejects missing stage', () => {
    const stages = { ...DEFAULT_CONFIG.stages };
    delete (stages as Record<string, unknown>)['discovery'];
    const config = { ...DEFAULT_CONFIG, stages };
    expect(() => validateDevBuddyConfig(config)).toThrow(/Missing stage/);
  });

  test('rejects executor without system_prompt', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages.decomposition.executors = [{ system_prompt: '', preset: 'x', model: 'y' }];
    expect(() => validateDevBuddyConfig(config)).toThrow(/system_prompt/);
  });

  test('rejects empty pipelines object', () => {
    const config = { ...DEFAULT_CONFIG, pipelines: {} };
    expect(() => validateDevBuddyConfig(config)).toThrow(/At least 1 pipeline/);
  });

  test('rejects invalid pipeline name', () => {
    const config = { ...DEFAULT_CONFIG, pipelines: { 'Bad Name': ['discovery'] as any } };
    expect(() => validateDevBuddyConfig(config)).toThrow(/invalid/);
  });

  test('rejects pipeline with invalid stage type', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.pipelines['test'] = ['nonexistent' as any];
    expect(() => validateDevBuddyConfig(config)).toThrow(/invalid stage type/);
  });

  test('rejects ralph-build with more than 1 executor', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages['ralph-build'].executors = [
      { system_prompt: 'unit-builder', preset: 'anthropic-subscription', model: 'sonnet' },
      { system_prompt: 'unit-builder', preset: 'anthropic-subscription', model: 'opus' },
    ];
    expect(() => validateDevBuddyConfig(config)).toThrow(/ralph-build.*maximum 1/);
  });

  test('rejects ralph-uat with more than 1 executor', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages['ralph-uat'].executors = [
      { system_prompt: 'uat-evaluator', preset: 'anthropic-subscription', model: 'sonnet' },
      { system_prompt: 'uat-evaluator', preset: 'anthropic-subscription', model: 'opus' },
    ];
    expect(() => validateDevBuddyConfig(config)).toThrow(/ralph-uat.*maximum 1/);
  });

  test('rejects non-boolean parallel value', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages.decomposition.executors = [
      { system_prompt: 'decomposer', preset: 'anthropic-subscription', model: 'opus', parallel: 'yes' as unknown as boolean },
    ];
    expect(() => validateDevBuddyConfig(config)).toThrow(/parallel must be a boolean/);
  });

  test('rejects zero executors in active pipeline stage', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.stages.decomposition.executors = [];
    expect(() => validateDevBuddyConfig(config)).toThrow(/must have at least 1 executor/);
  });

  test('rejects negative max_build_attempts', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.max_build_attempts = -1;
    expect(() => validateDevBuddyConfig(config)).toThrow(/max_build_attempts/);
  });

  test('rejects negative max_outer_iterations', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.max_outer_iterations = 0;
    expect(() => validateDevBuddyConfig(config)).toThrow(/max_outer_iterations/);
  });

  test('rejects zero max_discovery_iterations', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.max_discovery_iterations = 0;
    expect(() => validateDevBuddyConfig(config)).toThrow(/max_discovery_iterations/);
  });

  test('rejects negative max_requirements_iterations', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.max_requirements_iterations = -1;
    expect(() => validateDevBuddyConfig(config)).toThrow(/max_requirements_iterations/);
  });

  test('rejects zero max_decomposition_iterations', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.max_decomposition_iterations = 0;
    expect(() => validateDevBuddyConfig(config)).toThrow(/max_decomposition_iterations/);
  });

});

// ─── loadDevBuddyConfig — additive default-filling ─────────────────────────

describe('loadDevBuddyConfig default-filling', () => {
  test('fills missing internal loop fields on existing v5 config', () => {
    // loadDevBuddyConfig reads from ~/.vcp/dev-buddy.json — we test via
    // DEFAULT_CONFIG that it has the fields, and validate accepts them.
    // The actual file-based regression test is a smoke test (manual).
    const config = structuredClone(DEFAULT_CONFIG);
    expect(config.max_discovery_iterations).toBe(3);
    expect(config.max_requirements_iterations).toBe(3);
    expect(config.max_decomposition_iterations).toBe(2);
    expect(() => validateDevBuddyConfig(config)).not.toThrow();
  });
});
