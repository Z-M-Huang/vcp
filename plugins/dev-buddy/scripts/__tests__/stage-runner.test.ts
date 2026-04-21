import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  buildStageTask,
  segmentExecutors,
  parseArgs,
  StageProgress,
  runExecutorWithProgress,
  buildSubscriptionArgs,
  UNIT_REVIEW_OUTPUT_CONTRACT,
  type Segment,
  type DispatchResult,
  type StageProgressState,
} from '../stage-runner.ts';
import type { StageExecutor } from '../../types/pipeline.ts';
import type { Preset } from '../../types/presets.ts';

// ─── Temp directory management ─────────────────────────────────────────────

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true })); });

function makeTmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'stage-runner-test-'));
  tmpDirs.push(d);
  return d;
}

// ─── buildStageTask ────────────────────────────────────────────────────────

describe('buildStageTask', () => {
  test('discovery stage returns feature description only', () => {
    const result = buildStageTask('discovery', 'Build a login page', '/nonexistent/plan.md', '/tmp');
    expect(result).toBe('Build a login page');
  });

  test('ralph-requirements stage includes Discovery section from plan', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '## Discovery',
      '',
      'Found auth module at src/auth.ts. Uses JWT tokens.',
      'Database schema has users table with email+hash.',
      '',
      '## Requirements',
      '',
      'AC1: Login form validates email format.',
    ].join('\n'));

    const result = buildStageTask('ralph-requirements', 'Build a login page', planPath, '/tmp');
    expect(result).toContain('Build a login page');
    expect(result).toContain('Prior Discovery Findings');
    expect(result).toContain('Found auth module at src/auth.ts');
    expect(result).toContain('JWT tokens');
    // Should NOT include requirements section
    expect(result).not.toContain('AC1');
    expect(result).not.toContain('Prior Requirements');
  });

  test('decomposition stage includes both Discovery and Requirements sections', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '## Discovery',
      '',
      'Found auth module at src/auth.ts.',
      '',
      '## Requirements',
      '',
      'AC1: Login form validates email.',
      'AC2: Password must be 8+ chars.',
      '',
      '## Units of Work',
      '',
      'Unit 1: Form component.',
    ].join('\n'));

    const result = buildStageTask('decomposition', 'Build a login page', planPath, '/tmp');
    expect(result).toContain('Build a login page');
    expect(result).toContain('Prior Discovery Findings');
    expect(result).toContain('Found auth module');
    expect(result).toContain('Prior Requirements');
    expect(result).toContain('AC1: Login form validates email');
    expect(result).toContain('AC2: Password must be 8+ chars');
    // Should NOT include Units of Work
    expect(result).not.toContain('Unit 1: Form component');
  });

  test('decomposition stage extracts full Requirements section even with H2 subheadings', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '## Discovery',
      '',
      'Found auth module at src/auth.ts.',
      '',
      '## Requirements',
      '',
      '## Acceptance Criteria',
      '',
      '### AC-1: Login form validates email',
      '- **Given:** user on /login',
      '',
      '## UAT Scenarios',
      '',
      '### UAT-1: Login flow',
      '- **Validates:** AC-1',
    ].join('\n'));

    const result = buildStageTask('decomposition', 'Build a login page', planPath, '/tmp');
    expect(result).toContain('AC-1: Login form validates email');
    expect(result).toContain('UAT-1: Login flow');
    expect(result).toContain('Prior Requirements');
  });

  test('missing plan file returns feature description only for requirements/decompose', () => {
    const result = buildStageTask('ralph-requirements', 'Build a login page', '/nonexistent/plan.md', '/tmp');
    expect(result).toBe('Build a login page');
  });

  test('plan file missing Discovery section returns feature only for requirements', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, '# Feature: Auth\n\n## Status\n\nSome status text.\n');

    const result = buildStageTask('ralph-requirements', 'Build a login page', planPath, '/tmp');
    expect(result).toBe('Build a login page');
  });

  test('decomposition with Discovery but no Requirements includes only Discovery', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '## Discovery',
      '',
      'Found auth module.',
      '',
    ].join('\n'));

    const result = buildStageTask('decomposition', 'Build a login page', planPath, '/tmp');
    expect(result).toContain('Prior Discovery Findings');
    expect(result).toContain('Found auth module');
    expect(result).not.toContain('Prior Requirements');
  });

  test('discovery re-run with Feedback injects feedback into context', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '**Status:** discover',
      '',
      '## Discovery',
      '',
      'Found auth module at src/auth.ts.',
      '',
      '## Feedback',
      '',
      'Please also check the OAuth integration in src/oauth.ts.',
    ].join('\n'));

    const result = buildStageTask('discovery', 'Build a login page', planPath, '/tmp');
    expect(result).toContain('Build a login page');
    expect(result).toContain('User Feedback (Address This)');
    expect(result).toContain('OAuth integration in src/oauth.ts');
  });

  test('discovery without Feedback returns feature description only', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '**Status:** discover',
      '',
      '## Discovery',
      '',
      'Found auth module.',
    ].join('\n'));

    const result = buildStageTask('discovery', 'Build a login page', planPath, '/tmp');
    expect(result).toBe('Build a login page');
    expect(result).not.toContain('User Feedback');
  });

  test('ralph-requirements with Feedback injects feedback alongside Discovery', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '## Discovery',
      '',
      'Found auth module at src/auth.ts.',
      '',
      '## Feedback',
      '',
      'Requirements should cover password reset flow too.',
    ].join('\n'));

    const result = buildStageTask('ralph-requirements', 'Build a login page', planPath, '/tmp');
    expect(result).toContain('Build a login page');
    expect(result).toContain('User Feedback (Address This)');
    expect(result).toContain('password reset flow');
    expect(result).toContain('Prior Discovery Findings');
    expect(result).toContain('Found auth module');
  });

  test('decomposition with Feedback injects feedback alongside Discovery and Requirements', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '## Discovery',
      '',
      'Found auth module.',
      '',
      '## Requirements',
      '',
      'AC1: Login form validates email.',
      '',
      '## Feedback',
      '',
      'Split the auth unit into separate login and signup units.',
    ].join('\n'));

    const result = buildStageTask('decomposition', 'Build a login page', planPath, '/tmp');
    expect(result).toContain('User Feedback (Address This)');
    expect(result).toContain('separate login and signup units');
    expect(result).toContain('Prior Discovery Findings');
    expect(result).toContain('Prior Requirements');
  });

  test('empty Feedback section is not injected', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '## Discovery',
      '',
      'Found auth module.',
      '',
      '## Feedback',
      '',
      '## Requirements',
      '',
      'AC1: Login validates email.',
    ].join('\n'));

    const result = buildStageTask('ralph-requirements', 'Build a login page', planPath, '/tmp');
    expect(result).not.toContain('User Feedback');
    expect(result).toContain('Prior Discovery Findings');
  });

  test('feedback appears before prior stage sections in context', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, [
      '# Feature: Auth',
      '',
      '## Discovery',
      '',
      'Found auth module.',
      '',
      '## Requirements',
      '',
      'AC1: Login validates email.',
      '',
      '## Feedback',
      '',
      'Add OAuth support.',
    ].join('\n'));

    const result = buildStageTask('decomposition', 'Build a login page', planPath, '/tmp');
    const feedbackIdx = result.indexOf('User Feedback (Address This)');
    const discoveryIdx = result.indexOf('Prior Discovery Findings');
    const reqIdx = result.indexOf('Prior Requirements');
    expect(feedbackIdx).toBeGreaterThan(-1);
    expect(discoveryIdx).toBeGreaterThan(-1);
    expect(reqIdx).toBeGreaterThan(-1);
    // Feedback must come before prior stage sections so executors see it first
    expect(feedbackIdx).toBeLessThan(discoveryIdx);
    expect(feedbackIdx).toBeLessThan(reqIdx);
  });

  // ─── unit-review branch (Part A — BLR dispatches stage-runner by unit ID) ─

  // Helper: set up a project dir with a minimal plan and a unit-N.md under the
  // expected ralph layout. The slug is derived from the plan filename
  // (`ralph-{slug}.md`).
  function setupUnitReviewProject(unitId: number, opts: { filesToTouch?: string[]; fileSizes?: number[]; slug?: string } = {}): {
    cwd: string; planPath: string; unitPath: string;
  } {
    const cwd = makeTmpDir();
    const slug = opts.slug ?? 'test-review';
    const planDir = path.join(cwd, '.vcp', 'plan');
    const unitDir = path.join(planDir, 'ralph', slug);
    mkdirSync(unitDir, { recursive: true });
    const planPath = path.join(planDir, `ralph-${slug}.md`);
    writeFileSync(planPath, [
      '# Feature: Test',
      '',
      '## Units of Work',
      '',
      `- Unit ${unitId}: Test`,
    ].join('\n'));

    // Optional touched files under cwd.
    const filesToTouch = opts.filesToTouch ?? [];
    filesToTouch.forEach((rel, i) => {
      const abs = path.join(cwd, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      const content = opts.fileSizes ? 'x'.repeat(opts.fileSizes[i] ?? 100) : `// contents of ${rel}\nexport const x = 1;\n`;
      writeFileSync(abs, content);
    });

    const filesSection = filesToTouch.length > 0
      ? filesToTouch.map((f) => `- \`${f}\` -- existing | modify`).join('\n')
      : '- (none)';
    const unitPath = path.join(unitDir, `unit-${unitId}.md`);
    writeFileSync(unitPath, [
      `# Unit ${unitId}: Test Unit`,
      '',
      '**Status:** pending',
      '**Attempts:** 0',
      '**Max Attempts:** 3',
      '',
      '### Files to Touch',
      filesSection,
      '',
      '### What to Implement',
      'Implement it.',
    ].join('\n'));

    return { cwd, planPath, unitPath };
  }

  // Test 9 — happy path: valid unit-N.md + files touched produces a prompt
  // containing both the Unit Plan block and the Implementation Files block.
  test('[9] unit-review + --unit N + valid unit-N.md → output contains ## Unit Plan + ## Implementation Files', () => {
    const { cwd, planPath } = setupUnitReviewProject(1, {
      filesToTouch: ['src/auth/login.ts'],
    });
    const result = buildStageTask('unit-review', 'Feature description', planPath, cwd, 1);
    expect(result).toContain('## Unit Plan');
    expect(result).toContain('Unit 1: Test Unit');
    expect(result).toContain('## Implementation Files');
    expect(result).toContain('src/auth/login.ts');
    expect(result).toContain('export const x = 1;');
    expect(result).toContain(UNIT_REVIEW_OUTPUT_CONTRACT);
  });

  // Test 10 — missing unit-N.md throws a clear error.
  test('[10] unit-review + --unit N + missing unit file → throws', () => {
    const cwd = makeTmpDir();
    const planDir = path.join(cwd, '.vcp', 'plan');
    mkdirSync(path.join(planDir, 'ralph', 'missing-unit'), { recursive: true });
    const planPath = path.join(planDir, 'ralph-missing-unit.md');
    writeFileSync(planPath, '# Feature\n\n## Units of Work\n\n- Unit 1: Test\n');

    expect(() => buildStageTask('unit-review', 'Feature', planPath, cwd, 99))
      .toThrow(/unit 99 file not found/);
  });

  // Test 11 — back-compat: unit-review called WITHOUT unitId behaves like a
  // pass-through (no Unit Plan / Implementation Files blocks appended).
  test('[11] unit-review without --unit (stdin path) passes through unchanged', () => {
    const { cwd, planPath } = setupUnitReviewProject(1);
    const result = buildStageTask('unit-review', 'Feature description', planPath, cwd);
    // No unit-review branch injection.
    expect(result).not.toContain('## Unit Plan');
    expect(result).not.toContain('## Implementation Files');
    // Feature description flows through.
    expect(result).toBe('Feature description');
  });

  // Test 13 — oversized files-touched triggers truncation sentinel + vcpLog entry.
  // (Test 12 lives in the parseArgs describe block below.)
  test('[13] unit-review + files-touched > UNIT_REVIEW_FILES_MAX_BYTES → truncation sentinel + vcpLog entry', async () => {
    const { UNIT_REVIEW_FILES_MAX_BYTES } = await import('../ralph/types.ts');
    // One huge file that exceeds the cap by itself.
    const oversize = UNIT_REVIEW_FILES_MAX_BYTES + 4096;
    const { cwd, planPath } = setupUnitReviewProject(2, {
      filesToTouch: ['src/huge.ts'],
      fileSizes: [oversize],
    });

    // Pass debugEnabled=true so vcpLog actually writes.
    const result = buildStageTask('unit-review', 'Feature', planPath, cwd, 2, true);
    expect(result).toContain('[… truncated at UNIT_REVIEW_FILES_MAX_BYTES …]');

    // Wait briefly for the fire-and-forget vcpLog to flush.
    await new Promise((r) => setTimeout(r, 50));
    const logPath = path.join(cwd, '.vcp', 'dev-buddy.log');
    const logBody = fs.readFileSync(logPath, 'utf-8');
    expect(logBody).toContain('unit-review.context.truncated');
    expect(logBody).toContain(`unit=2`);
    // bytesIn includes framing added by readFilesTouched (file headers etc.),
    // so match by "> cap" bound rather than exact value.
    const bytesInMatch = logBody.match(/bytesIn=(\d+)/);
    expect(bytesInMatch).not.toBeNull();
    expect(Number(bytesInMatch![1])).toBeGreaterThan(UNIT_REVIEW_FILES_MAX_BYTES);
    expect(logBody).toContain(`capBytes=${UNIT_REVIEW_FILES_MAX_BYTES}`);
  });
});

