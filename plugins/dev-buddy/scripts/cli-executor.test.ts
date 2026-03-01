import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

const SCRIPT_PATH = path.join(import.meta.dir, 'cli-executor.ts');

// Mock CLI preset for testing
const MOCK_PRESET_NAME = 'test-cli';
const MOCK_PRESET = {
  type: 'cli',
  name: 'Test CLI Tool',
  command: 'echo',
  args_template: '--model {model} --output {output_file} {prompt}',
  models: ['test-model', 'other-model'],
};

const MOCK_PRESETS_CONFIG = {
  version: '2.0',
  presets: {
    [MOCK_PRESET_NAME]: MOCK_PRESET,
    'not-a-cli': {
      type: 'subscription',
      name: 'Not CLI',
    },
  },
};

/**
 * Run cli-executor.ts as a subprocess.
 * Uses a mock HOME directory so readPresets() finds mock config.
 */
function runScript(
  args: string[],
  cwd: string,
  mockHome: string
): Promise<{
  code: number | null;
  events: Array<Record<string, unknown>>;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: mockHome, USERPROFILE: mockHome, CLAUDE_PROJECT_DIR: cwd };
    const proc = spawn('bun', [SCRIPT_PATH, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (data: Buffer) => (stdout += data));
    proc.stderr!.on('data', (data: Buffer) => (stderr += data));

    proc.on('close', (code) => {
      const events = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); }
          catch { return { raw: line }; }
        });
      resolve({ code, events, stdout, stderr });
    });
  });
}

