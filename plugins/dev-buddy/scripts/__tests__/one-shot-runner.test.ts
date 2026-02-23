import { describe, test, expect } from 'bun:test';
import {
  parseArgs,
  tokenizeTemplate,
  substitutePlaceholders,
  findUnsupportedPlaceholders,
  escapeWinArg,
  readStartupLine,
  extractResultText,
  mapHttpStatusToError,
  validateTaskResponse,
  makeComplete,
  makeError,
  cleanupSessionManager,
  runApiPath,
  runCliPath,
  StartupTimeoutError,
} from '../one-shot-runner.ts';
import type { ApiPathDeps } from '../one-shot-runner.ts';
import type { Message } from '../../types/a2a-lite.ts';
import type { ApiPreset, CliPreset } from '../../types/presets.ts';

// ================== parseArgs ==================

describe('parseArgs', () => {
  const base = ['bun', 'one-shot-runner.ts'];

  test('parses all required arguments', () => {
    const result = parseArgs([
      ...base,
      '--type', 'api',
      '--preset', 'my-preset',
      '--model', 'M2.5',
      '--cwd', '/project',
      '--task', 'do something',
    ]);
    expect(result).toEqual({
      type: 'api',
      preset: 'my-preset',
      model: 'M2.5',
      cwd: '/project',
      task: 'do something',
    });
  });

  test('accepts cli type', () => {
    const result = parseArgs([
      ...base,
      '--type', 'cli',
      '--preset', 'codex',
      '--model', 'o3',
      '--cwd', '/dir',
      '--task', 'refactor auth',
    ]);
    expect(result.type).toBe('cli');
  });

  test('rejects invalid type', () => {
    expect(() => parseArgs([
      ...base,
      '--type', 'subscription',
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
    ])).toThrow('--type must be "api" or "cli"');
  });

  test('rejects missing required arguments', () => {
    expect(() => parseArgs([...base, '--type', 'api'])).toThrow('Missing required arguments');
  });

  test('rejects invalid model name (shell metacharacters)', () => {
    expect(() => parseArgs([
      ...base,
      '--type', 'api',
      '--preset', 'p',
      '--model', 'model; rm -rf /',
      '--cwd', '/d',
      '--task', 't',
    ])).toThrow('Invalid model name');
  });

  test('accepts model with dots, hyphens, underscores', () => {
    const result = parseArgs([
      ...base,
      '--type', 'api',
      '--preset', 'p',
      '--model', 'MiniMax-M2.5_beta',
      '--cwd', '/d',
      '--task', 't',
    ]);
    expect(result.model).toBe('MiniMax-M2.5_beta');
  });
});

// ================== tokenizeTemplate ==================

describe('tokenizeTemplate', () => {
  test('splits simple template', () => {
    expect(tokenizeTemplate('exec --full-auto --model {model} {prompt}'))
      .toEqual(['exec', '--full-auto', '--model', '{model}', '{prompt}']);
  });

  test('handles quoted strings', () => {
    expect(tokenizeTemplate('run "hello world" --flag'))
      .toEqual(['run', 'hello world', '--flag']);
  });

  test('handles single-quoted strings', () => {
    expect(tokenizeTemplate("run 'hello world' --flag"))
      .toEqual(['run', 'hello world', '--flag']);
  });

  test('returns null on unbalanced quotes', () => {
    expect(tokenizeTemplate('run "unbalanced')).toBeNull();
  });

  test('handles escaped quotes in double-quoted strings', () => {
    expect(tokenizeTemplate('run "say \\"hello\\""'))
      .toEqual(['run', 'say "hello"']);
  });
});

// ================== substitutePlaceholders ==================

describe('substitutePlaceholders', () => {
  test('replaces all placeholders', () => {
    const result = substitutePlaceholders('{model} {prompt}', {
      model: 'o3',
      prompt: 'hello world',
    });
    expect(result).toBe('o3 hello world');
  });

  test('replaces multiple occurrences', () => {
    const result = substitutePlaceholders('{model} then {model}', { model: 'o3' });
    expect(result).toBe('o3 then o3');
  });

  test('leaves unmatched placeholders intact', () => {
    const result = substitutePlaceholders('{model} {unknown}', { model: 'o3' });
    expect(result).toBe('o3 {unknown}');
  });
});

