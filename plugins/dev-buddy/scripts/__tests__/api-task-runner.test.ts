import { describe, test, expect } from 'bun:test';
import {
  buildSessionEnv,
  collectSessionResult,
  parseArgs,
  ENV_ALLOWLIST,
  DEFAULT_TASK_TIMEOUT_MS,
} from '../api-task-runner.ts';
import type { ApiPreset } from '../../types/presets.ts';

// ================== buildSessionEnv ==================

/** Test-only fake preset — not a real credential. */
const FAKE_KEY = 'FAKE-TEST-KEY-NOT-REAL';

const mockPreset: ApiPreset = {
  type: 'api',
  name: 'test-api',
  base_url: 'https://api.example.com/anthropic',
  api_key: FAKE_KEY,
  models: ['MiniMax-M2.5', 'ModelB'],
};

describe('buildSessionEnv', () => {
  test('sets all 6 ANTHROPIC env vars from preset', () => {
    const env = buildSessionEnv(mockPreset);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/anthropic');
    expect(env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.5');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.5');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.5');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('MiniMax-M2.5');
  });

  test('preserves model name case sensitivity', () => {
    const env = buildSessionEnv(mockPreset);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.5');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).not.toBe('minimax-m2.5');
  });

  test('uses models[0] when no override', () => {
    const env = buildSessionEnv(mockPreset);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.5');
  });

  test('uses override when provided', () => {
    const env = buildSessionEnv(mockPreset, 'ModelB');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('ModelB');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('ModelB');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('ModelB');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('ModelB');
  });

  test('sets provider credentials', () => {
    const env = buildSessionEnv(mockPreset, 'ModelB');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/anthropic');
    expect(env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
  });

  test('override is case-sensitive', () => {
    const env = buildSessionEnv(mockPreset, 'modelb');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('modelb');
  });

  test('inherits PATH from host env', () => {
    const env = buildSessionEnv(mockPreset);
    if (process.env.PATH) {
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  test('inherits Windows vars when present', () => {
    const originalUserProfile = process.env.USERPROFILE;
    const originalAppData = process.env.APPDATA;
    process.env.USERPROFILE = 'C:\\Users\\test';
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    try {
      const env = buildSessionEnv(mockPreset);
      expect(env.USERPROFILE).toBe('C:\\Users\\test');
      expect(env.APPDATA).toBe('C:\\Users\\test\\AppData\\Roaming');
    } finally {
      if (originalUserProfile) process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      if (originalAppData) process.env.APPDATA = originalAppData;
      else delete process.env.APPDATA;
    }
  });

  test('inherits proxy vars when present', () => {
    const originalProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    try {
      const env = buildSessionEnv(mockPreset);
      expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
    } finally {
      if (originalProxy) process.env.HTTPS_PROXY = originalProxy;
      else delete process.env.HTTPS_PROXY;
    }
  });

  test('inherits TLS cert vars when present', () => {
    const original = process.env.NODE_EXTRA_CA_CERTS;
    process.env.NODE_EXTRA_CA_CERTS = '/path/to/certs.pem';
    try {
      const env = buildSessionEnv(mockPreset);
      expect(env.NODE_EXTRA_CA_CERTS).toBe('/path/to/certs.pem');
    } finally {
      if (original) process.env.NODE_EXTRA_CA_CERTS = original;
      else delete process.env.NODE_EXTRA_CA_CERTS;
    }
  });

  test('does not leak non-allowlisted env vars', () => {
    const original = process.env.SECRET_TOKEN;
    process.env.SECRET_TOKEN = 'super-secret';
    try {
      const env = buildSessionEnv(mockPreset);
      expect(env.SECRET_TOKEN).toBeUndefined();
    } finally {
      if (original) process.env.SECRET_TOKEN = original;
      else delete process.env.SECRET_TOKEN;
    }
  });

  test('omits allowlisted vars that are not set on host', () => {
    const original = process.env.SSL_CERT_FILE;
    delete process.env.SSL_CERT_FILE;
    try {
      const env = buildSessionEnv(mockPreset);
      expect(env.SSL_CERT_FILE).toBeUndefined();
    } finally {
      if (original) process.env.SSL_CERT_FILE = original;
    }
  });
});

// ================== collectSessionResult ==================

describe('collectSessionResult', () => {
  /** Create a mock session with a controllable async generator. */
  function mockSession(messages: Array<Record<string, unknown>>) {
    let closed = false;
    return {
      stream: async function* () {
        for (const msg of messages) {
          if (closed) return;
          yield msg;
        }
      },
      close: () => { closed = true; },
      _isClosed: () => closed,
    };
  }

  /** Create a mock session that never yields (simulates stalled stream). */
  function stalledSession() {
    let closed = false;
    return {
      stream: async function* () {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (closed) { clearInterval(check); resolve(); }
          }, 10);
        });
      },
      close: () => { closed = true; },
      _isClosed: () => closed,
    };
  }

  test('returns result on success', async () => {
    const session = mockSession([
      { type: 'assistant', message: 'thinking...' },
      { type: 'result', subtype: 'success', result: 'Hello world' },
    ]);
    const result = await collectSessionResult(session);
    expect(result.result).toBe('Hello world');
    expect(result.error).toBeNull();
    expect(result.timedOut).toBeUndefined();
  });

  test('returns error on failure', async () => {
    const session = mockSession([
      { type: 'result', subtype: 'error', errors: ['bad request'] },
    ]);
    const result = await collectSessionResult(session);
    expect(result.result).toBeNull();
    expect(result.error).toBe('error: bad request');
  });

  test('returns error when stream ends without result', async () => {
    const session = mockSession([
      { type: 'assistant', message: 'thinking...' },
    ]);
    const result = await collectSessionResult(session);
    expect(result.result).toBeNull();
    expect(result.error).toBe('stream ended without result message');
  });

  test('wall-clock timeout fires on stalled stream', async () => {
    const session = stalledSession();
    const result = await collectSessionResult(session, 100); // 100ms timeout
    expect(result.result).toBeNull();
    expect(result.error).toContain('timed out');
    expect(result.timedOut).toBe(true);
    expect(session._isClosed()).toBe(true); // session.close() called
  });

  test('timeout does not fire on fast success', async () => {
    const session = mockSession([
      { type: 'result', subtype: 'success', result: 'fast' },
    ]);
    const result = await collectSessionResult(session, 5000);
    expect(result.result).toBe('fast');
    expect(result.timedOut).toBeUndefined();
    expect(session._isClosed()).toBe(false); // session NOT closed
  });
});

