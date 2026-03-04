import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getImplStepFileName,
  getPhasedReviewFileName,
  SAFE_PATH_RE,
} from '../../types/stage-definitions.ts';
import {
  validateConfig,
  DEFAULT_CONFIG,
} from '../pipeline-config.ts';
import type { PipelineConfig } from '../../types/pipeline.ts';

// ─── Minimal valid config factory ────────────────────────────────────────────

function makeValidConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    feature_pipeline: [
      { type: 'requirements', provider: 'anthropic-subscription', model: 'opus' },
      { type: 'planning', provider: 'anthropic-subscription', model: 'opus' },
      { type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet' },
    ],
    bugfix_pipeline: [
      { type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet' },
    ],
    max_iterations: 10,
    team_name_pattern: 'pipeline-{BASENAME}-{HASH}',
    ...overrides,
  };
}

// ─── getImplStepFileName ──────────────────────────────────────────────────────

describe('getImplStepFileName', () => {
  test('returns impl-step-3-v1.json for step=3, version=1', () => {
    expect(getImplStepFileName(3, 1)).toBe('impl-step-3-v1.json');
  });

  test('returns impl-step-1-v2.json for step=1, version=2', () => {
    expect(getImplStepFileName(1, 2)).toBe('impl-step-1-v2.json');
  });

  test('output passes SAFE_PATH_RE', () => {
    expect(SAFE_PATH_RE.test(getImplStepFileName(5, 3))).toBe(true);
  });

  test('returns impl-step-10-v1.json for step=10', () => {
    expect(getImplStepFileName(10, 1)).toBe('impl-step-10-v1.json');
  });

  test('throws on non-positive step', () => {
    expect(() => getImplStepFileName(0, 1)).toThrow('step must be a positive integer');
    expect(() => getImplStepFileName(-1, 1)).toThrow('step must be a positive integer');
  });

  test('throws on non-integer step', () => {
    expect(() => getImplStepFileName(1.5, 1)).toThrow('step must be a positive integer');
  });

  test('throws on non-positive version', () => {
    expect(() => getImplStepFileName(1, 0)).toThrow('version must be a positive integer');
    expect(() => getImplStepFileName(1, -1)).toThrow('version must be a positive integer');
  });
});

// ─── getPhasedReviewFileName ──────────────────────────────────────────────────

describe('getPhasedReviewFileName', () => {
  test('returns correct filename for standard inputs', () => {
    expect(getPhasedReviewFileName(3, 'anthropic', 'claude-sonnet-4', 1)).toBe(
      'phased-review-anthropic-claude-sonnet-4-step-3-v1.json'
    );
  });

  test('sanitizes uppercase in provider and model', () => {
    // sanitizeForFilename lowercases input
    const result = getPhasedReviewFileName(2, 'Anthropic', 'Claude-Sonnet', 1);
    expect(result).toBe('phased-review-anthropic-claude-sonnet-step-2-v1.json');
  });

  test('sanitizes spaces/underscores to hyphens', () => {
    const result = getPhasedReviewFileName(1, 'my provider', 'my_model', 1);
    expect(result).toBe('phased-review-my-provider-my-model-step-1-v1.json');
  });

  test('output passes SAFE_PATH_RE', () => {
    expect(SAFE_PATH_RE.test(getPhasedReviewFileName(3, 'anthropic', 'claude-sonnet-4', 1))).toBe(true);
  });

  test('follows convention: phased-review-{provider}-{model}-step-{N}-v{version}.json', () => {
    const result = getPhasedReviewFileName(5, 'mypreset', 'gpt-4o', 2);
    expect(result).toBe('phased-review-mypreset-gpt-4o-step-5-v2.json');
  });

  test('increments version correctly', () => {
    expect(getPhasedReviewFileName(3, 'anthropic', 'sonnet', 1)).toBe(
      'phased-review-anthropic-sonnet-step-3-v1.json'
    );
    expect(getPhasedReviewFileName(3, 'anthropic', 'sonnet', 2)).toBe(
      'phased-review-anthropic-sonnet-step-3-v2.json'
    );
  });

  test('throws on non-positive step', () => {
    expect(() => getPhasedReviewFileName(0, 'a', 'b', 1)).toThrow('step must be a positive integer');
  });

  test('throws on non-positive version', () => {
    expect(() => getPhasedReviewFileName(1, 'a', 'b', 0)).toThrow('version must be a positive integer');
  });
});

// ─── DEFAULT_CONFIG ──────────────────────────────────────────────────────────