// ================== findUnsupportedPlaceholders ==================

describe('findUnsupportedPlaceholders', () => {
  test('finds output_file placeholder', () => {
    expect(findUnsupportedPlaceholders('--model {model} --output {output_file}'))
      .toEqual(['output_file']);
  });

  test('finds schema_path placeholder', () => {
    expect(findUnsupportedPlaceholders('--schema {schema_path}'))
      .toEqual(['schema_path']);
  });

  test('finds both unsupported placeholders', () => {
    const result = findUnsupportedPlaceholders('{output_file} {schema_path} {model}');
    expect(result).toContain('output_file');
    expect(result).toContain('schema_path');
  });

  test('returns empty for supported-only template', () => {
    expect(findUnsupportedPlaceholders('exec --model {model} {prompt}'))
      .toEqual([]);
  });
});

// ================== escapeWinArg ==================

describe('escapeWinArg', () => {
  test('returns unquoted for safe strings', () => {
    expect(escapeWinArg('hello')).toBe('hello');
    expect(escapeWinArg('model-name_v1.0')).toBe('model-name_v1.0');
  });

  test('quotes strings with spaces', () => {
    expect(escapeWinArg('hello world')).toBe('"hello world"');
  });

  test('escapes double quotes', () => {
    expect(escapeWinArg('say "hi"')).toBe('"say ""hi"""');
  });

  test('escapes ampersand', () => {
    expect(escapeWinArg('a & b')).toBe('"a & b"');
  });

  test('escapes pipe', () => {
    expect(escapeWinArg('a | b')).toBe('"a | b"');
  });

  test('escapes percent signs', () => {
    expect(escapeWinArg('100%')).toBe('"100%%"');
  });

  test('escapes exclamation marks', () => {
    expect(escapeWinArg('hello!')).toBe('"hello^!"');
  });

  test('handles combination of special chars', () => {
    const result = escapeWinArg('run & "exec" | 100%!');
    expect(result[0]).toBe('"');
    expect(result[result.length - 1]).toBe('"');
  });
});

// ================== extractResultText ==================

describe('extractResultText', () => {
  test('extracts text from single TextPart', () => {
    const msg: Message = {
      role: 'agent',
      parts: [{ type: 'text', text: 'Hello from the model' }],
    };
    expect(extractResultText(msg)).toBe('Hello from the model');
  });

  test('extracts and joins text from multiple TextParts', () => {
    const msg: Message = {
      role: 'agent',
      parts: [
        { type: 'text', text: 'Line 1' },
        { type: 'text', text: 'Line 2' },
      ],
    };
    expect(extractResultText(msg)).toBe('Line 1\nLine 2');
  });

  test('ignores non-text parts', () => {
    const msg: Message = {
      role: 'agent',
      parts: [
        { type: 'data', mimeType: 'application/json', data: '{}' },
        { type: 'text', text: 'Only this' },
      ],
    };
    expect(extractResultText(msg)).toBe('Only this');
  });

  test('returns empty string for null/undefined', () => {
    expect(extractResultText(null)).toBe('');
    expect(extractResultText(undefined)).toBe('');
  });

  test('returns empty string for message with no parts', () => {
    expect(extractResultText({ role: 'agent', parts: [] })).toBe('');
  });

  test('returns empty string for message with only non-text parts', () => {
    const msg: Message = {
      role: 'agent',
      parts: [{ type: 'data', mimeType: 'text/plain', data: 'ignored' }],
    };
    expect(extractResultText(msg)).toBe('');
  });
});

// ================== mapHttpStatusToError ==================

describe('mapHttpStatusToError', () => {
  test('maps 503 to exit code 2 with session not ready', () => {
    const result = mapHttpStatusToError(503, 'Service Unavailable');
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toContain('503');
    expect(result.output.error).toContain('Session not ready');
  });

  test('maps 408 to exit code 3 (timeout)', () => {
    const result = mapHttpStatusToError(408, 'Request Timeout');
    expect(result.exitCode).toBe(3);
    expect(result.output.error).toContain('408');
    expect(result.output.error).toContain('Queue timeout');
  });

  test('maps other errors to exit code 2 with status text', () => {
    const result = mapHttpStatusToError(500, 'Internal Server Error');
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toContain('500');
    expect(result.output.error).toContain('Internal Server Error');
  });

  test('maps 401 to exit code 2', () => {
    const result = mapHttpStatusToError(401, 'Unauthorized');
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toContain('401');
  });
});