// ================== parseArgs ==================

describe('parseArgs', () => {
  const base = ['bun', 'api-task-runner.ts'];

  test('parses all required arguments', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'my-preset',
      '--model', 'M2.5',
      '--cwd', '/project',
      '--task', 'do something',
    ]);
    expect(result).toEqual({
      preset: 'my-preset',
      model: 'M2.5',
      task: 'do something',
      cwd: '/project',
      taskTimeoutMs: 300_000,
      taskFromStdin: false,
    });
  });

  test('accepts --task-stdin flag as alternative to --task', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'my-preset',
      '--model', 'M2.5',
      '--cwd', '/project',
      '--task-stdin',
    ]);
    expect(result.taskFromStdin).toBe(true);
    expect(result.task).toBeUndefined();
  });

  test('rejects when neither --task nor --task-stdin provided', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
    ])).toThrow('--task or --task-stdin');
  });

  test('parses --task-timeout flag', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--task-timeout', '60000',
    ]);
    expect(result.taskTimeoutMs).toBe(60000);
  });

  test('defaults taskTimeoutMs to DEFAULT_TASK_TIMEOUT_MS', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'model',
      '--cwd', '/d',
      '--task', 't',
    ]);
    expect(result.taskTimeoutMs).toBe(DEFAULT_TASK_TIMEOUT_MS);
  });

  test('rejects missing required arguments', () => {
    expect(() => parseArgs([...base, '--preset', 'p']))
      .toThrow('Missing required arguments');
  });

  test('rejects invalid model name (shell metacharacters)', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'model; rm -rf /',
      '--cwd', '/d',
      '--task', 't',
    ])).toThrow('Invalid model name');
  });

  test('accepts model with dots, hyphens, underscores', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'MiniMax-M2.5_beta',
      '--cwd', '/d',
      '--task', 't',
    ]);
    expect(result.model).toBe('MiniMax-M2.5_beta');
  });

  test('rejects zero --task-timeout', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--task-timeout', '0',
    ])).toThrow('--task-timeout must be a positive integer');
  });

  test('rejects negative --task-timeout', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--task-timeout', '-100',
    ])).toThrow('--task-timeout must be a positive integer');
  });

  test('rejects non-numeric --task-timeout', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--task-timeout', 'abc',
    ])).toThrow('--task-timeout must be a positive integer');
  });
});

// ================== ENV_ALLOWLIST ==================

describe('ENV_ALLOWLIST', () => {
  test('includes cross-platform essentials', () => {
    expect(ENV_ALLOWLIST).toContain('PATH');
    expect(ENV_ALLOWLIST).toContain('HOME');
  });

  test('includes Windows vars', () => {
    expect(ENV_ALLOWLIST).toContain('USERPROFILE');
    expect(ENV_ALLOWLIST).toContain('APPDATA');
    expect(ENV_ALLOWLIST).toContain('SystemRoot');
  });

  test('includes proxy vars', () => {
    expect(ENV_ALLOWLIST).toContain('HTTPS_PROXY');
    expect(ENV_ALLOWLIST).toContain('NO_PROXY');
  });

  test('includes TLS cert vars', () => {
    expect(ENV_ALLOWLIST).toContain('NODE_EXTRA_CA_CERTS');
    expect(ENV_ALLOWLIST).toContain('SSL_CERT_FILE');
  });

  test('does not include dangerous vars', () => {
    expect(ENV_ALLOWLIST).not.toContain('DATABASE_URL');
  });
});

// ================== DEFAULT_TASK_TIMEOUT_MS ==================

describe('DEFAULT_TASK_TIMEOUT_MS', () => {
  test('is 5 minutes (300,000ms)', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(300_000);
  });
});
