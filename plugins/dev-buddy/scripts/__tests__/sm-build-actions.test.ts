import { describe, test, expect, afterAll, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

// Stub loadDevBuddyConfig BEFORE importing ralph-state-machine so
// isUnitReviewEnabled reads our injected stage map. Tests mutate
// `mockConfig.stages['unit-review'].executors` between cases.
const mockConfig = {
  version: '5.0',
  stages: {
    'discovery': { executors: [{ system_prompt: 'discoverer', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'ralph-requirements': { executors: [{ system_prompt: 'ralph-requirements-analyst', preset: 'anthropic-subscription', model: 'opus' }] },
    'decomposition': { executors: [{ system_prompt: 'decomposer', preset: 'anthropic-subscription', model: 'opus' }] },
    'ralph-build': { executors: [{ system_prompt: 'unit-builder', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'ralph-code-review': { executors: [{ system_prompt: 'ralph-code-reviewer', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'ralph-uat': { executors: [{ system_prompt: 'uat-evaluator', preset: 'anthropic-subscription', model: 'sonnet' }] },
    'unit-review': { executors: [] as Array<{ system_prompt: string; preset: string; model: string }> },
    'plan-lint': { executors: [] },
  },
  pipelines: { ralph: ['discovery', 'ralph-requirements', 'decomposition', 'ralph-build', 'ralph-code-review', 'ralph-uat'] },
  max_iterations: 10,
  max_build_attempts: 3,
  max_outer_iterations: 3,
};

mock.module('../pipeline-config.ts', () => ({
  loadDevBuddyConfig: () => mockConfig,
  CONFIG_PATH: '/tmp/mock-config-not-used',
}));

const {
  composeBuildDispatch,
  recordAttemptResultAction,
  recordReviewResultAction,
} = await import('../ralph-state-machine.ts');
const {
  ensurePlanStateSeeded,
  ensureUnitStateSeeded,
  readUnitState,
  reserveAttempt,
} = await import('../ralph/unit-state.ts');

function setUnitReviewEnabled(enabled: boolean): void {
  mockConfig.stages['unit-review'].executors = enabled
    ? [{ system_prompt: 'ralph-code-reviewer', preset: 'anthropic-subscription', model: 'sonnet' }]
    : [];
}

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true })); });

function makeTmpDir(label: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), `sm-build-${label}-`));
  tmpDirs.push(d);
  return d;
}

const VALID_UNIT = `# Unit 1: test
**Status:** pending
**Attempts:** 0
**Max Attempts:** 3
- Depends on: none
### Entropy
L
### Acceptance Criteria
- ac1
### Interface Contract
- x
### Test Stubs
- stub
### What to Implement
- thing
### Files to Touch
- a.ts
### Backpressure
\`\`\`bash
bun test
\`\`\`
### Done When
- done
`;

function seedUnit(projectDir: string, slug: string, unitId: number, maxAttempts = 3): void {
  const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
  mkdirSync(unitsDir, { recursive: true });
  writeFileSync(path.join(unitsDir, `unit-${unitId}.md`), VALID_UNIT);
  const plan = ensurePlanStateSeeded(projectDir, slug, 'build', 'test-seed');
  ensureUnitStateSeeded(projectDir, slug, unitId, plan.decomposeRunId, maxAttempts, {
    status: 'pending',
    attempts: 0,
  });
}

describe('recordAttemptResultAction — fix #1: no double-terminal transition', () => {

  test('mechanical_fail at exhaustion marks unit failed without throwing', () => {
    const tmp = makeTmpDir('fail-exhaust');
    const slug = 'test';
    seedUnit(tmp, slug, 1, 1); // maxAttempts=1 so first fail is exhaustion

    const reservation = reserveAttempt(tmp, slug, 1, 0);

    const result = recordAttemptResultAction(tmp, slug, {
      unitId: 1,
      lease: reservation.lease,
      outcome: 'mechanical_fail',
      mechanicalContext: {
        source: 'backpressure',
        command: 'bun test',
        exitCode: 1,
        stdoutHead: '', stdoutTail: '', stderrHead: '', stderrTail: 'err',
      },
    });

    expect(result.nextAction).toBe('unit_failed');
    const after = readUnitState(tmp, slug, 1)!;
    expect(after.status).toBe('failed');
    expect(after.reservedAttempt).toBeUndefined();
  });

  test('review pass marks unit done without throwing', async () => {
    const tmp = makeTmpDir('review-pass');
    const slug = 'test';
    seedUnit(tmp, slug, 1, 3);

    const reservation = reserveAttempt(tmp, slug, 1, 0);

    const result = await recordReviewResultAction(
      tmp, slug,
      { unitId: 1, lease: reservation.lease, passed: true, feedback: '' },
      false,
    );

    expect(result.nextAction).toBe('unit_done');
    const after = readUnitState(tmp, slug, 1)!;
    expect(after.status).toBe('done');
    expect(after.reservedAttempt).toBeUndefined();
  });

  test('review fail at exhaustion marks unit failed without throwing', async () => {
    const tmp = makeTmpDir('review-fail-exhaust');
    const slug = 'test';
    seedUnit(tmp, slug, 1, 1); // maxAttempts=1

    const reservation = reserveAttempt(tmp, slug, 1, 0);

    const result = await recordReviewResultAction(
      tmp, slug,
      { unitId: 1, lease: reservation.lease, passed: false, feedback: 'needs changes' },
      false,
    );

    expect(result.nextAction).toBe('unit_failed');
    const after = readUnitState(tmp, slug, 1)!;
    expect(after.status).toBe('failed');
  });

  test('mechanical_fail with attempts remaining returns retry_unit and leaves status pending', () => {
    const tmp = makeTmpDir('retry');
    const slug = 'test';
    seedUnit(tmp, slug, 1, 3);

    const reservation = reserveAttempt(tmp, slug, 1, 0);

    const result = recordAttemptResultAction(tmp, slug, {
      unitId: 1,
      lease: reservation.lease,
      outcome: 'mechanical_fail',
      mechanicalContext: {
        source: 'dispatch',
        command: 'stage-runner',
        exitCode: 2,
        stdoutHead: '', stdoutTail: '', stderrHead: '', stderrTail: 'boom',
      },
    });

    expect(result.nextAction).toBe('retry_unit');
    const after = readUnitState(tmp, slug, 1)!;
    expect(after.status).toBe('pending');
  });
});

describe('recordAttemptResultAction — fix #2: unit-review disabled short-circuits', () => {
  test('mechanical_pass returns unit_done when unit-review executors are empty', () => {
    setUnitReviewEnabled(false);
    const tmp = makeTmpDir('no-review');
    const slug = 'test';
    seedUnit(tmp, slug, 1, 3);

    const reservation = reserveAttempt(tmp, slug, 1, 0);

    const result = recordAttemptResultAction(tmp, slug, {
      unitId: 1,
      lease: reservation.lease,
      outcome: 'mechanical_pass',
    });

    expect(result.nextAction).toBe('unit_done');
    const after = readUnitState(tmp, slug, 1)!;
    expect(after.status).toBe('done');
  });

  test('mechanical_pass returns dispatch_unit_review when executors configured', () => {
    setUnitReviewEnabled(true);
    const tmp = makeTmpDir('yes-review');
    const slug = 'test';
    seedUnit(tmp, slug, 1, 3);

    const reservation = reserveAttempt(tmp, slug, 1, 0);

    const result = recordAttemptResultAction(tmp, slug, {
      unitId: 1,
      lease: reservation.lease,
      outcome: 'mechanical_pass',
    });

    expect(result.nextAction).toBe('dispatch_unit_review');
    const after = readUnitState(tmp, slug, 1)!;
    expect(after.status).toBe('building');
    expect(after.reservedAttempt).toBeDefined();
  });
});

describe('composeBuildDispatch — fix #6: stale reservation recovery', () => {

  test('abandons stale reservation and reserves fresh attempt', () => {
    const tmp = makeTmpDir('stale-resv');
    const slug = 'test';
    seedUnit(tmp, slug, 1, 3);

    // First reservation: simulate a crashed dispatch by backdating reservedAt
    // past MAX_DISPATCH_MS (30 min).
    reserveAttempt(tmp, slug, 1, 0);
    const unitPath = path.join(tmp, '.vcp', 'plan', '.state', `ralph-${slug}`, 'units', 'unit-1.json');
    const state = JSON.parse(readFileSync(unitPath, 'utf-8'));
    expect(state.reservedAttempt).toBeDefined();
    state.reservedAttempt.reservedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(unitPath, JSON.stringify(state));

    // composeBuildDispatch should detect the stale reservation, abandon it,
    // and issue a fresh one without throwing.
    const dispatch = composeBuildDispatch(tmp, slug, 1);
    expect(dispatch.lease).toBeDefined();
    expect(dispatch.lease.length).toBeGreaterThan(0);

    const after = readUnitState(tmp, slug, 1)!;
    // A fresh reservation exists; the stale one is gone
    expect(after.reservedAttempt).toBeDefined();
    expect(after.reservedAttempt!.lease).toBe(dispatch.lease);
    // AttemptHistory records the abandoned attempt
    const abandoned = after.attemptHistory.find(a => a.outcome === 'abandoned');
    expect(abandoned).toBeDefined();
  });
});