// ─── segmentExecutors ──────────────────────────────────────────────────────

describe('segmentExecutors', () => {
  function makeExecutor(parallel: boolean): StageExecutor {
    return { system_prompt: 'test', preset: 'test', model: 'test', parallel };
  }

  test('all parallel executors form a single segment', () => {
    const executors = [makeExecutor(true), makeExecutor(true), makeExecutor(true)];
    const segments = segmentExecutors(executors);
    expect(segments).toHaveLength(1);
    expect(segments[0].parallel).toBe(true);
    expect(segments[0].executors).toHaveLength(3);
    expect(segments[0].executors.map(e => e.index)).toEqual([0, 1, 2]);
  });

  test('all sequential executors form individual segments', () => {
    const executors = [makeExecutor(false), makeExecutor(false)];
    const segments = segmentExecutors(executors);
    expect(segments).toHaveLength(2);
    expect(segments[0].parallel).toBe(false);
    expect(segments[0].executors).toHaveLength(1);
    expect(segments[0].executors[0].index).toBe(0);
    expect(segments[1].parallel).toBe(false);
    expect(segments[1].executors[0].index).toBe(1);
  });

  test('mixed: parallel group + sequential synthesizer (standard config)', () => {
    // Typical config: 3 parallel workers + 1 sequential synthesizer
    const executors = [
      makeExecutor(true),
      makeExecutor(true),
      makeExecutor(true),
      makeExecutor(false), // synthesizer
    ];
    const segments = segmentExecutors(executors);
    expect(segments).toHaveLength(2);
    expect(segments[0].parallel).toBe(true);
    expect(segments[0].executors).toHaveLength(3);
    expect(segments[1].parallel).toBe(false);
    expect(segments[1].executors).toHaveLength(1);
    expect(segments[1].executors[0].index).toBe(3);
  });

  test('mixed: parallel + sequential mid-list + parallel + sequential', () => {
    // Edge case: non-parallel executor in the middle
    const executors = [
      makeExecutor(true),   // 0
      makeExecutor(true),   // 1
      makeExecutor(false),  // 2 — sequential mid-list
      makeExecutor(true),   // 3
      makeExecutor(true),   // 4
      makeExecutor(false),  // 5 — synthesizer
    ];
    const segments = segmentExecutors(executors);
    expect(segments).toHaveLength(4);
    // Segment 0: parallel [0,1]
    expect(segments[0].parallel).toBe(true);
    expect(segments[0].executors.map(e => e.index)).toEqual([0, 1]);
    // Segment 1: sequential [2]
    expect(segments[1].parallel).toBe(false);
    expect(segments[1].executors.map(e => e.index)).toEqual([2]);
    // Segment 2: parallel [3,4]
    expect(segments[2].parallel).toBe(true);
    expect(segments[2].executors.map(e => e.index)).toEqual([3, 4]);
    // Segment 3: sequential [5]
    expect(segments[3].parallel).toBe(false);
    expect(segments[3].executors.map(e => e.index)).toEqual([5]);
  });

  test('single executor forms one sequential segment', () => {
    const executors = [makeExecutor(false)];
    const segments = segmentExecutors(executors);
    expect(segments).toHaveLength(1);
    expect(segments[0].parallel).toBe(false);
    expect(segments[0].executors).toHaveLength(1);
  });

  test('single parallel executor forms one parallel segment', () => {
    const executors = [makeExecutor(true)];
    const segments = segmentExecutors(executors);
    expect(segments).toHaveLength(1);
    expect(segments[0].parallel).toBe(true);
    expect(segments[0].executors).toHaveLength(1);
  });

  test('empty executor list returns empty segments', () => {
    const segments = segmentExecutors([]);
    expect(segments).toHaveLength(0);
  });

  test('preserves original executor indices', () => {
    const executors = [
      makeExecutor(true),   // 0
      makeExecutor(false),  // 1
      makeExecutor(true),   // 2
    ];
    const segments = segmentExecutors(executors);
    expect(segments).toHaveLength(3);
    expect(segments[0].executors[0].index).toBe(0);
    expect(segments[1].executors[0].index).toBe(1);
    expect(segments[2].executors[0].index).toBe(2);
  });
});