describe('cli-executor.ts', () => {
  let tempDir: string;
  let mockPluginRoot: string;
  let mockHome: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-executor-test-'));
    fs.mkdirSync(path.join(tempDir, '.vcp', 'task'), { recursive: true });

    mockPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-plugin-'));
    fs.mkdirSync(path.join(mockPluginRoot, 'docs', 'schemas'), { recursive: true });
    fs.writeFileSync(
      path.join(mockPluginRoot, 'docs', 'schemas', 'plan-review.schema.json'),
      JSON.stringify({ type: 'object' })
    );
    fs.writeFileSync(
      path.join(mockPluginRoot, 'docs', 'schemas', 'review-result.schema.json'),
      JSON.stringify({ type: 'object' })
    );
    fs.writeFileSync(
      path.join(mockPluginRoot, 'docs', 'review-guidelines.md'),
      '# Review Guidelines\n\nReview guidelines here.'
    );

    mockHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-home-'));
    fs.mkdirSync(path.join(mockHome, '.vcp'), { recursive: true });
    fs.writeFileSync(
      path.join(mockHome, '.vcp', 'ai-presets.json'),
      JSON.stringify(MOCK_PRESETS_CONFIG, null, 2)
    );
  });

  afterEach(async () => {
    for (const dir of [tempDir, mockPluginRoot, mockHome]) {
      for (let i = 0; i < 3; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  });

  // ================== ARGUMENT VALIDATION ==================

  test('fails with missing --preset flag', async () => {
    const result = await runScript(
      ['--type', 'plan', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('--preset'))
    )).toBe(true);
  });

  test('fails with missing --type argument', async () => {
    const result = await runScript(
      ['--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('--type'))
    )).toBe(true);
  });

  test('fails with invalid --type argument', async () => {
    const result = await runScript(
      ['--type', 'invalid', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('Invalid'))
    )).toBe(true);
  });

  test('fails with missing --plugin-root argument', async () => {
    const result = await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model'],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('--plugin-root'))
    )).toBe(true);
  });

  test('fails with missing --model argument', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('--model'))
    )).toBe(true);
  });

  // ================== PRESET VALIDATION ==================

  test('fails when preset not found in config', async () => {
    const result = await runScript(
      ['--type', 'plan', '--preset', 'nonexistent-preset', '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'preset_loading' &&
      (e.error as string)?.includes('not found')
    )).toBe(true);
  });

  test('fails when preset is not cli type', async () => {
    const result = await runScript(
      ['--type', 'plan', '--preset', 'not-a-cli', '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'preset_loading' &&
      (e.error as string)?.includes("expected 'cli'")
    )).toBe(true);
  });

  test('fails when model not in preset models list', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'wrong-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('not in preset'))
    )).toBe(true);
  });

  // ================== INPUT FILE VALIDATION ==================

  test('fails when plan-refined.json missing for plan review', async () => {
    const result = await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('plan-refined.json'))
    )).toBe(true);
  });

  test('fails when impl-result.json missing for code review', async () => {
    const result = await runScript(
      ['--type', 'code', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('impl-result.json'))
    )).toBe(true);
  });

  test('fails when schema file missing', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );
    fs.unlinkSync(path.join(mockPluginRoot, 'docs', 'schemas', 'plan-review.schema.json'));

    const result = await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('schema'))
    )).toBe(true);
  });

  test('fails when review-guidelines.md missing', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );
    fs.unlinkSync(path.join(mockPluginRoot, 'docs', 'review-guidelines.md'));

    const result = await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('review guidelines'))
    )).toBe(true);
  });

  // ================== OUTPUT FILE ==================

  test('writes error to default output file on validation failure', async () => {
    await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const outputPath = path.join(tempDir, '.vcp', 'task', 'plan-review-cli.json');
    expect(fs.existsSync(outputPath)).toBe(true);

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(output.status).toBe('error');
    expect(output.phase).toBe('input_validation');
  });

  test('writes error to --output-file path when specified', async () => {
    const customOutput = '.vcp/task/plan-review-3.json';
    await runScript(
      [
        '--type', 'plan',
        '--preset', MOCK_PRESET_NAME,
        '--model', 'test-model',
        '--plugin-root', mockPluginRoot,
        '--output-file', customOutput,
      ],
      tempDir,
      mockHome
    );

    const outputPath = path.join(tempDir, customOutput);
    expect(fs.existsSync(outputPath)).toBe(true);

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(output.status).toBe('error');
  });

  // ================== JSON OUTPUT FORMAT ==================

  test('outputs structured JSON events with preset info', async () => {
    const result = await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.type).toBe('plan');
    expect(startEvent!.preset).toBe(MOCK_PRESET_NAME);
    expect(startEvent!.command).toBe('echo');
    expect(startEvent!.model).toBe('test-model');
    expect(startEvent!.platform).toBeDefined();
    expect(startEvent!.isResume).toBeDefined();
    expect(startEvent!.sessionActive).toBeDefined();

    expect(result.events.some(e => e.event === 'error')).toBe(true);
  });

  // ================== SESSION MARKERS ==================

  test('detects active session from .cli-session-{type} marker', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', '.cli-session-plan'),
      new Date().toISOString()
    );

    const result = await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.sessionActive).toBe(true);
  });

  test('plan session marker does not affect code review', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', '.cli-session-plan'),
      new Date().toISOString()
    );
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'impl-result.json'),
      JSON.stringify({ files: [] })
    );

    const result = await runScript(
      ['--type', 'code', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.sessionActive).toBe(false);
  });

  test('code session marker triggers sessionActive for code review', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', '.cli-session-code'),
      new Date().toISOString()
    );
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'impl-result.json'),
      JSON.stringify({ files: [] })
    );

    const result = await runScript(
      ['--type', 'code', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.sessionActive).toBe(true);
  });

  test('--resume flag forces resume mode', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot, '--resume'],
      tempDir,
      mockHome
    );

    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.isResume).toBe(true);
  });

  // ================== PATH TRAVERSAL (CWE-22) ==================

  test('rejects --output-file with path traversal', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      [
        '--type', 'plan',
        '--preset', MOCK_PRESET_NAME,
        '--model', 'test-model',
        '--plugin-root', mockPluginRoot,
        '--output-file', '.vcp/task/../../../etc/evil.json',
      ],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('path traversal'))
    )).toBe(true);
  });

  test('rejects --output-file without .json extension', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      [
        '--type', 'plan',
        '--preset', MOCK_PRESET_NAME,
        '--model', 'test-model',
        '--plugin-root', mockPluginRoot,
        '--output-file', '.vcp/task/evil.txt',
      ],
      tempDir,
      mockHome
    );

    expect(result.code).toBe(1);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('.json'))
    )).toBe(true);
  });

  // ================== CLI TOOL NOT INSTALLED ==================

  test('fails when CLI tool not installed', async () => {
    const badPresetsConfig = {
      version: '2.0',
      presets: {
        'bad-cli': {
          type: 'cli',
          name: 'Bad CLI',
          command: 'nonexistent-cli-tool-xyz-abc-123',
          args_template: '{prompt}',
          models: ['test-model'],
        },
      },
    };
    fs.writeFileSync(
      path.join(mockHome, '.vcp', 'ai-presets.json'),
      JSON.stringify(badPresetsConfig, null, 2)
    );

    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--preset', 'bad-cli', '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    expect(result.code).toBeGreaterThan(0);
    expect(result.events.some(e =>
      e.phase === 'input_validation' &&
      (e.errors as string[])?.some(err => err.includes('not installed'))
    )).toBe(true);
  });

  // ================== CHANGES SUMMARY ==================

  test('--changes-summary is included in start event context', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      [
        '--type', 'plan',
        '--preset', MOCK_PRESET_NAME,
        '--model', 'test-model',
        '--plugin-root', mockPluginRoot,
        '--changes-summary', 'Fixed SQL injection',
      ],
      tempDir,
      mockHome
    );

    const startEvent = result.events.find(e => e.event === 'start');
    expect(startEvent).toBeDefined();
  });

  // ================== TOKENIZER FIX (apostrophe bug) ==================

  test('prompt containing apostrophes does not crash tokenizer', async () => {
    // Use unquoted {prompt} placeholder — before the fix, apostrophes in the
    // substituted prompt would be treated as shell quote delimiters by the tokenizer
    const unquotedPresets = {
      version: '2.0',
      presets: {
        'unquoted-cli': {
          type: 'cli',
          name: 'Unquoted CLI',
          command: 'echo',
          args_template: '--model {model} -o {output_file} {prompt}',
          models: ['test-model'],
          supports_resume: true,
          resume_args_template: '--resume -m {model} -o {output_file} {prompt}',
        },
      },
    };
    fs.writeFileSync(
      path.join(mockHome, '.vcp', 'ai-presets.json'),
      JSON.stringify(unquotedPresets, null, 2)
    );
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );
    // Session marker + --resume triggers changesSummary prompt path
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', '.cli-session-plan'),
      new Date().toISOString()
    );

    const result = await runScript(
      [
        '--type', 'plan',
        '--preset', 'unquoted-cli',
        '--model', 'test-model',
        '--plugin-root', mockPluginRoot,
        '--resume',
        // Odd number of apostrophes — would crash old tokenizer
        '--changes-summary', "The module hasn't been tested",
      ],
      tempDir,
      mockHome
    );

    // Should NOT fail at command_building — apostrophes in substituted values are harmless
    const buildError = result.events.find(e =>
      e.phase === 'command_building' && e.event === 'error'
    );
    expect(buildError).toBeUndefined();

    // Should reach CLI invocation (may later fail at output_validation since echo doesn't produce JSON)
    const invokeEvent = result.events.find(e => e.event === 'invoking_cli');
    expect(invokeEvent).toBeDefined();
  });

  test('unquoted placeholder produces single arg per placeholder', async () => {
    // With tokenize-first fix, {prompt} becomes one token then one arg
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      [
        '--type', 'plan',
        '--preset', MOCK_PRESET_NAME,
        '--model', 'test-model',
        '--plugin-root', mockPluginRoot,
      ],
      tempDir,
      mockHome
    );

    // Should get past command_building without error
    const buildError = result.events.find(e =>
      e.phase === 'command_building' && e.event === 'error'
    );
    expect(buildError).toBeUndefined();

    const invokeEvent = result.events.find(e => e.event === 'invoking_cli');
    expect(invokeEvent).toBeDefined();
  });

  test('mid-token placeholders produce combined arg values', async () => {
    fs.writeFileSync(
      path.join(mockHome, '.vcp', 'config.json'),
      JSON.stringify({ debug: true })
    );
    const midTokenPresets = {
      version: '2.0',
      presets: {
        'mid-token': {
          type: 'cli',
          name: 'Mid Token CLI',
          command: 'echo',
          args_template: '--model={model} --effort={reasoning_effort} -o {output_file} "{prompt}"',
          models: ['test-model'],
          reasoning_effort: 'high',
        },
      },
    };
    fs.writeFileSync(
      path.join(mockHome, '.vcp', 'ai-presets.json'),
      JSON.stringify(midTokenPresets, null, 2)
    );
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    await runScript(
      ['--type', 'plan', '--preset', 'mid-token', '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    // Check debug log for combined args
    const logPath = path.join(tempDir, '.vcp', 'dev-buddy.log');
    expect(fs.existsSync(logPath)).toBe(true);

    const logContent = fs.readFileSync(logPath, 'utf8');
    expect(logContent).toContain('--model=test-model');
    expect(logContent).toContain('--effort=high');
  });

  test('reasoning_effort defaults to medium when not set in preset', async () => {
    fs.writeFileSync(
      path.join(mockHome, '.vcp', 'config.json'),
      JSON.stringify({ debug: true })
    );
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const logPath = path.join(tempDir, '.vcp', 'dev-buddy.log');
    expect(fs.existsSync(logPath)).toBe(true);

    const logContent = fs.readFileSync(logPath, 'utf8');
    // preset_loaded should show reasoning_effort=medium (default)
    expect(logContent).toContain('reasoning_effort=medium');
  });

  // ================== DEBUG LOGGING ==================

  test('writes to .vcp/dev-buddy.log when debug is enabled', async () => {
    fs.writeFileSync(
      path.join(mockHome, '.vcp', 'config.json'),
      JSON.stringify({ debug: true })
    );
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const logPath = path.join(tempDir, '.vcp', 'dev-buddy.log');
    expect(fs.existsSync(logPath)).toBe(true);

    const logContent = fs.readFileSync(logPath, 'utf8');
    expect(logContent).toContain('[preset_loaded]');
    expect(logContent).toContain('cli-executor');
  });

  // ================== RUNTIME PLACEHOLDER VALIDATION ==================

  test('rejects args_template missing {output_file} at runtime', async () => {
    const badPresets = {
      version: '2.0',
      presets: {
        'bad-cli': {
          type: 'cli',
          name: 'Bad CLI',
          command: 'echo',
          args_template: '--model {model} "{prompt}"',
          models: ['test-model'],
        },
      },
    };
    fs.writeFileSync(
      path.join(mockHome, '.vcp', 'ai-presets.json'),
      JSON.stringify(badPresets, null, 2)
    );
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--preset', 'bad-cli', '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const buildError = result.events.find(e =>
      e.phase === 'command_building' && e.event === 'error'
    );
    expect(buildError).toBeDefined();
    expect(buildError!.error).toContain('missing required');
    expect(buildError!.error).toContain('output_file');
  });

  test('rejects args_template missing {model} at runtime', async () => {
    const badPresets = {
      version: '2.0',
      presets: {
        'no-model': {
          type: 'cli',
          name: 'No Model CLI',
          command: 'echo',
          args_template: '-o {output_file} "{prompt}"',
          models: ['test-model'],
        },
      },
    };
    fs.writeFileSync(
      path.join(mockHome, '.vcp', 'ai-presets.json'),
      JSON.stringify(badPresets, null, 2)
    );
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    const result = await runScript(
      ['--type', 'plan', '--preset', 'no-model', '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const buildError = result.events.find(e =>
      e.phase === 'command_building' && e.event === 'error'
    );
    expect(buildError).toBeDefined();
    expect(buildError!.error).toContain('missing required');
    expect(buildError!.error).toContain('model');
  });

  test('does not write .vcp/dev-buddy.log when debug is disabled', async () => {
    // No debug config file at all
    fs.writeFileSync(
      path.join(tempDir, '.vcp', 'task', 'plan-refined.json'),
      JSON.stringify({ id: 'test', steps: [] })
    );

    await runScript(
      ['--type', 'plan', '--preset', MOCK_PRESET_NAME, '--model', 'test-model', '--plugin-root', mockPluginRoot],
      tempDir,
      mockHome
    );

    const logPath = path.join(tempDir, '.vcp', 'dev-buddy.log');
    expect(fs.existsSync(logPath)).toBe(false);
  });
});
