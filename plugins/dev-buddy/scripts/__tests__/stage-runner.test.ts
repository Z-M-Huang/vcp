import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  buildStageTask,
  segmentExecutors,
  parseArgs,
  type Segment,
} from '../stage-runner.ts';
import type { StageExecutor } from '../../types/pipeline.ts';

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
    const result = buildStageTask('discovery', 'Build a login page', '/nonexistent/plan.md');
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

    const result = buildStageTask('ralph-requirements', 'Build a login page', planPath);
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

    const result = buildStageTask('decomposition', 'Build a login page', planPath);
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

    const result = buildStageTask('decomposition', 'Build a login page', planPath);
    expect(result).toContain('AC-1: Login form validates email');
    expect(result).toContain('UAT-1: Login flow');
    expect(result).toContain('Prior Requirements');
  });

  test('missing plan file returns feature description only for requirements/decompose', () => {
    const result = buildStageTask('ralph-requirements', 'Build a login page', '/nonexistent/plan.md');
    expect(result).toBe('Build a login page');
  });

  test('plan file missing Discovery section returns feature only for requirements', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, '# Feature: Auth\n\n## Status\n\nSome status text.\n');

    const result = buildStageTask('ralph-requirements', 'Build a login page', planPath);
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

    const result = buildStageTask('decomposition', 'Build a login page', planPath);
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

    const result = buildStageTask('discovery', 'Build a login page', planPath);
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

    const result = buildStageTask('discovery', 'Build a login page', planPath);
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

    const result = buildStageTask('ralph-requirements', 'Build a login page', planPath);
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

    const result = buildStageTask('decomposition', 'Build a login page', planPath);
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

    const result = buildStageTask('ralph-requirements', 'Build a login page', planPath);
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

    const result = buildStageTask('decomposition', 'Build a login page', planPath);
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
    expect(cp.approveStatus).toBe('build');
  });
});