// ─── parseArgs ─────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  // Helper: build a fake argv with the required flags + extras
  function argv(...extra: string[]): string[] {
    return ['bun', 'stage-runner.ts', '--stage-type', 'discovery', '--plan', '/tmp/plan.md', '--cwd', '/tmp', ...extra];
  }

  test('accepts --task with value', () => {
    const result = parseArgs(argv('--task', 'Build a login page'));
    expect(result.stageType).toBe('discovery');
    expect(result.planPath).toBe('/tmp/plan.md');
    expect(result.cwd).toBe('/tmp');
    expect(result.task).toBe('Build a login page');
  });

  test('rejects --task without a value', () => {
    expect(() => parseArgs(argv('--task'))).toThrow('--task requires a value');
  });

  test('rejects when neither --task nor --task-stdin provided', () => {
    expect(() => parseArgs(argv())).toThrow('--task or --task-stdin is required');
  });

  test('rejects missing --stage-type', () => {
    expect(() => parseArgs(['bun', 'stage-runner.ts', '--plan', '/p', '--cwd', '/c', '--task', 't'])).toThrow('--stage-type is required');
  });

  test('rejects missing --plan', () => {
    expect(() => parseArgs(['bun', 'stage-runner.ts', '--stage-type', 's', '--cwd', '/c', '--task', 't'])).toThrow('--plan is required');
  });

  test('rejects missing --cwd', () => {
    expect(() => parseArgs(['bun', 'stage-runner.ts', '--stage-type', 's', '--plan', '/p', '--task', 't'])).toThrow('--cwd is required');
  });

  // Test 12 — parseArgs relaxation: when --stage-type unit-review --unit N is
  // present, --task / --task-stdin become optional (the unit-review branch
  // synthesizes the task itself).
  test('[12] --stage-type unit-review --unit N without --task/--task-stdin is accepted', () => {
    const result = parseArgs([
      'bun', 'stage-runner.ts',
      '--stage-type', 'unit-review',
      '--plan', '/tmp/plan.md',
      '--cwd', '/tmp',
      '--unit', '3',
    ]);
    expect(result.stageType).toBe('unit-review');
    expect(result.unitId).toBe(3);
    expect(result.task).toBe('');
  });

  test('[12b] --stage-type unit-review WITHOUT --unit still requires --task or --task-stdin', () => {
    expect(() => parseArgs([
      'bun', 'stage-runner.ts',
      '--stage-type', 'unit-review',
      '--plan', '/tmp/plan.md',
      '--cwd', '/tmp',
    ])).toThrow('--task or --task-stdin is required');
  });
});

