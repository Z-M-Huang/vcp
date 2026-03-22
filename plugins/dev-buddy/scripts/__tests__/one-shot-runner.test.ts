import { describe, test, expect, afterAll } from 'bun:test';
import {
  parseArgs,
  tokenizeTemplate,
  substitutePlaceholders,
  escapeWinArg,
  makeComplete,
  makeError,
  runApiPath,
  runCliPath,
} from '../one-shot-runner.ts';
import type { ApiPathDeps } from '../one-shot-runner.ts';
import type { ApiPreset, CliPreset } from '../../types/presets.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';

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
      taskFromStdin: false,
      outputId: null,
    });
  });

  test('accepts --task-stdin flag as alternative to --task', () => {
    const result = parseArgs([
      ...base,
      '--type', 'api',
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
      '--type', 'api',
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
    ])).toThrow('--task or --task-stdin');
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

// ================== runApiPath (integration with injected deps) ==================

// Use a clearly-fake key that won't trigger secret detection
const TEST_KEY = process.env.TEST_DUMMY_KEY || 'test-placeholder-not-a-real-key';

/** Helper: create a ReadableStream that emits a string. */
function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Helper: build mock deps for runApiPath that spawns api-task-runner. */
function mockApiDeps(opts: {
  stdout?: string;
  exitCode?: number;
  exitDelay?: number;
  shouldHang?: boolean;
}): { deps: ApiPathDeps; calls: { spawnCalls: Array<{ args: unknown; taskTimeoutMs: number }>; killCalls: (number | string | undefined)[] } } {
  const calls = {
    spawnCalls: [] as Array<{ args: unknown; taskTimeoutMs: number }>,
    killCalls: [] as (number | string | undefined)[],
  };

  const exitCode = opts.exitCode ?? 0;
  const stdoutText = opts.stdout ?? '{}';

  const deps: ApiPathDeps = {
    spawnTaskRunner(args, taskTimeoutMs) {
      calls.spawnCalls.push({ args, taskTimeoutMs });

      const proc = {
        exitCode: opts.shouldHang ? null : exitCode,
        stdout: streamFromText(stdoutText),
        kill: (sig?: number | string) => { calls.killCalls.push(sig); proc.exitCode = exitCode; },
      };

      const exited = opts.shouldHang
        ? new Promise<void>(() => {}) // never resolves
        : new Promise<void>((resolve) => setTimeout(resolve, opts.exitDelay ?? 0));

      return { proc, exited };
    },
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
  taskFromStdin: false,
  outputId: null as string | null,
};

const baseApiPreset: ApiPreset = {
  type: 'api',
  name: 'test-preset',
  base_url: 'https://api.example.com/v1',
  api_key: TEST_KEY,
  models: ['ModelA', 'ModelB'],
};

describe('runApiPath', () => {
  test('returns success for complete event', async () => {
    const { deps } = mockApiDeps({
      stdout: JSON.stringify({ event: 'complete', provider: 'test-preset', model: 'ModelA', result: 'Task done' }),
      exitCode: 0,
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(0);
    expect(result.output.event).toBe('complete');
    expect(result.output.result).toBe('Task done');
  });

  test('passes preset and model to spawnTaskRunner', async () => {
    const { deps, calls } = mockApiDeps({
      stdout: JSON.stringify({ event: 'complete', provider: 'test-preset', model: 'ModelA', result: 'ok' }),
    });

    await runApiPath(baseApiArgs, baseApiPreset, false, deps);

    expect(calls.spawnCalls.length).toBe(1);
    const spawnArgs = calls.spawnCalls[0].args as typeof baseApiArgs;
    expect(spawnArgs.preset).toBe('test-preset');
    expect(spawnArgs.model).toBe('ModelA');
  });

  test('uses preset.timeout_ms for task timeout', async () => {
    const presetWithTimeout = { ...baseApiPreset, timeout_ms: 600_000 };
    const { deps, calls } = mockApiDeps({
      stdout: JSON.stringify({ event: 'complete', provider: 'test-preset', model: 'ModelA', result: 'ok' }),
    });

    await runApiPath(baseApiArgs, presetWithTimeout, false, deps);

    expect(calls.spawnCalls[0].taskTimeoutMs).toBe(600_000);
  });

  test('defaults to 300s when preset has no timeout_ms', async () => {
    const { deps, calls } = mockApiDeps({
      stdout: JSON.stringify({ event: 'complete', provider: 'test-preset', model: 'ModelA', result: 'ok' }),
    });

    await runApiPath(baseApiArgs, baseApiPreset, false, deps);

    expect(calls.spawnCalls[0].taskTimeoutMs).toBe(300_000);
  });

  test('returns exit code 1 for model not in preset', async () => {
    const { deps } = mockApiDeps({});
    const badArgs = { ...baseApiArgs, model: 'NoSuchModel' };
    const result = await runApiPath(badArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(1);
    expect(result.output.error).toContain('NoSuchModel');
  });

  test('maps error event with exit code 2', async () => {
    const { deps } = mockApiDeps({
      stdout: JSON.stringify({ event: 'error', phase: 'execution', error: 'Provider error' }),
      exitCode: 2,
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toBe('Provider error');
    expect(result.output.phase).toBe('execution');
  });

  test('maps timeout exit code 3', async () => {
    const { deps } = mockApiDeps({
      stdout: JSON.stringify({ event: 'error', phase: 'execution', error: 'Task execution timed out' }),
      exitCode: 3,
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(3);
    expect(result.output.error).toContain('timed out');
  });

  test('maps validation exit code 1', async () => {
    const { deps } = mockApiDeps({
      stdout: JSON.stringify({ event: 'error', phase: 'validation', error: 'bad model' }),
      exitCode: 1,
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(1);
    expect(result.output.error).toBe('bad model');
  });

  test('returns error for empty stdout', async () => {
    const { deps } = mockApiDeps({
      stdout: '',
      exitCode: 2,
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toContain('no output');
  });

  test('returns error for invalid JSON stdout', async () => {
    const { deps } = mockApiDeps({
      stdout: 'not-json-at-all',
      exitCode: 2,
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(2);
    expect(result.output.error).toContain('invalid JSON');
  });

  test('reads last line of stdout (ignores debug output)', async () => {
    const { deps } = mockApiDeps({
      stdout: 'debug: starting up\ndebug: warmup done\n' +
        JSON.stringify({ event: 'complete', provider: 'test-preset', model: 'ModelA', result: 'The answer' }),
      exitCode: 0,
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(0);
    expect(result.output.result).toBe('The answer');
  });

  test('defaults provider/model from args when output omits them', async () => {
    const { deps } = mockApiDeps({
      stdout: JSON.stringify({ event: 'complete', result: 'Done' }),
      exitCode: 0,
    });

    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.output.provider).toBe('test-preset');
    expect(result.output.model).toBe('ModelA');
  });

  test('returns timeout error and sends SIGTERM + SIGKILL when process hangs', async () => {
    const presetWithShortTimeout = { ...baseApiPreset, timeout_ms: 50 };
    const { deps, calls } = mockApiDeps({ shouldHang: true });
    // Use short buffer and grace period for fast test execution
    deps.processTimeoutBufferMs = 0;
    deps.killGraceMs = 50;

    const result = await runApiPath(baseApiArgs, presetWithShortTimeout, false, deps);

    expect(result.exitCode).toBe(3);
    expect(result.output.error).toContain('timed out');
    // SIGTERM sent first, then SIGKILL after grace period
    expect(calls.killCalls.length).toBe(2);
    expect(calls.killCalls[0]).toBe('SIGTERM');
    expect(calls.killCalls[1]).toBe('SIGKILL');
  });
});

// ================== runApiPath stream mode (null stdout) ==================

/** Helper: build mock deps for stream mode (stdout: null). */
function mockStreamApiDeps(opts: {
  exitCode?: number;
  exitDelay?: number;
  shouldHang?: boolean;
}): { deps: ApiPathDeps; calls: { spawnCalls: Array<{ args: unknown; taskTimeoutMs: number }>; killCalls: (number | string | undefined)[] } } {
  const calls = {
    spawnCalls: [] as Array<{ args: unknown; taskTimeoutMs: number }>,
    killCalls: [] as (number | string | undefined)[],
  };

  const exitCode = opts.exitCode ?? 0;

  const deps: ApiPathDeps = {
    spawnTaskRunner(args, taskTimeoutMs) {
      calls.spawnCalls.push({ args, taskTimeoutMs });

      const proc = {
        exitCode: opts.shouldHang ? null : exitCode,
        stdout: null as ReadableStream<Uint8Array> | null, // stream mode
        kill: (sig?: number | string) => { calls.killCalls.push(sig); proc.exitCode = exitCode; },
      };

      const exited = opts.shouldHang
        ? new Promise<void>(() => {}) // never resolves
        : new Promise<void>((resolve) => setTimeout(resolve, opts.exitDelay ?? 0));

      return { proc, exited };
    },
    log: async () => {},
  };

  return { deps, calls };
}

describe('runApiPath stream mode', () => {
  test('returns success for exit code 0', async () => {
    const { deps } = mockStreamApiDeps({ exitCode: 0 });
    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(0);
    expect(result.output.event).toBe('complete');
    expect(result.output.provider).toBe('test-preset');
    expect(result.output.model).toBe('ModelA');
  });

  test('returns timeout error for exit code 3', async () => {
    const { deps } = mockStreamApiDeps({ exitCode: 3 });
    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(3);
    expect(result.output.event).toBe('error');
    expect(result.output.error).toContain('timed out');
  });

  test('returns execution error for exit code 2', async () => {
    const { deps } = mockStreamApiDeps({ exitCode: 2 });
    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(2);
    expect(result.output.event).toBe('error');
    expect(result.output.error).toContain('exited with code 2');
  });

  test('returns validation error for exit code 1', async () => {
    const { deps } = mockStreamApiDeps({ exitCode: 1 });
    const result = await runApiPath(baseApiArgs, baseApiPreset, false, deps);
    expect(result.exitCode).toBe(1);
    expect(result.output.event).toBe('error');
  });

  test('returns timeout error when process hangs in stream mode', async () => {
    const presetWithShortTimeout = { ...baseApiPreset, timeout_ms: 50 };
    const { deps, calls } = mockStreamApiDeps({ shouldHang: true });
    deps.processTimeoutBufferMs = 0;
    deps.killGraceMs = 50;

    const result = await runApiPath(baseApiArgs, presetWithShortTimeout, false, deps);
    expect(result.exitCode).toBe(3);
    expect(result.output.error).toContain('timed out');
    expect(calls.killCalls.length).toBe(2);
  });
});

// ================== runCliPath (runtime placeholder validation) ==================

const baseCliArgs = {
  type: 'cli' as const,
  preset: 'test-cli',
  model: 'test-model',
  cwd: '/project',
  task: 'do something',
  taskFromStdin: false,
  outputId: null as string | null,
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

// ================== parseArgs --output-id ==================

describe('parseArgs --output-id', () => {
  const base = ['bun', 'one-shot-runner.ts'];

  test('parses --output-id flag', () => {
    const result = parseArgs([
      ...base,
      '--type', 'api',
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--output-id', 'preset-model-12345-678',
    ]);
    expect(result.outputId).toBe('preset-model-12345-678');
  });

  test('defaults outputId to null when not provided', () => {
    const result = parseArgs([
      ...base,
      '--type', 'api',
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
    ]);
    expect(result.outputId).toBeNull();
  });

  test('rejects --output-id without value', () => {
    expect(() => parseArgs([
      ...base,
      '--type', 'api',
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--output-id',
    ])).toThrow('--output-id requires a value');
  });

  test('rejects --output-id with slashes', () => {
    expect(() => parseArgs([
      ...base,
      '--type', 'api',
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--output-id', 'foo/bar',
    ])).toThrow('--output-id must match');
  });

  test('rejects --output-id with special characters', () => {
    expect(() => parseArgs([
      ...base,
      '--type', 'api',
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--output-id', 'foo bar',
    ])).toThrow('--output-id must match');
  });

  test('rejects --output-id longer than 255 characters', () => {
    const longToken = 'a'.repeat(256);
    expect(() => parseArgs([
      ...base,
      '--type', 'api',
      '--preset', 'p',
      '--model', 'm',
      '--cwd', '/d',
      '--task', 't',
      '--output-id', longToken,
    ])).toThrow('255 characters or fewer');
  });
});

// ================== --output-id integration tests ==================
// These test the actual file writing behavior of the runner subprocess.
// They invoke one-shot-runner.ts as a subprocess since emitAndExit calls process.exit.

describe('--output-id integration', () => {
  const testToken = 'test-oneshot-' + process.pid;
  const outputDir = path.join(os.tmpdir(), '.vcp', 'oneshot');

  afterAll(() => {
    // Clean up test output files
    try { rmSync(path.join(outputDir, testToken + '-val.json')); } catch { /* best-effort */ }
    try { rmSync(path.join(outputDir, testToken + '-dup.json')); } catch { /* best-effort */ }
    try { rmSync(path.join(outputDir, testToken + '-mode.json')); } catch { /* best-effort */ }
    try { rmSync(path.join(outputDir, testToken + '-sym.json')); } catch { /* best-effort */ }
    try { rmSync(path.join(outputDir, testToken + '-sym-target.json')); } catch { /* best-effort */ }
  });

  test('writes result JSON to output file on validation error', async () => {
    const id = testToken + '-val';
    const expectedPath = path.join(outputDir, id + '.json');
    const scriptPath = path.resolve(__dirname, '../one-shot-runner.ts');

    const proc = Bun.spawn([
      'bun', scriptPath,
      '--type', 'api',
      '--preset', 'NONEXISTENT_PRESET_12345',
      '--model', 'fake',
      '--cwd', '/tmp',
      '--task', 'test',
      '--output-id', id,
    ], { stdout: 'pipe', stderr: 'pipe' });

    await proc.exited;

    expect(existsSync(expectedPath)).toBe(true);
    const content = JSON.parse(readFileSync(expectedPath, 'utf-8'));
    expect(content.event).toBe('error');
    expect(content.phase).toBe('validation');
  });

  test('overwrites output file on re-run (unlink + O_EXCL)', async () => {
    const id = testToken + '-dup';
    const expectedPath = path.join(outputDir, id + '.json');
    const scriptPath = path.resolve(__dirname, '../one-shot-runner.ts');

    // First run — creates the file
    const proc1 = Bun.spawn([
      'bun', scriptPath,
      '--type', 'api',
      '--preset', 'NONEXISTENT_PRESET_12345',
      '--model', 'fake',
      '--cwd', '/tmp',
      '--task', 'test',
      '--output-id', id,
    ], { stdout: 'pipe', stderr: 'pipe' });
    await proc1.exited;

    // Second run — same ID, should overwrite (not fail)
    const proc2 = Bun.spawn([
      'bun', scriptPath,
      '--type', 'api',
      '--preset', 'NONEXISTENT_PRESET_12345',
      '--model', 'fake',
      '--cwd', '/tmp',
      '--task', 'test',
      '--output-id', id,
    ], { stdout: 'pipe', stderr: 'pipe' });
    await proc2.exited;

    const stderrText = await new Response(proc2.stderr).text();
    expect(stderrText).not.toContain('Failed to write output file');
    // File should exist with content from second run
    const content = JSON.parse(readFileSync(expectedPath, 'utf-8'));
    expect(content.event).toBe('error'); // validation error from nonexistent preset
  });

  test('writes with mode 0o600', async () => {
    const id = testToken + '-mode';
    const expectedPath = path.join(outputDir, id + '.json');
    const scriptPath = path.resolve(__dirname, '../one-shot-runner.ts');

    const proc = Bun.spawn([
      'bun', scriptPath,
      '--type', 'api',
      '--preset', 'NONEXISTENT_PRESET_12345',
      '--model', 'fake',
      '--cwd', '/tmp',
      '--task', 'test',
      '--output-id', id,
    ], { stdout: 'pipe', stderr: 'pipe' });

    await proc.exited;

    expect(existsSync(expectedPath)).toBe(true);
    const stats = statSync(expectedPath);
    // 0o600 = owner read+write only (octal 100600 includes file type bits)
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test('does not write through symlinked final filename (unlink replaces symlink)', async () => {
    const id = testToken + '-sym';
    const symlinkPath = path.join(outputDir, id + '.json');
    const targetPath = path.join(outputDir, id + '-target.json');
    const scriptPath = path.resolve(__dirname, '../one-shot-runner.ts');

    // Ensure output directory exists and clean up any prior symlink
    mkdirSync(outputDir, { recursive: true });
    try { rmSync(symlinkPath); } catch { /* may not exist */ }

    // Create a dangling symlink at the expected output path
    symlinkSync(targetPath, symlinkPath);

    const proc = Bun.spawn([
      'bun', scriptPath,
      '--type', 'api',
      '--preset', 'NONEXISTENT_PRESET_12345',
      '--model', 'fake',
      '--cwd', '/tmp',
      '--task', 'test',
      '--output-id', id,
    ], { stdout: 'pipe', stderr: 'pipe' });

    await proc.exited;

    // Symlink was removed and replaced with a regular file — target NOT written
    expect(existsSync(targetPath)).toBe(false);
    // Output was written as a regular file (not through the symlink)
    const content = JSON.parse(readFileSync(symlinkPath, 'utf-8'));
    expect(content.event).toBe('error');
  });
});