// ================== validateTaskResponse ==================

describe('validateTaskResponse', () => {
  test('returns null for completed task', () => {
    const result = validateTaskResponse({
      task: {
        status: 'completed',
        result: { role: 'agent', parts: [{ type: 'text', text: 'done' }] },
      },
    });
    expect(result).toBeNull();
  });

  test('returns error for failed task', () => {
    const result = validateTaskResponse({
      task: {
        status: 'failed',
        error: { message: 'API error' },
      },
    });
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(2);
    expect(result!.output.error).toContain('failed');
    expect(result!.output.error).toContain('API error');
  });

  test('returns error for canceled task', () => {
    const result = validateTaskResponse({
      task: { status: 'canceled' },
    });
    expect(result).not.toBeNull();
    expect(result!.output.error).toContain('canceled');
  });

  test('returns error for missing task', () => {
    const result = validateTaskResponse({});
    expect(result).not.toBeNull();
    expect(result!.output.error).toContain('unknown');
  });

  test('returns error for working task (not yet completed)', () => {
    const result = validateTaskResponse({
      task: { status: 'working' },
    });
    expect(result).not.toBeNull();
    expect(result!.output.error).toContain('working');
  });
});

// ================== makeComplete / makeError ==================

describe('makeComplete / makeError', () => {
  test('makeComplete produces exit code 0', () => {
    const result = makeComplete('preset-a', 'model-1', 'Success text');
    expect(result.exitCode).toBe(0);
    expect(result.output.event).toBe('complete');
    expect(result.output.provider).toBe('preset-a');
    expect(result.output.model).toBe('model-1');
    expect(result.output.result).toBe('Success text');
  });

  test('makeError produces specified exit code', () => {
    const result = makeError('validation', 'Something wrong', 1);
    expect(result.exitCode).toBe(1);
    expect(result.output.event).toBe('error');
    expect(result.output.phase).toBe('validation');
    expect(result.output.error).toBe('Something wrong');
  });

  test('makeError defaults to exit code 2', () => {
    const result = makeError('api_execution', 'Failed');
    expect(result.exitCode).toBe(2);
  });
});

// ================== cleanupSessionManager ==================