// ─── Cross-component: stage status → state machine checkpoint ──────────────

describe('cross-component: stage-runner output → state machine review gate', () => {
  const tmpDirs: string[] = [];
  afterAll(() => { tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true })); });

  test('plan with discover-review status triggers user_checkpoint action', () => {
    const { main } = require('../ralph-state-machine.ts');
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sr-xcomp-'));
    tmpDirs.push(tmpDir);
    const planDir = path.join(tmpDir, '.vcp', 'plan');
    mkdirSync(planDir, { recursive: true });
    const planPath = path.join(planDir, 'ralph-test-feature.md');
    writeFileSync(planPath, '**Status:** discover-review\n## Discovery\nFound relevant modules.');

    const result = main(planPath, 'next');
    const cp = result.actions.find((a: any) => a.type === 'user_checkpoint');
    expect(cp).toBeDefined();
    expect(cp.type).toBe('user_checkpoint');
    expect(cp.stage).toBe('discover');
    expect(cp.sectionHeading).toBe('## Discovery');
    expect(cp.approveStatus).toBe('requirements');
  });

  test('plan with requirements-review status triggers user_checkpoint for decompose', () => {
    const { main } = require('../ralph-state-machine.ts');
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sr-xcomp-'));
    tmpDirs.push(tmpDir);
    const planDir = path.join(tmpDir, '.vcp', 'plan');
    mkdirSync(planDir, { recursive: true });
    const planPath = path.join(planDir, 'ralph-req-review.md');
    writeFileSync(planPath, '**Status:** requirements-review\n## Requirements\n### AC-1: Test\n### UAT-1: Test');

    const result = main(planPath, 'next');
    const cp = result.actions.find((a: any) => a.type === 'user_checkpoint');
    expect(cp).toBeDefined();
    expect(cp.stage).toBe('requirements');
    expect(cp.approveStatus).toBe('decompose');
  });

  test('plan with decompose-review status triggers user_checkpoint for build', () => {
    const { main } = require('../ralph-state-machine.ts');
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sr-xcomp-'));
    tmpDirs.push(tmpDir);
    const planDir = path.join(tmpDir, '.vcp', 'plan');
    mkdirSync(planDir, { recursive: true });
    const planPath = path.join(planDir, 'ralph-decomp-review.md');
    writeFileSync(planPath, '**Status:** decompose-review\n## Units of Work\n| # | Title |\n|---|-------|\n| 1 | Login |');

    const result = main(planPath, 'next');
    const cp = result.actions.find((a: any) => a.type === 'user_checkpoint');
    expect(cp).toBeDefined();
    expect(cp.stage).toBe('decompose');
    expect(cp.approveStatus).toBe('plan_lint');
  });
});