describe('DEFAULT_CONFIG', () => {
  test('includes max_phased_iterations: 3', () => {
    expect(DEFAULT_CONFIG.max_phased_iterations).toBe(3);
  });
});

// ─── validateConfig - phased_reviews ─────────────────────────────────────────

describe('validateConfig - phased_reviews', () => {
  const validPhasedReview = { provider: 'anthropic-subscription', model: 'sonnet' };

  test('rejects phased_reviews on plan-review stage', () => {
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus' },
        { type: 'plan-review', provider: 'p', model: 'sonnet', phased_reviews: [validPhasedReview] } as any,
        { type: 'implementation', provider: 'p', model: 'sonnet' },
      ],
    });
    expect(() => validateConfig(config)).toThrow(/phased_reviews is only allowed on implementation/);
  });

  test('rejects phased_reviews on code-review stage', () => {
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus' },
        { type: 'implementation', provider: 'p', model: 'sonnet' },
        { type: 'code-review', provider: 'p', model: 'sonnet', phased_reviews: [validPhasedReview] } as any,
      ],
    });
    expect(() => validateConfig(config)).toThrow(/phased_reviews is only allowed on implementation/);
  });

  test('rejects phased_reviews on requirements stage', () => {
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus', phased_reviews: [validPhasedReview] } as any,
        { type: 'planning', provider: 'p', model: 'opus' },
        { type: 'implementation', provider: 'p', model: 'sonnet' },
      ],
    });
    expect(() => validateConfig(config)).toThrow(/phased_reviews is only allowed on implementation/);
  });

  test('rejects phased_reviews on planning stage', () => {
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus', phased_reviews: [validPhasedReview] } as any,
        { type: 'implementation', provider: 'p', model: 'sonnet' },
      ],
    });
    expect(() => validateConfig(config)).toThrow(/phased_reviews is only allowed on implementation/);
  });

  test('rejects phased_reviews on rca stage', () => {
    const config = makeValidConfig({
      bugfix_pipeline: [
        { type: 'rca', provider: 'p', model: 'sonnet', phased_reviews: [validPhasedReview] } as any,
        { type: 'implementation', provider: 'p', model: 'sonnet' },
      ],
    });
    expect(() => validateConfig(config)).toThrow(/phased_reviews is only allowed on implementation/);
  });

  test('accepts phased_reviews on implementation stage with valid entries', () => {
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus' },
        {
          type: 'implementation',
          provider: 'p',
          model: 'sonnet',
          phased_reviews: [
            { provider: 'anthropic-subscription', model: 'sonnet' },
            { provider: 'my-api', model: 'claude-3.5-sonnet', parallel: true },
          ],
        },
      ],
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('accepts empty phased_reviews array on implementation stage', () => {
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus' },
        { type: 'implementation', provider: 'p', model: 'sonnet', phased_reviews: [] },
      ],
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('accepts config with phased_reviews omitted (backward compat)', () => {
    const config = makeValidConfig();
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('rejects entry with empty provider string', () => {
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus' },
        {
          type: 'implementation',
          provider: 'p',
          model: 'sonnet',
          phased_reviews: [{ provider: '', model: 'sonnet' }],
        },
      ],
    });
    expect(() => validateConfig(config)).toThrow(/provider must be a non-empty string/);
  });

  test('rejects entry with model not matching MODEL_NAME_REGEX', () => {
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus' },
        {
          type: 'implementation',
          provider: 'p',
          model: 'sonnet',
          phased_reviews: [{ provider: 'p', model: 'model;rm -rf /' }],
        },
      ],
    });
    expect(() => validateConfig(config)).toThrow(/invalid model name/);
  });

  test('rejects entry with non-boolean parallel', () => {
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus' },
        {
          type: 'implementation',
          provider: 'p',
          model: 'sonnet',
          phased_reviews: [{ provider: 'p', model: 'sonnet', parallel: 'yes' as any }],
        },
      ],
    });
    expect(() => validateConfig(config)).toThrow(/parallel must be a boolean/);
  });

  test('rejects array of 11 entries (max 10)', () => {
    const entries = Array.from({ length: 11 }, () => ({ provider: 'p', model: 'sonnet' }));
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus' },
        { type: 'implementation', provider: 'p', model: 'sonnet', phased_reviews: entries },
      ],
    });
    expect(() => validateConfig(config)).toThrow(/exceeds maximum of 10/);
  });

  test('accepts array of 10 valid entries', () => {
    const entries = Array.from({ length: 10 }, () => ({ provider: 'p', model: 'sonnet' }));
    const config = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'p', model: 'opus' },
        { type: 'planning', provider: 'p', model: 'opus' },
        { type: 'implementation', provider: 'p', model: 'sonnet', phased_reviews: entries },
      ],
    });
    expect(() => validateConfig(config)).not.toThrow();
  });
});