describe('cleanupSessionManager', () => {
  test('does not throw when process already exited', async () => {
    const fakeProc = {
      exitCode: 0, // already exited
      kill: () => {},
    };
    // Should not throw
    await cleanupSessionManager(fakeProc);
  });

  test('calls kill when process has not exited and no port/token', async () => {
    let killed = false;
    const fakeProc = {
      exitCode: null as number | null,
      kill: () => { killed = true; fakeProc.exitCode = 0; },
    };
    await cleanupSessionManager(fakeProc);
    expect(killed).toBe(true);
  });

  test('sends SIGTERM only (not SIGKILL) when process exits after SIGTERM', async () => {
    let killCount = 0;
    const fakeProc = {
      exitCode: null as number | null,
      kill: () => { killCount++; fakeProc.exitCode = 0; },
    };
    await cleanupSessionManager(fakeProc);
    // After SIGTERM, exitCode becomes 0, so SIGKILL is not sent
    expect(killCount).toBe(1);
  });

  test('sends SIGKILL when process ignores SIGTERM', async () => {
    let signals: (number | string | undefined)[] = [];
    const fakeProc = {
      exitCode: null as number | null,
      kill: (sig?: number | string) => { signals.push(sig); /* exitCode stays null */ },
    };
    await cleanupSessionManager(fakeProc);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

// ================== StartupTimeoutError ==================

describe('StartupTimeoutError', () => {
  test('has correct name for instanceof check', () => {
    const err = new StartupTimeoutError('timed out');
    expect(err).toBeInstanceOf(StartupTimeoutError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StartupTimeoutError');
    expect(err.message).toBe('timed out');
  });
});

// ================== runApiPath (integration with injected deps) ==================

// Use a clearly-fake key that won't trigger secret detection
const TEST_KEY = process.env.TEST_DUMMY_KEY || 'test-placeholder-not-a-real-key';

/** Helper: create a ReadableStream that emits a single line. */
function streamFromLine(line: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
}

/** Helper: build mock deps for runApiPath. */
function mockApiDeps(opts: {
  startupLine?: string;
  fetchResponses?: Array<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>;
}): { deps: ApiPathDeps; calls: { fetchCalls: Array<{ url: string; init: RequestInit }>; killCalls: (number | string | undefined)[] } } {
  const calls = {
    fetchCalls: [] as Array<{ url: string; init: RequestInit }>,
    killCalls: [] as (number | string | undefined)[],
  };
  let fetchIdx = 0;

  const proc = {
    exitCode: null as number | null,
    stdout: streamFromLine(opts.startupLine || '{"status":"ready","port":9999,"token":"test-tok"}'),
    kill: (sig?: number | string) => { calls.killCalls.push(sig); proc.exitCode = 0; },
  };

  const deps: ApiPathDeps = {
    spawnSessionManager: () => ({ proc }),
    readStartup: readStartupLine,
    fetchFn: ((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      calls.fetchCalls.push({ url: urlStr, init: init || {} });

      // Shutdown call — always succeed
      if (urlStr.includes('/shutdown')) {
        return Promise.resolve(new Response('ok', { status: 200 }));
      }

      // Task send — use provided responses
      const resp = opts.fetchResponses?.[fetchIdx++];
      if (resp) {
        return Promise.resolve({
          ok: resp.ok,
          status: resp.status,
          statusText: resp.statusText,
          json: resp.json,
        } as Response);
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch,
    log: async () => {},
  };

  return { deps, calls };
}

const baseApiArgs = {
  type: 'api' as const,
  preset: 'test-preset',
  model: 'ModelA',
  cwd: '/project',
  task: 'do something',
};

const baseApiPreset: ApiPreset = {
  type: 'api',
  name: 'test-preset',
  base_url: 'https://api.example.com/v1',
  api_key: TEST_KEY,
  models: ['ModelA', 'ModelB'],
};

describe('runApiPath', () => {
  test('sends Authorization header with bearer token to /tasks/send', async () => {
    const { deps, calls } = mockApiDeps({
      fetchResponses: [{
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ task: { status: 'completed', result: { role: 'agent', parts: [{ type: 'text', text: 'done' }] } } }),
      }],
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);

    expect(result.exitCode).toBe(0);
    const taskSend = calls.fetchCalls.find(c => c.url.includes('/tasks/send'));
    expect(taskSend).toBeDefined();
    const headers = taskSend!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-tok');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('sends Authorization header to /shutdown during cleanup', async () => {
    const { deps, calls } = mockApiDeps({
      fetchResponses: [{
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ task: { status: 'completed', result: { role: 'agent', parts: [{ type: 'text', text: 'ok' }] } } }),
      }],
    });

    await runApiPath(baseApiArgs, baseApiPreset, false, deps);

    const shutdownCall = calls.fetchCalls.find(c => c.url.includes('/shutdown'));
    expect(shutdownCall).toBeDefined();
    const headers = shutdownCall!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-tok');
  });

  test('maps HTTP 503 to exit code 2', async () => {
    const { deps } = mockApiDeps({
      fetchResponses: [{
        ok: false, status: 503, statusText: 'Service Unavailable',
        json: async () => ({}),
      }],
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toContain('503');
  });

  test('maps failed task status to exit code 2', async () => {
    const { deps } = mockApiDeps({
      fetchResponses: [{
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ task: { status: 'failed', error: { message: 'Provider error' } } }),
      }],
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toContain('failed');
    expect(result.output.error).toContain('Provider error');
  });

  test('extracts result text from completed task Message', async () => {
    const { deps } = mockApiDeps({
      fetchResponses: [{
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          task: {
            status: 'completed',
            result: { role: 'agent', parts: [{ type: 'text', text: 'The answer is 42' }] },
          },
        }),
      }],
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(0);
    expect(result.output.result).toBe('The answer is 42');
  });

  test('runs cleanup even when task fetch throws', async () => {
    const { deps, calls } = mockApiDeps({});
    // Override fetchFn to throw on /tasks/send
    const origFetch = deps.fetchFn;
    deps.fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('/tasks/send')) return Promise.reject(new Error('network failure'));
      return origFetch(url, init);
    }) as typeof fetch;

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toContain('network failure');
    // Cleanup still ran — process was killed
    expect(calls.killCalls.length).toBeGreaterThan(0);
  });

  test('returns exit code 1 for model not in preset', async () => {
    const { deps } = mockApiDeps({});
    const badArgs = { ...baseApiArgs, model: 'NoSuchModel' };
    const result = await runApiPath(badArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(1);
    expect(result.output.error).toContain('NoSuchModel');
  });

  test('returns exit code 2 for invalid startup JSON', async () => {
    const { deps } = mockApiDeps({
      startupLine: 'not-json',
    });
    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(2);
  });

  test('returns exit code 2 for startup with missing port/token', async () => {
    const { deps } = mockApiDeps({
      startupLine: '{"status":"ready"}',
    });
    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toContain('Invalid startup output');
  });

  test('returns exit code 3 when startup times out', async () => {
    const { deps, calls } = mockApiDeps({});
    // Override readStartup to throw StartupTimeoutError immediately
    deps.readStartup = async () => { throw new StartupTimeoutError('Session manager startup timeout'); };

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(3);
    expect(result.output.error).toContain('startup timed out');
    // Cleanup still ran (no port/token, so kill is the only option)
    expect(calls.killCalls.length).toBeGreaterThan(0);
  });
});

// ================== runCliPath (runtime placeholder validation) ==================

const baseCliArgs = {
  type: 'cli' as const,
  preset: 'test-cli',
  model: 'test-model',
  cwd: '/project',
  task: 'do something',
};

function makeCliPreset(overrides: Partial<CliPreset> = {}): CliPreset {
  return {
    type: 'cli',
    name: 'Test CLI',
    command: 'echo',
    args_template: 'exec -m {model} -o {output_file} "{prompt}"',
    models: ['test-model'],
    one_shot_args_template: 'exec -m {model} "{prompt}"',
    ...overrides,
  };
}

describe('runCliPath runtime validation', () => {
  test('returns validation error for missing one_shot_args_template', async () => {
    const preset = makeCliPreset({ one_shot_args_template: undefined });
    const result = await runCliPath(baseCliArgs, preset, false);
    expect(result.exitCode).toBe(1);
    expect(result.output.error).toContain('one_shot_args_template');
    expect(result.output.phase).toBe('validation');
  });

  test('returns validation error for whitespace-only one_shot_args_template', async () => {
    const preset = makeCliPreset({ one_shot_args_template: '   \t  ' } as any);
    const result = await runCliPath(baseCliArgs, preset, false);
    expect(result.exitCode).toBe(1);
    expect(result.output.error).toContain('one_shot_args_template');
  });

  test('returns validation error for template missing {prompt}', async () => {
    const preset = makeCliPreset({ one_shot_args_template: 'exec -m {model}' });
    const result = await runCliPath(baseCliArgs, preset, false);
    expect(result.exitCode).toBe(1);
    expect(result.output.error).toContain('missing required');
    expect(result.output.error).toContain('prompt');
  });

  test('returns validation error for template missing {model}', async () => {
    const preset = makeCliPreset({ one_shot_args_template: 'exec "{prompt}"' });
    const result = await runCliPath(baseCliArgs, preset, false);
    expect(result.exitCode).toBe(1);
    expect(result.output.error).toContain('missing required');
    expect(result.output.error).toContain('model');
  });

  test('returns validation error for template with forbidden {output_file}', async () => {
    const preset = makeCliPreset({
      one_shot_args_template: 'exec -m {model} -o {output_file} "{prompt}"',
    });
    const result = await runCliPath(baseCliArgs, preset, false);
    expect(result.exitCode).toBe(1);
    expect(result.output.error).toContain('unknown placeholder');
  });

  test('returns validation error for model not in preset', async () => {
    const preset = makeCliPreset();
    const result = await runCliPath({ ...baseCliArgs, model: 'no-such-model' }, preset, false);
    expect(result.exitCode).toBe(1);
    expect(result.output.error).toContain('no-such-model');
  });
});
