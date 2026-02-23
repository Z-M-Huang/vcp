import { describe, test, expect } from 'bun:test';
import { parseCLIArgs, buildSessionEnv } from '../session-manager.ts';
import type { ApiPreset } from '../../types/presets.ts';

// ================== parseCLIArgs --model flag ==================

describe('parseCLIArgs --model flag', () => {
  const base = ['bun', 'session-manager.ts', '--preset', 'test-preset'];

  test('parses --model flag', () => {
    const config = parseCLIArgs([...base, '--model', 'MiniMax-M2.5']);
    expect(config.model_override).toBe('MiniMax-M2.5');
  });

  test('model_override is undefined when --model not provided', () => {
    const config = parseCLIArgs(base);
    expect(config.model_override).toBeUndefined();
  });

  test('parses --model with other flags', () => {
    const config = parseCLIArgs([
      ...base,
      '--model', 'o3',
      '--cwd', '/project',
      '--task-timeout', '60000',
    ]);
    expect(config.model_override).toBe('o3');
    expect(config.cwd).toBe('/project');
    expect(config.task_timeout_ms).toBe(60000);
  });

  test('throws on --model without value', () => {
    expect(() => parseCLIArgs([...base, '--model'])).toThrow('--model requires a value');
  });

  test('backwards compatible — existing args still work', () => {
    const config = parseCLIArgs([
      ...base,
      '--cwd', '/dir',
      '--idle-timeout', '30',
      '--allowed-tools', 'Read,Write',
      '--task-timeout', '120000',
    ]);
    expect(config.preset_name).toBe('test-preset');
    expect(config.cwd).toBe('/dir');
    expect(config.idle_timeout_minutes).toBe(30);
    expect(config.allowed_tools).toBe('Read,Write');
    expect(config.task_timeout_ms).toBe(120000);
    expect(config.model_override).toBeUndefined();
  });
});

// ================== buildSessionEnv model override ==================

describe('buildSessionEnv model override', () => {
  // Use a clearly-fake key that won't trigger secret detection
  const TEST_KEY = process.env.TEST_DUMMY_KEY || 'test-placeholder-not-a-real-key';

  const basePreset: ApiPreset = {
    type: 'api',
    name: 'test-api',
    base_url: 'https://api.example.com/v1',
    api_key: TEST_KEY,
    models: ['ModelA', 'ModelB'],
  };

  test('uses models[0] when no override', () => {
    const env = buildSessionEnv(basePreset);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('ModelA');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('ModelA');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('ModelA');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('ModelA');
  });

  test('uses override when provided', () => {
    const env = buildSessionEnv(basePreset, 'ModelB');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('ModelB');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('ModelB');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('ModelB');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('ModelB');
  });

  test('sets provider credentials', () => {
    const env = buildSessionEnv(basePreset, 'ModelB');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/v1');
    expect(env.ANTHROPIC_API_KEY).toBe(TEST_KEY);
  });

  test('override is case-sensitive', () => {
    const env = buildSessionEnv(basePreset, 'modelb');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('modelb');
  });

  test('inherits allowlisted env vars', () => {
    // PATH should always be inherited if present
    const env = buildSessionEnv(basePreset);
    if (process.env.PATH) {
      expect(env.PATH).toBe(process.env.PATH);
    }
  });
});
