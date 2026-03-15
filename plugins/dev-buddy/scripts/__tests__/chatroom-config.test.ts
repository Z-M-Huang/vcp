import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadChatroomConfig,
  saveChatroomConfig,
  validateChatroomConfig,
  DEFAULT_CHATROOM_CONFIG,
  CHATROOM_CONFIG_PATH,
  ALLOWED_CHATROOM_FIELDS,
  ALLOWED_PARTICIPANT_FIELDS,
} from '../chatroom-config.ts';
import type { PresetConfig } from '../../types/presets.ts';

// ─── Test preset factory ─────────────────────────────────────────────────────

function makePresets(overrides: Partial<PresetConfig['presets']> = {}): PresetConfig {
  return {
    version: '2.0',
    presets: {
      'anthropic-subscription': { type: 'subscription', name: 'Anthropic' },
      'minimax-api': {
        type: 'api',
        name: 'MiniMax',
        base_url: 'https://api.minimax.chat',
        api_key: 'sk-test',
        models: ['MiniMax-M2.5'],
      },
      'codex-cli': {
        type: 'cli',
        name: 'Codex',
        command: 'codex',
        args_template: 'exec -m {model} -o {output_file} {prompt}',
        one_shot_args_template: 'exec -m {model} "{prompt}"',
        models: ['gpt-5.4'],
      },
      'cli-no-oneshot': {
        type: 'cli',
        name: 'CLI No OneShot',
        command: 'myctl',
        args_template: 'run -m {model} -o {output_file} {prompt}',
        models: ['model-a'],
      },
      ...overrides,
    },
  };
}

// ─── validateChatroomConfig ──────────────────────────────────────────────────