// ─── StageProgress ────────────────────────────────────────────────────────

describe('StageProgress', () => {
  function makeExecutors(count: number): Array<{ index: number; executor: StageExecutor }> {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      executor: {
        preset: 'test-preset',
        model: `model-${i}`,
        system_prompt: `role-${i}`,
        parallel: i < count - 1, // last one is sequential (synthesizer)
      },
    }));
  }

  function readProgress(filePath: string): StageProgressState {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  test('constructor creates progress file with all executors pending', () => {
    const tmpDir = makeTmpDir();
    const executors = makeExecutors(3);
    const progress = new StageProgress('discovery', executors, tmpDir);
    const state = readProgress(progress.getFilePath());

    expect(state.stage).toBe('discovery');
    expect(state.pid).toBe(process.pid);
    expect(state.total).toBe(3);
    expect(state.completed).toBe(0);
    expect(state.failed).toBe(0);
    expect(state.finished_at).toBeNull();
    expect(state.outcome).toBeNull();
    expect(state.executors).toHaveLength(3);
    expect(state.executors.every(e => e.status === 'pending')).toBe(true);
  });

  test('markRunning transitions executor to running', () => {
    const tmpDir = makeTmpDir();
    const progress = new StageProgress('discovery', makeExecutors(2), tmpDir);
    progress.markRunning(0);
    const state = readProgress(progress.getFilePath());

    expect(state.executors[0].status).toBe('running');
    expect(state.executors[1].status).toBe('pending');
  });

  test('markDone transitions executor to done with duration', () => {
    const tmpDir = makeTmpDir();
    const progress = new StageProgress('discovery', makeExecutors(3), tmpDir);
    progress.markRunning(1);
    progress.markDone(1, 45);
    const state = readProgress(progress.getFilePath());

    expect(state.executors[1].status).toBe('done');
    expect(state.executors[1].duration_s).toBe(45);
    expect(state.completed).toBe(1);
    expect(state.failed).toBe(0);
  });

  test('markFailed transitions executor to failed with duration', () => {
    const tmpDir = makeTmpDir();
    const progress = new StageProgress('discovery', makeExecutors(3), tmpDir);
    progress.markRunning(2);
    progress.markFailed(2, 120);
    const state = readProgress(progress.getFilePath());

    expect(state.executors[2].status).toBe('failed');
    expect(state.executors[2].duration_s).toBe(120);
    expect(state.completed).toBe(0);
    expect(state.failed).toBe(1);
  });

  test('writeTerminal sets finished_at and outcome', () => {
    const tmpDir = makeTmpDir();
    const progress = new StageProgress('discovery', makeExecutors(2), tmpDir);
    progress.markDone(0, 10);
    progress.markDone(1, 20);
    progress.writeTerminal('success');
    const state = readProgress(progress.getFilePath());

    expect(state.finished_at).not.toBeNull();
    expect(state.outcome).toBe('success');
    expect(state.completed).toBe(2);
  });

  test('writeTerminal with error outcome', () => {
    const tmpDir = makeTmpDir();
    const progress = new StageProgress('discovery', makeExecutors(2), tmpDir);
    progress.markFailed(0, 300);
    progress.writeTerminal('error');
    const state = readProgress(progress.getFilePath());

    expect(state.outcome).toBe('error');
    expect(state.failed).toBe(1);
  });

  test('all methods are non-throwing on I/O failure', () => {
    // Use an invalid path that will fail on write
    const progress = new StageProgress('test', makeExecutors(1), '/dev/null/impossible');
    // These should not throw
    expect(() => progress.markRunning(0)).not.toThrow();
    expect(() => progress.markDone(0, 10)).not.toThrow();
    expect(() => progress.markFailed(0, 10)).not.toThrow();
    expect(() => progress.writeTerminal('fatal')).not.toThrow();
  });

  test('file path includes stageType and pid', () => {
    const tmpDir = makeTmpDir();
    const progress = new StageProgress('ralph-requirements', makeExecutors(1), tmpDir);
    expect(progress.getFilePath()).toContain('stage-progress-ralph-requirements-');
    expect(progress.getFilePath()).toContain(String(process.pid));
  });

  test('slugHint scopes file under ralph-{slug}/progress/ (§7)', () => {
    const tmpDir = makeTmpDir();
    const progress = new StageProgress('ralph-build', makeExecutors(1), tmpDir, 'test-slug');
    const p = progress.getFilePath();
    expect(p).toContain(path.join('.state', 'ralph-test-slug', 'progress'));
    expect(p).toContain(`stage-progress-ralph-build-${process.pid}.json`);
    // File must actually be writable at that path (parent dirs created atomically)
    expect(fs.existsSync(p)).toBe(true);
  });

  test('null slugHint keeps legacy flat path (non-ralph callers)', () => {
    const tmpDir = makeTmpDir();
    const progress = new StageProgress('discovery', makeExecutors(1), tmpDir, null);
    const p = progress.getFilePath();
    expect(p).toBe(path.join(tmpDir, '.vcp', 'plan', '.state', `stage-progress-discovery-${process.pid}.json`));
  });

  test('omitted slugHint defaults to legacy flat path (backwards compat)', () => {
    const tmpDir = makeTmpDir();
    const progress = new StageProgress('discovery', makeExecutors(1), tmpDir);
    const p = progress.getFilePath();
    expect(p).toBe(path.join(tmpDir, '.vcp', 'plan', '.state', `stage-progress-discovery-${process.pid}.json`));
  });

  test('single-executor stage does not write stderr progress lines', () => {
    const tmpDir = makeTmpDir();
    const origWrite = process.stderr.write;
    let stderrCalled = false;
    process.stderr.write = (() => { stderrCalled = true; return true; }) as any;
    try {
      const progress = new StageProgress('ralph-build', makeExecutors(1), tmpDir);
      progress.markRunning(0);
      progress.markDone(0, 5);
      expect(stderrCalled).toBe(false);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test('multi-executor stage writes stderr progress lines', () => {
    const tmpDir = makeTmpDir();
    const origWrite = process.stderr.write;
    const lines: string[] = [];
    process.stderr.write = ((chunk: string) => { lines.push(chunk); return true; }) as any;
    try {
      const progress = new StageProgress('discovery', makeExecutors(3), tmpDir);
      progress.markRunning(0);
      progress.markDone(0, 10);
      progress.markRunning(1);
      progress.markFailed(1, 30);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('[1/3]');
      expect(lines[0]).toContain('done (10s)');
      expect(lines[1]).toContain('[2/3]');
      expect(lines[1]).toContain('failed (30s)');
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ─── runExecutorWithProgress ──────────────────────────────────────────────

describe('runExecutorWithProgress', () => {
  // We can't easily test with real dispatchExecutor (needs real subprocess),
  // so we test the wrapper's integration with StageProgress by mocking
  // dispatchExecutor at the module level. Instead, verify the contract:
  // the wrapper should update progress and return the dispatch result.

  // Note: These are contract tests verifying the wrapper's behavior with
  // a real StageProgress instance (file I/O) but without real subprocesses.
});

// ─── buildSubscriptionArgs ────────────────────────────────────────────────

describe('buildSubscriptionArgs', () => {
  test('uses --allowed-tools flag (not --tools) when allowedTools is non-empty', () => {
    const args = buildSubscriptionArgs({
      model: 'sonnet',
      systemPrompt: 'sys',
      allowedTools: 'Read,Write,Edit,Bash,Glob,Grep',
      task: 'do the thing',
    });
    expect(args).toContain('--allowed-tools');
    expect(args).not.toContain('--tools');
  });

  test('inserts `--` terminator immediately before the task positional', () => {
    // Regression for the variadic-consumption bug: `--allowed-tools <tools...>`
    // is declared variadic in the Claude CLI's argparse, so without `--` the
    // trailing task is swallowed into the tools list and `-p` errors with
    // "Input must be provided either through stdin or as a prompt argument".
    const args = buildSubscriptionArgs({
      model: 'sonnet',
      systemPrompt: 'sys',
      allowedTools: 'Read,Bash',
      task: 'do the thing',
    });
    const dashDashIdx = args.indexOf('--');
    const taskIdx = args.indexOf('do the thing');
    expect(dashDashIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBe(dashDashIdx + 1);
    // Nothing should appear after the task
    expect(args.length).toBe(taskIdx + 1);
  });

  test('inserts `--` terminator even when allowedTools is empty', () => {
    // Defensive: if a future stage has no tool restriction, we still want the
    // terminator so a task string that happens to start with `-` is not
    // mis-parsed as a flag.
    const args = buildSubscriptionArgs({
      model: 'sonnet',
      systemPrompt: 'sys',
      allowedTools: '',
      task: '--this-looks-like-a-flag',
    });
    expect(args).not.toContain('--allowed-tools');
    const dashDashIdx = args.indexOf('--');
    expect(dashDashIdx).toBe(args.length - 2);
    expect(args[args.length - 1]).toBe('--this-looks-like-a-flag');
  });

  test('includes -p, --model, --system-prompt, --output-format json, --permission-mode bypassPermissions', () => {
    const args = buildSubscriptionArgs({
      model: 'sonnet',
      systemPrompt: 'you are a reviewer',
      allowedTools: 'Read',
      task: 'review this',
    });
    expect(args[0]).toBe('-p');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args).toContain('--system-prompt');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('you are a reviewer');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  });

  test('does NOT include --bare (would force ANTHROPIC_API_KEY auth and break OAuth subscription)', () => {
    // Regression: --bare explicitly ignores OAuth / keychain, forcing
    // ANTHROPIC_API_KEY or apiKeyHelper. Subscription presets depend on
    // `claude /login`, so any subscription dispatch built with --bare
    // errors with "Not logged in · Please run /login".
    const args = buildSubscriptionArgs({
      model: 'sonnet',
      systemPrompt: 'sys',
      allowedTools: 'Read',
      task: 'do thing',
    });
    expect(args).not.toContain('--bare');
  });

  test('task containing spaces is preserved as a single argv element', () => {
    const args = buildSubscriptionArgs({
      model: 'sonnet',
      systemPrompt: 'sys',
      allowedTools: 'Bash',
      task: 'do the thing with multiple words',
    });
    expect(args[args.length - 1]).toBe('do the thing with multiple words');
  });
});