// ─── validateConfig - max_phased_iterations ──────────────────────────────────

describe('validateConfig - max_phased_iterations', () => {
  test('rejects 0 (not positive)', () => {
    const config = makeValidConfig({ max_phased_iterations: 0 });
    expect(() => validateConfig(config)).toThrow(/max_phased_iterations must be a positive integer/);
  });

  test('rejects -1 (negative)', () => {
    const config = makeValidConfig({ max_phased_iterations: -1 });
    expect(() => validateConfig(config)).toThrow(/max_phased_iterations must be a positive integer/);
  });

  test('rejects 3.5 (non-integer)', () => {
    const config = makeValidConfig({ max_phased_iterations: 3.5 });
    expect(() => validateConfig(config)).toThrow(/max_phased_iterations must be a positive integer/);
  });

  test('accepts 1 (minimum valid)', () => {
    const config = makeValidConfig({ max_phased_iterations: 1 });
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('accepts 3 (default value)', () => {
    const config = makeValidConfig({ max_phased_iterations: 3 });
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('accepts undefined (uses resolved default after loadPipelineConfig)', () => {
    const config = makeValidConfig();
    // max_phased_iterations not set -> no error from validateConfig
    expect(() => validateConfig(config)).not.toThrow();
  });
});

// ─── validateProviderReferences - phased_reviews ─────────────────────────────

describe('validateProviderReferences - phased_reviews providers collected', () => {
  const presetsPath = path.join(os.homedir(), '.vcp', 'ai-presets.json');
  let originalPresets: string | null = null;

  beforeEach(() => {
    // Back up existing presets if any
    if (fs.existsSync(presetsPath)) {
      originalPresets = fs.readFileSync(presetsPath, 'utf-8');
    } else {
      originalPresets = null;
    }
  });

  afterEach(() => {
    // Restore original presets
    if (originalPresets !== null) {
      fs.writeFileSync(presetsPath, originalPresets, 'utf-8');
    } else if (fs.existsSync(presetsPath)) {
      fs.unlinkSync(presetsPath);
    }
  });

  function writePresets(presets: Record<string, unknown>) {
    const vcpDir = path.dirname(presetsPath);
    fs.mkdirSync(vcpDir, { recursive: true });
    fs.writeFileSync(presetsPath, JSON.stringify({ presets }), 'utf-8');
  }

  test('validateProviderReferences collects providers from phased_reviews entries', () => {
    writePresets({
      'anthropic-subscription': { type: 'subscription', name: 'Anthropic' },
      'my-api-preset': {
        type: 'api',
        name: 'My API',
        base_url: 'https://api.example.com',
        api_key: 'sk-test',
        models: ['claude-sonnet-4'],
      },
    });

    const { validateProviderReferences } = require('../pipeline-config.ts');

    const config: PipelineConfig = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'anthropic-subscription', model: 'opus' },
        { type: 'planning', provider: 'anthropic-subscription', model: 'opus' },
        {
          type: 'implementation',
          provider: 'anthropic-subscription',
          model: 'sonnet',
          phased_reviews: [{ provider: 'my-api-preset', model: 'claude-sonnet-4' }],
        },
      ],
    });

    // Should not throw since 'my-api-preset' exists and has required fields
    expect(() => validateProviderReferences(config)).not.toThrow();
  });

  test('reports missing phased_reviews provider in error', () => {
    writePresets({
      'anthropic-subscription': { type: 'subscription', name: 'Anthropic' },
      // 'my-api-preset' intentionally absent
    });

    const { validateProviderReferences } = require('../pipeline-config.ts');

    const config: PipelineConfig = makeValidConfig({
      feature_pipeline: [
        { type: 'requirements', provider: 'anthropic-subscription', model: 'opus' },
        { type: 'planning', provider: 'anthropic-subscription', model: 'opus' },
        {
          type: 'implementation',
          provider: 'anthropic-subscription',
          model: 'sonnet',
          phased_reviews: [{ provider: 'my-api-preset', model: 'claude-sonnet-4' }],
        },
      ],
    });

    expect(() => validateProviderReferences(config)).toThrow(/my-api-preset/);
  });
});