describe('validateChatroomConfig', () => {
  const presets = makePresets();

  test('accepts valid config with mixed preset types', () => {
    const config = {
      participants: [
        { preset: 'anthropic-subscription', model: 'sonnet' },
        { preset: 'minimax-api', model: 'MiniMax-M2.5' },
        { preset: 'codex-cli', model: 'gpt-5.4' },
      ],
      max_rounds: 3,
    };
    expect(validateChatroomConfig(config, presets)).toBeNull();
  });

  test('accepts empty participants array (valid for saving)', () => {
    const config = { participants: [], max_rounds: 3 };
    expect(validateChatroomConfig(config, presets)).toBeNull();
  });

  test('rejects unknown top-level fields', () => {
    const config = { participants: [], max_rounds: 3, extra_field: true };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('Unknown fields rejected');
    expect(err).toContain('extra_field');
  });

  test('rejects unknown participant fields', () => {
    const config = {
      participants: [{ preset: 'anthropic-subscription', model: 'sonnet', role: 'critic' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('unknown fields rejected');
    expect(err).toContain('role');
  });

  test('rejects max_rounds outside 1-10 (too low)', () => {
    const config = { participants: [], max_rounds: 0 };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('max_rounds');
  });

  test('rejects max_rounds outside 1-10 (too high)', () => {
    const config = { participants: [], max_rounds: 11 };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('max_rounds');
  });

  test('rejects non-integer max_rounds', () => {
    const config = { participants: [], max_rounds: 2.5 };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('max_rounds');
  });

  test('rejects missing max_rounds', () => {
    const config = { participants: [] };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('max_rounds');
  });

  test('rejects participants with non-existent preset', () => {
    const config = {
      participants: [{ preset: 'non-existent', model: 'foo' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('not found');
    expect(err).toContain('non-existent');
  });

  test('rejects participants with invalid model for subscription preset', () => {
    const config = {
      participants: [{ preset: 'anthropic-subscription', model: 'gpt-4' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('not valid for subscription');
  });

  test('rejects participants with invalid model for API preset', () => {
    const config = {
      participants: [{ preset: 'minimax-api', model: 'nonexistent-model' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('not found in preset');
    expect(err).toContain('nonexistent-model');
  });

  test('rejects CLI participants without one_shot_args_template', () => {
    const config = {
      participants: [{ preset: 'cli-no-oneshot', model: 'model-a' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('one_shot_args_template');
    expect(err).toContain('cli-no-oneshot');
  });

  test('accepts CLI participants with one_shot_args_template', () => {
    const config = {
      participants: [{ preset: 'codex-cli', model: 'gpt-5.4' }],
      max_rounds: 3,
    };
    expect(validateChatroomConfig(config, presets)).toBeNull();
  });

  test('rejects more than 10 participants', () => {
    const config = {
      participants: Array.from({ length: 11 }, () => ({ preset: 'anthropic-subscription', model: 'sonnet' })),
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('Maximum 10');
  });

  test('rejects non-object body', () => {
    expect(validateChatroomConfig(null, presets)).toContain('JSON object');
    expect(validateChatroomConfig('string', presets)).toContain('JSON object');
    expect(validateChatroomConfig([], presets)).toContain('JSON object');
  });

  test('rejects participant with empty preset', () => {
    const config = {
      participants: [{ preset: '', model: 'sonnet' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('preset must be a non-empty string');
  });

  test('rejects participant with empty model', () => {
    const config = {
      participants: [{ preset: 'anthropic-subscription', model: '' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('model must be a non-empty string');
  });

  test('rejects model with invalid characters', () => {
    const config = {
      participants: [{ preset: 'minimax-api', model: 'bad model!' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('invalid characters');
  });

  test('accepts participant with valid system_prompt', () => {
    const config = {
      participants: [{ system_prompt: 'planner', preset: 'anthropic-subscription', model: 'sonnet' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toBeNull();
  });

  test('accepts participant with empty system_prompt', () => {
    const config = {
      participants: [{ system_prompt: '', preset: 'anthropic-subscription', model: 'sonnet' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toBeNull();
  });

  test('accepts participant without system_prompt field', () => {
    const config = {
      participants: [{ preset: 'anthropic-subscription', model: 'sonnet' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toBeNull();
  });

  test('rejects participant with non-existent system_prompt', () => {
    const config = {
      participants: [{ system_prompt: 'does-not-exist', preset: 'anthropic-subscription', model: 'sonnet' }],
      max_rounds: 3,
    };
    const err = validateChatroomConfig(config, presets);
    expect(err).toContain('system_prompt');
    expect(err).toContain('not found');
  });
});

// ─── Constants ───────────────────────────────────────────────────────────────

describe('constants', () => {
  test('DEFAULT_CHATROOM_CONFIG has expected shape', () => {
    expect(DEFAULT_CHATROOM_CONFIG).toEqual({
      participants: [],
      max_rounds: 3,
    });
  });

  test('ALLOWED_CHATROOM_FIELDS contains expected fields', () => {
    expect(ALLOWED_CHATROOM_FIELDS.has('participants')).toBe(true);
    expect(ALLOWED_CHATROOM_FIELDS.has('max_rounds')).toBe(true);
    expect(ALLOWED_CHATROOM_FIELDS.size).toBe(2);
  });

  test('ALLOWED_PARTICIPANT_FIELDS contains expected fields', () => {
    expect(ALLOWED_PARTICIPANT_FIELDS.has('preset')).toBe(true);
    expect(ALLOWED_PARTICIPANT_FIELDS.has('model')).toBe(true);
    expect(ALLOWED_PARTICIPANT_FIELDS.has('system_prompt')).toBe(true);
    expect(ALLOWED_PARTICIPANT_FIELDS.size).toBe(3);
  });
});

// ─── loadChatroomConfig ──────────────────────────────────────────────────────

describe('loadChatroomConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-load-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns defaults when file does not exist', () => {
    const result = loadChatroomConfig(path.join(tmpDir, 'nonexistent.json'));
    expect(result).toEqual({ participants: [], max_rounds: 3 });
  });

  test('loads valid config from disk', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const config = {
      participants: [{ preset: 'test', model: 'model-1' }],
      max_rounds: 5,
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const result = loadChatroomConfig(configPath);
    expect(result.participants).toEqual([{ preset: 'test', model: 'model-1' }]);
    expect(result.max_rounds).toBe(5);
  });

  test('merges with defaults when max_rounds is missing', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ participants: [] }));

    const result = loadChatroomConfig(configPath);
    expect(result.max_rounds).toBe(3);
  });

  test('throws on invalid JSON', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, 'not json {{{');

    expect(() => loadChatroomConfig(configPath)).toThrow('not valid JSON');
  });

  test('throws on non-object JSON', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '"just a string"');

    expect(() => loadChatroomConfig(configPath)).toThrow('must be a JSON object');
  });

  test('throws on unknown top-level fields', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ participants: [], extra: true }));

    expect(() => loadChatroomConfig(configPath)).toThrow('unknown fields');
  });

  test('throws when participants exceeds 10', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const config = {
      participants: Array.from({ length: 11 }, (_, i) => ({ preset: `p${i}`, model: `m${i}` })),
      max_rounds: 3,
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    expect(() => loadChatroomConfig(configPath)).toThrow('maximum 10');
  });

  test('throws on invalid model characters', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      participants: [{ preset: 'test', model: 'bad model!' }],
      max_rounds: 3,
    }));

    expect(() => loadChatroomConfig(configPath)).toThrow('invalid characters');
  });

  test('throws on invalid max_rounds', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ participants: [], max_rounds: 99 }));

    expect(() => loadChatroomConfig(configPath)).toThrow('max_rounds');
  });
});

// ─── saveChatroomConfig ──────────────────────────────────────────────────────

describe('saveChatroomConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-save-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes valid JSON via saveChatroomConfig', () => {
    const configPath = path.join(tmpDir, 'test-config.json');
    const config = { participants: [{ preset: 'test', model: 'model1' }], max_rounds: 5 };

    saveChatroomConfig(config, configPath);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.participants).toEqual([{ preset: 'test', model: 'model1' }]);
    expect(written.max_rounds).toBe(5);
  });

  test('creates parent directory if needed', () => {
    const nested = path.join(tmpDir, 'nested', 'dir', 'config.json');
    const config = { participants: [], max_rounds: 3 };

    saveChatroomConfig(config, nested);

    expect(fs.existsSync(nested)).toBe(true);
    const written = JSON.parse(fs.readFileSync(nested, 'utf-8'));
    expect(written).toEqual(config);
  });

  test('round-trips through save then load', () => {
    const configPath = path.join(tmpDir, 'roundtrip.json');
    const config = {
      participants: [
        { preset: 'alpha', model: 'model-A' },
        { preset: 'beta', model: 'model-B' },
      ],
      max_rounds: 7,
    };

    saveChatroomConfig(config, configPath);
    const loaded = loadChatroomConfig(configPath);
    expect(loaded).toEqual(config);
  });
});
