import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  buildSessionEnv,
  collectSessionResult,
  ENV_ALLOWLIST,
  DEFAULT_TASK_TIMEOUT_MS,
  parseCLIArgs,
  generateToken,
  validateToken,
  createAuthError,
  TaskQueue,
  acquireWithTimeout,
  handleTaskSend,
  handleTaskStatus,
  handleTaskCancel,
  handleStatus,
  handleShutdown,
  canRespawn,
  transitionHealth,
  resetIdleTimer,
  type SessionRef,
} from './session-manager.ts';
import type { ApiPreset } from '../types/presets.ts';
import type { SessionState, SessionConfig } from '../types/session.ts';
import { validatePreset } from './preset-utils.ts';

// ============================================================
// --- buildSessionEnv ---
// ============================================================

/** Test-only fake preset — not a real credential. */
const FAKE_KEY = 'FAKE-TEST-KEY-NOT-REAL';

describe('buildSessionEnv', () => {
  const mockPreset: ApiPreset = {
    type: 'api',
    name: 'test-api',
    base_url: 'https://api.example.com/anthropic',
    api_key: FAKE_KEY,
    models: ['MiniMax-M2.5'],
  };

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
    // MiniMax-M2.5 must not be lowercased or normalized
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.5');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).not.toBe('minimax-m2.5');
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

// ============================================================
// --- collectSessionResult ---
// ============================================================

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

// ============================================================
// --- parseCLIArgs ---
// ============================================================

describe('parseCLIArgs', () => {
  test('parses --preset flag', () => {
    const config = parseCLIArgs(['bun', 'session-manager.ts', '--preset', 'minimax']);
    expect(config.preset_name).toBe('minimax');
  });

  test('throws on missing --preset', () => {
    expect(() => parseCLIArgs(['bun', 'session-manager.ts']))
      .toThrow('--preset is required');
  });

  test('parses --cwd flag', () => {
    const config = parseCLIArgs(['bun', 'script.ts', '--preset', 'p', '--cwd', '/tmp/test']);
    expect(config.cwd).toBe('/tmp/test');
  });

  test('parses --idle-timeout flag', () => {
    const config = parseCLIArgs(['bun', 'script.ts', '--preset', 'p', '--idle-timeout', '30']);
    expect(config.idle_timeout_minutes).toBe(30);
  });

  test('throws on invalid --idle-timeout', () => {
    expect(() => parseCLIArgs(['bun', 'script.ts', '--preset', 'p', '--idle-timeout', '-5']))
      .toThrow('--idle-timeout must be a positive integer');
  });

  test('parses --allowed-tools flag', () => {
    const config = parseCLIArgs(['bun', 'script.ts', '--preset', 'p', '--allowed-tools', 'Read,Write']);
    expect(config.allowed_tools).toBe('Read,Write');
  });

  test('parses --task-timeout flag', () => {
    const config = parseCLIArgs(['bun', 'script.ts', '--preset', 'p', '--task-timeout', '600000']);
    expect(config.task_timeout_ms).toBe(600000);
  });

  test('throws on invalid --task-timeout', () => {
    expect(() => parseCLIArgs(['bun', 'script.ts', '--preset', 'p', '--task-timeout', '0']))
      .toThrow('--task-timeout must be a positive integer');
  });

  test('throws on negative --task-timeout', () => {
    expect(() => parseCLIArgs(['bun', 'script.ts', '--preset', 'p', '--task-timeout', '-100']))
      .toThrow('--task-timeout must be a positive integer');
  });

  test('defaults idle_timeout_minutes to 60', () => {
    const config = parseCLIArgs(['bun', 'script.ts', '--preset', 'p']);
    expect(config.idle_timeout_minutes).toBe(60);
  });

  test('parses all flags together', () => {
    const config = parseCLIArgs([
      'bun', 'script.ts',
      '--preset', 'minimax',
      '--cwd', '/project',
      '--idle-timeout', '45',
      '--allowed-tools', 'Read,Grep',
      '--task-timeout', '120000',
    ]);
    expect(config.preset_name).toBe('minimax');
    expect(config.cwd).toBe('/project');
    expect(config.idle_timeout_minutes).toBe(45);
    expect(config.allowed_tools).toBe('Read,Grep');
    expect(config.task_timeout_ms).toBe(120000);
  });
});

// ============================================================
// --- Health Gating ---
// ============================================================

describe('handleTaskSend health gate', () => {
  function makeState(health: 'starting' | 'ready' | 'dead' | 'failed'): SessionState {
    return {
      health,
      uptime_ms: 0,
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      task_count: 0,
      respawn_timestamps: [],
    };
  }

  const config: SessionConfig = {
    preset_name: 'test',
    idle_timeout_minutes: 60,
  };

  function makeRequest(body: object): Request {
    return new Request('http://localhost/tasks/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('rejects with 503 when health is dead', async () => {
    const state = makeState('dead');
    const queue = new TaskQueue();
    const req = makeRequest({ message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });
    const res = await handleTaskSend(req, state, queue, config);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  test('rejects with 503 when health is failed', async () => {
    const state = makeState('failed');
    const queue = new TaskQueue();
    const req = makeRequest({ message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });
    const res = await handleTaskSend(req, state, queue, config);
    expect(res.status).toBe(503);
  });

  test('rejects with 503 when health is starting', async () => {
    const state = makeState('starting');
    const queue = new TaskQueue();
    const req = makeRequest({ message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });
    const res = await handleTaskSend(req, state, queue, config);
    expect(res.status).toBe(503);
  });

  test('rejects with 503 when health becomes dead while queued', async () => {
    const state = makeState('ready');
    const queue = new TaskQueue();
    // Acquire the queue so the next request must wait
    await queue.acquire();
    const req = makeRequest({ message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });
    // Start handleTaskSend — it will pass the first health check, then block on queue
    const responsePromise = handleTaskSend(req, state, queue, config);
    // Simulate session death while request is queued
    state.health = 'dead';
    // Release the queue — request proceeds but should fail the post-queue health re-check
    queue.release();
    const res = await responsePromise;
    expect(res.status).toBe(503);
    const body = await res.json() as { task: { error: { code: string } } };
    expect(body.task.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

// ============================================================
// --- Auth ---
// ============================================================

describe('auth', () => {
  test('generateToken returns 43-char base64url string', () => {
    const token = generateToken();
    expect(token.length).toBe(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('validateToken rejects missing Authorization header', () => {
    const req = new Request('http://localhost/test');
    expect(validateToken(req, 'token123')).toBe(false);
  });

  test('validateToken rejects wrong token', () => {
    const req = new Request('http://localhost/test', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(validateToken(req, 'correct-token')).toBe(false);
  });

  test('validateToken accepts correct token', () => {
    const token = generateToken();
    const req = new Request('http://localhost/test', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(validateToken(req, token)).toBe(true);
  });

  test('createAuthError returns 401', () => {
    const res = createAuthError();
    expect(res.status).toBe(401);
  });
});

// ============================================================
// --- ENV_ALLOWLIST ---
// ============================================================

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

// ============================================================
// --- validatePreset timeout_ms for API presets ---
// ============================================================

describe('validatePreset API timeout_ms', () => {
  const validApiPreset = {
    type: 'api',
    name: 'test-api',
    base_url: 'https://api.example.com',
    api_key: FAKE_KEY,
    models: ['test-model'],
  };

  test('accepts API preset without timeout_ms', () => {
    const result = validatePreset(validApiPreset);
    expect(result.type).toBe('api');
  });

  test('accepts API preset with valid timeout_ms', () => {
    const result = validatePreset({ ...validApiPreset, timeout_ms: 300000 });
    expect(result.type).toBe('api');
  });

  test('rejects API preset with zero timeout_ms', () => {
    expect(() => validatePreset({ ...validApiPreset, timeout_ms: 0 }))
      .toThrow('API preset timeout_ms must be a positive integer');
  });

  test('rejects API preset with negative timeout_ms', () => {
    expect(() => validatePreset({ ...validApiPreset, timeout_ms: -1 }))
      .toThrow('API preset timeout_ms must be a positive integer');
  });

  test('rejects API preset with non-integer timeout_ms', () => {
    expect(() => validatePreset({ ...validApiPreset, timeout_ms: 1.5 }))
      .toThrow('API preset timeout_ms must be a positive integer');
  });

  test('rejects API preset with string timeout_ms', () => {
    expect(() => validatePreset({ ...validApiPreset, timeout_ms: '300000' }))
      .toThrow('API preset timeout_ms must be a positive integer');
  });
});
