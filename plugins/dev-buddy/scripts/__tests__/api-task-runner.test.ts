import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildBaseEnv,
  buildSessionEnv,
  collectSessionResult,
  parseArgs,
  ENV_ALLOWLIST,
  DEFAULT_TASK_TIMEOUT_MS,
  ANTHROPIC_TOOL_NAMES,
  OPENAI_TOOLS,
  OPENAI_MAX_ITERATIONS,
  createRunner,
  executeToolCall,
  AnthropicRunner,
  OpenAIRunner,
} from '../api-task-runner.ts';
import type { AgentRunner, AgentRunOptions } from '../api-task-runner.ts';
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

const mockOpenAIPreset: ApiPreset = {
  type: 'api',
  name: 'test-openai',
  base_url: 'https://api.openai.com',
  api_key: FAKE_KEY,
  models: ['gpt-4o', 'o3'],
  protocol: 'openai',
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

// ================== buildBaseEnv ==================

describe('buildBaseEnv', () => {
  test('returns object with PATH from host if set', () => {
    if (process.env.PATH) {
      const env = buildBaseEnv();
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  test('does not set ANTHROPIC_* vars', () => {
    const env = buildBaseEnv();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  test('does not set CODEX_API_KEY or OPENAI_BASE_URL', () => {
    const env = buildBaseEnv();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  test('does not set CLAUDE_CODE_SUBAGENT_MODEL', () => {
    const env = buildBaseEnv();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  test('does not leak non-allowlisted env vars', () => {
    const original = process.env.MY_SECRET_TOKEN;
    process.env.MY_SECRET_TOKEN = 'super-secret';
    try {
      const env = buildBaseEnv();
      expect(env.MY_SECRET_TOKEN).toBeUndefined();
    } finally {
      if (original) process.env.MY_SECRET_TOKEN = original;
      else delete process.env.MY_SECRET_TOKEN;
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

  test('parses --system-prompt flag', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--system-prompt', '/path/to/docs/review-guidelines.md',
    ]);
    expect(result.systemPrompt).toBe('/path/to/docs/review-guidelines.md');
  });

  test('omitting --system-prompt leaves it undefined', () => {
    const result = parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
    ]);
    expect(result.systemPrompt).toBeUndefined();
  });

  test('rejects --system-prompt without value', () => {
    expect(() => parseArgs([
      ...base,
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--system-prompt',
    ])).toThrow('--system-prompt requires a value');
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

// ================== ANTHROPIC_TOOL_NAMES ==================

describe('ANTHROPIC_TOOL_NAMES', () => {
  test('contains exactly 6 PascalCase tool names', () => {
    expect(ANTHROPIC_TOOL_NAMES).toEqual(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']);
  });

  test('has same count as OPENAI_TOOLS', () => {
    expect(ANTHROPIC_TOOL_NAMES.length).toBe(OPENAI_TOOLS.length);
  });
});

// ================== OPENAI_TOOLS ==================

describe('OPENAI_TOOLS', () => {
  test('contains 6 function definitions', () => {
    expect(OPENAI_TOOLS.length).toBe(6);
  });

  test('all entries have type: function', () => {
    for (const tool of OPENAI_TOOLS) {
      expect(tool.type).toBe('function');
    }
  });

  test('tool names are snake_case', () => {
    const names = OPENAI_TOOLS.map(t => t.function.name);
    expect(names).toEqual(['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep']);
  });

  test('each tool has a description and parameters', () => {
    for (const tool of OPENAI_TOOLS) {
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters).toBeTruthy();
      expect(tool.function.parameters.type).toBe('object');
    }
  });

  test('read_file requires file_path', () => {
    const tool = OPENAI_TOOLS.find(t => t.function.name === 'read_file')!;
    expect(tool.function.parameters.required).toEqual(['file_path']);
  });

  test('write_file requires file_path and content', () => {
    const tool = OPENAI_TOOLS.find(t => t.function.name === 'write_file')!;
    expect(tool.function.parameters.required).toEqual(['file_path', 'content']);
  });

  test('edit_file requires file_path, old_string, new_string', () => {
    const tool = OPENAI_TOOLS.find(t => t.function.name === 'edit_file')!;
    expect(tool.function.parameters.required).toEqual(['file_path', 'old_string', 'new_string']);
  });

  test('bash requires command, timeout_ms is optional', () => {
    const tool = OPENAI_TOOLS.find(t => t.function.name === 'bash')!;
    expect(tool.function.parameters.required).toEqual(['command']);
  });

  test('glob requires pattern, path is optional', () => {
    const tool = OPENAI_TOOLS.find(t => t.function.name === 'glob')!;
    expect(tool.function.parameters.required).toEqual(['pattern']);
  });

  test('grep requires pattern, path and glob_filter are optional', () => {
    const tool = OPENAI_TOOLS.find(t => t.function.name === 'grep')!;
    expect(tool.function.parameters.required).toEqual(['pattern']);
  });
});

// ================== OPENAI_MAX_ITERATIONS ==================

describe('OPENAI_MAX_ITERATIONS', () => {
  test('is 100', () => {
    expect(OPENAI_MAX_ITERATIONS).toBe(100);
  });
});

// ================== executeToolCall ==================

describe('executeToolCall', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tool-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- read_file ---

  test('read_file returns file contents', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world');
    const result = await executeToolCall('read_file', { file_path: filePath });
    expect(result).toBe('hello world');
  });

  test('read_file returns error for missing file', async () => {
    const result = await executeToolCall('read_file', { file_path: path.join(tmpDir, 'nope.txt') });
    expect(result).toContain('Error:');
    expect(result).toContain('ENOENT');
  });

  test('read_file returns error when file_path missing', async () => {
    const result = await executeToolCall('read_file', {});
    expect(result).toBe('Error: file_path is required');
  });

  // --- write_file ---

  test('write_file creates file and parent directories', async () => {
    const filePath = path.join(tmpDir, 'sub', 'dir', 'new.txt');
    const result = await executeToolCall('write_file', { file_path: filePath, content: 'created' });
    expect(result).toBe('OK');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('created');
  });

  test('write_file overwrites existing file', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'old');
    await executeToolCall('write_file', { file_path: filePath, content: 'new' });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new');
  });

  test('write_file returns error when file_path missing', async () => {
    const result = await executeToolCall('write_file', { content: 'data' });
    expect(result).toBe('Error: file_path is required');
  });

  test('write_file returns error when content missing', async () => {
    const result = await executeToolCall('write_file', { file_path: path.join(tmpDir, 'x.txt') });
    expect(result).toBe('Error: content is required');
  });

  // --- edit_file ---

  test('edit_file replaces old_string with new_string', async () => {
    const filePath = path.join(tmpDir, 'edit-me.txt');
    fs.writeFileSync(filePath, 'Hello World');
    const result = await executeToolCall('edit_file', {
      file_path: filePath,
      old_string: 'World',
      new_string: 'Bun',
    });
    expect(result).toBe('OK');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('Hello Bun');
  });

  test('edit_file errors when old_string not found', async () => {
    const filePath = path.join(tmpDir, 'edit-me.txt');
    fs.writeFileSync(filePath, 'Hello World');
    const result = await executeToolCall('edit_file', {
      file_path: filePath,
      old_string: 'NotHere',
      new_string: 'X',
    });
    expect(result).toContain('Error: old_string not found');
  });

  test('edit_file errors when old_string appears multiple times', async () => {
    const filePath = path.join(tmpDir, 'edit-me.txt');
    fs.writeFileSync(filePath, 'aaa bbb aaa');
    const result = await executeToolCall('edit_file', {
      file_path: filePath,
      old_string: 'aaa',
      new_string: 'X',
    });
    expect(result).toContain('found 2 times');
    // File should not be modified
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('aaa bbb aaa');
  });

  test('edit_file errors when file_path missing', async () => {
    const result = await executeToolCall('edit_file', { old_string: 'a', new_string: 'b' });
    expect(result).toBe('Error: file_path is required');
  });

  // --- bash ---

  test('bash executes command and returns output', async () => {
    const result = await executeToolCall('bash', { command: 'echo hello' });
    expect(result.trim()).toBe('hello');
  });

  test('bash returns stderr combined with stdout', async () => {
    const result = await executeToolCall('bash', { command: 'echo out && echo err >&2' });
    expect(result).toContain('out');
    expect(result).toContain('err');
  });

  test('bash returns exit code when no output', async () => {
    const result = await executeToolCall('bash', { command: 'true' });
    expect(result).toContain('exit code: 0');
  });

  test('bash errors when command missing', async () => {
    const result = await executeToolCall('bash', {});
    expect(result).toBe('Error: command is required');
  });

  // --- glob ---

  test('glob finds matching files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'c.js'), '');
    const result = await executeToolCall('glob', { pattern: '*.ts', path: tmpDir });
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
    expect(result).not.toContain('c.js');
  });

  test('glob returns no matches message', async () => {
    const result = await executeToolCall('glob', { pattern: '*.xyz', path: tmpDir });
    expect(result).toBe('(no matches)');
  });

  test('glob errors when pattern missing', async () => {
    const result = await executeToolCall('glob', {});
    expect(result).toBe('Error: pattern is required');
  });

  // --- grep ---

  test('grep finds matching lines', async () => {
    fs.writeFileSync(path.join(tmpDir, 'searchme.txt'), 'line one\nfind me\nline three\n');
    const result = await executeToolCall('grep', { pattern: 'find me', path: tmpDir });
    expect(result).toContain('find me');
  });

  test('grep returns no matches message', async () => {
    fs.writeFileSync(path.join(tmpDir, 'searchme.txt'), 'nothing here\n');
    const result = await executeToolCall('grep', { pattern: 'ZZZZZ', path: tmpDir });
    expect(result).toBe('(no matches)');
  });

  test('grep errors when pattern missing', async () => {
    const result = await executeToolCall('grep', {});
    expect(result).toBe('Error: pattern is required');
  });

  test('grep supports glob_filter', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'target line\n');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'target line\n');
    const result = await executeToolCall('grep', { pattern: 'target', path: tmpDir, glob_filter: '*.ts' });
    expect(result).toContain('a.ts');
    expect(result).not.toContain('b.js');
  });

  test('grep returns error for invalid regex', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'some content\n');
    const result = await executeToolCall('grep', { pattern: '[', path: tmpDir });
    expect(result).toContain('Error:');
  });

  // --- bash timeout ---

  test('bash returns timeout error when command exceeds timeout', async () => {
    const result = await executeToolCall('bash', { command: 'sleep 30', timeout_ms: 1000 });
    expect(result).toContain('Error: command timed out');
  }, 15000); // Extended test timeout — kill + drain takes a few seconds in Bun

  // --- unknown tool ---

  test('unknown tool returns error', async () => {
    const result = await executeToolCall('unknown_tool', {});
    expect(result).toBe('Error: Unknown tool "unknown_tool"');
  });
});

// ================== createRunner ==================

describe('createRunner', () => {
  test('returns OpenAIRunner for protocol: openai', () => {
    const runner = createRunner(mockOpenAIPreset);
    expect(runner).toBeInstanceOf(OpenAIRunner);
  });

  test('returns AnthropicRunner for protocol: anthropic', () => {
    const preset: ApiPreset = { ...mockPreset, protocol: 'anthropic' };
    const runner = createRunner(preset);
    expect(runner).toBeInstanceOf(AnthropicRunner);
  });

  test('returns AnthropicRunner when protocol is undefined (default)', () => {
    const runner = createRunner(mockPreset);
    expect(runner).toBeInstanceOf(AnthropicRunner);
  });

  test('both runners implement AgentRunner interface', () => {
    const anthropic = createRunner(mockPreset);
    const openai = createRunner(mockOpenAIPreset);
    // TypeScript compile-time check: both have run() method
    expect(typeof anthropic.run).toBe('function');
    expect(typeof openai.run).toBe('function');
  });
});

// ================== OpenAIRunner ==================

describe('OpenAIRunner', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Helper to create a mock fetch that returns canned responses. */
  function mockFetch(responses: Array<{
    content?: string | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    finish_reason: string;
  }>) {
    let callIndex = 0;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: resp.content ?? null,
              tool_calls: resp.tool_calls ?? undefined,
            },
            finish_reason: resp.finish_reason,
          }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;
    return () => callIndex; // Returns call count accessor
  }

  const baseOptions: AgentRunOptions = {
    model: 'gpt-4o',
    timeoutMs: 30_000,
    cwd: '/tmp',
    debugEnabled: false,
    presetName: 'test-openai',
  };

  test('single-turn completion (finish_reason: stop)', async () => {
    mockFetch([{ content: 'Done!', finish_reason: 'stop' }]);
    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('Say hello', baseOptions);
    expect(result.result).toBe('Done!');
    expect(result.error).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test('single-turn completion (finish_reason: end_turn)', async () => {
    mockFetch([{ content: 'Ended', finish_reason: 'end_turn' }]);
    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('Hello', baseOptions);
    expect(result.result).toBe('Ended');
    expect(result.error).toBeNull();
  });

  test('tool call then stop', async () => {
    mockFetch([
      {
        content: null,
        tool_calls: [{
          id: 'tc-1',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) },
        }],
        finish_reason: 'tool_calls',
      },
      { content: 'All done', finish_reason: 'stop' },
    ]);
    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('Run echo', baseOptions);
    expect(result.result).toBe('All done');
    expect(result.error).toBeNull();
  });

  test('multi-turn tool calls', async () => {
    mockFetch([
      {
        content: null,
        tool_calls: [{
          id: 'tc-1',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'echo step1' }) },
        }],
        finish_reason: 'tool_calls',
      },
      {
        content: null,
        tool_calls: [{
          id: 'tc-2',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'echo step2' }) },
        }],
        finish_reason: 'tool_calls',
      },
      { content: 'Both steps done', finish_reason: 'stop' },
    ]);
    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('Two steps', baseOptions);
    expect(result.result).toBe('Both steps done');
  });

  test('system prompt included when provided', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const runner = new OpenAIRunner(mockOpenAIPreset);
    await runner.run('test', { ...baseOptions, systemPromptContent: 'You are a reviewer.' });
    expect(capturedBody.messages[0].role).toBe('system');
    expect(capturedBody.messages[0].content).toBe('You are a reviewer.');
    expect(capturedBody.messages[1].role).toBe('user');
  });

  test('no system prompt when omitted', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const runner = new OpenAIRunner(mockOpenAIPreset);
    await runner.run('test', baseOptions);
    expect(capturedBody.messages[0].role).toBe('user');
  });

  test('API error returns error result', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })) as typeof fetch;

    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('test', baseOptions);
    expect(result.error).toContain('401');
    expect(result.error).toContain('Unauthorized');
    expect(result.result).toBeNull();
  });

  test('timeout returns timedOut result', async () => {
    // Return tool_calls repeatedly to keep the loop running until the deadline fires.
    // Each iteration adds ~10ms of overhead; with timeoutMs: 100 the deadline check
    // fires within a few iterations.
    mockFetch([{
      content: null,
      tool_calls: [{
        id: 'tc-delay',
        type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 0.05' }) },
      }],
      finish_reason: 'tool_calls',
    }]);

    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('test', { ...baseOptions, timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('timed out');
  });

  test('max iterations exceeded returns error', async () => {
    // Always return tool_calls to exhaust iterations
    mockFetch([{
      content: null,
      tool_calls: [{
        id: 'tc-loop',
        type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'echo loop' }) },
      }],
      finish_reason: 'tool_calls',
    }]);

    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('infinite loop', { ...baseOptions, timeoutMs: 300_000 });
    expect(result.error).toContain(`exceeded ${OPENAI_MAX_ITERATIONS} iterations`);
  });

  test('reasoning_effort included when set on preset', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const presetWithReasoning: ApiPreset = {
      ...mockOpenAIPreset,
      reasoning_effort: 'medium',
    };
    const runner = new OpenAIRunner(presetWithReasoning);
    await runner.run('test', baseOptions);
    expect(capturedBody.reasoning_effort).toBe('medium');
  });

  test('reasoning_effort omitted when not set', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const runner = new OpenAIRunner(mockOpenAIPreset);
    await runner.run('test', baseOptions);
    expect(capturedBody.reasoning_effort).toBeUndefined();
  });

  test('base URL normalization avoids double /v1', async () => {
    let capturedUrl: string = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = url as string;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const presetWithV1: ApiPreset = {
      ...mockOpenAIPreset,
      base_url: 'https://api.example.com/v1',
    };
    const runner = new OpenAIRunner(presetWithV1);
    await runner.run('test', baseOptions);
    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(capturedUrl).not.toContain('/v1/v1/');
  });

  test('base URL without /v1 suffix also works', async () => {
    let capturedUrl: string = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = url as string;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const runner = new OpenAIRunner(mockOpenAIPreset);
    await runner.run('test', baseOptions);
    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
  });

  test('no choices in response returns error', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ choices: [] }),
      text: async () => '',
    })) as typeof fetch;

    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('test', baseOptions);
    expect(result.error).toContain('no choices');
  });

  test('null content on stop returns fallback message', async () => {
    mockFetch([{ content: null, finish_reason: 'stop' }]);
    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('test', baseOptions);
    expect(result.result).toBe('Task completed (no text response)');
  });

  test('tool execution error returned as tool result string', async () => {
    // read_file on nonexistent file → error string → model gets it and stops
    mockFetch([
      {
        content: null,
        tool_calls: [{
          id: 'tc-err',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ file_path: '/nonexistent/file.txt' }) },
        }],
        finish_reason: 'tool_calls',
      },
      { content: 'File not found, I see', finish_reason: 'stop' },
    ]);
    const runner = new OpenAIRunner(mockOpenAIPreset);
    const result = await runner.run('read missing file', baseOptions);
    expect(result.result).toBe('File not found, I see');
  });

  test('Authorization header uses preset api_key', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries((init?.headers as any) ? Object.entries(init!.headers as Record<string, string>) : []);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const runner = new OpenAIRunner(mockOpenAIPreset);
    await runner.run('test', baseOptions);
    expect(capturedHeaders['Authorization']).toBe(`Bearer ${FAKE_KEY}`);
  });

  test('max_output_tokens override: preset value sent as max_tokens', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const presetWithMaxTokens: ApiPreset = {
      ...mockOpenAIPreset,
      max_output_tokens: 4096,
    };
    const runner = new OpenAIRunner(presetWithMaxTokens);
    await runner.run('test', baseOptions);
    expect(capturedBody.max_tokens).toBe(4096);
  });

  test('max_output_tokens fallback: uses 16384 when not set on preset', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const runner = new OpenAIRunner(mockOpenAIPreset);
    await runner.run('test', baseOptions);
    expect(capturedBody.max_tokens).toBe(16384);
  });

  test('max_output_tokens defensive: non-numeric value falls back to 16384', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        }),
        text: async () => '',
      };
    }) as typeof fetch;

    const presetWithInvalidTokens: ApiPreset = {
      ...mockOpenAIPreset,
      max_output_tokens: 'invalid' as unknown as number,
    };
    const runner = new OpenAIRunner(presetWithInvalidTokens);
    await runner.run('test', baseOptions);
    expect(capturedBody.max_tokens).toBe(16384);
  });
});
