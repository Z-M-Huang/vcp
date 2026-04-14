import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  parseBuildLoopArgs,
  upsertMetadataLine,
  replaceOrAppendSection,
  writeUnitStatus,
  extractBackpressureCommands,
  resolveUnitPath,
  runSingleUnit,
  parseReviewVerdict,
  readFilesTouched,
} from '../build-loop-runner.ts';
import type { UnitReviewResult } from '../ralph/types.ts';


// ─── Temp directory management ─────────────────────────────────────────────

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true })); });

function makeTmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'blr-test-'));
  tmpDirs.push(d);
  return d;
}

// ─── parseBuildLoopArgs ────────────────────────────────────────────────────

describe('parseBuildLoopArgs', () => {
  test('parses --plan, --cwd, and --unit', () => {
    const result = parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a/b.md', '--cwd', '/c/d', '--unit', '13']);
    expect(result.planPath).toBe('/a/b.md');
    expect(result.cwd).toBe('/c/d');
    expect(result.unitId).toBe(13);
  });

  test('throws when --plan missing', () => {
    expect(() => parseBuildLoopArgs(['node', 'script.ts', '--cwd', '/c', '--unit', '1'])).toThrow('--plan');
  });

  test('throws when --cwd missing', () => {
    expect(() => parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a', '--unit', '1'])).toThrow('--cwd');
  });

  test('throws when --unit missing', () => {
    expect(() => parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a', '--cwd', '/c'])).toThrow('--unit');
  });

  test('throws when --unit is not a positive integer', () => {
    expect(() => parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a', '--cwd', '/c', '--unit', 'abc'])).toThrow('Invalid --unit');
    expect(() => parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a', '--cwd', '/c', '--unit', '0'])).toThrow('Invalid --unit');
    expect(() => parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a', '--cwd', '/c', '--unit', '-1'])).toThrow('Invalid --unit');
  });
});

// ─── upsertMetadataLine ───────────────────────────────────────────────────

describe('upsertMetadataLine', () => {
  test('replaces existing field', () => {
    const content = '# Unit 1: Test\n**Status:** pending\nSome text';
    const result = upsertMetadataLine(content, 'Status', 'done');
    expect(result).toContain('**Status:** done');
    expect(result).not.toContain('pending');
  });

  test('inserts after title when field absent', () => {
    const content = '# Unit 1: Test\nSome text';
    const result = upsertMetadataLine(content, 'Status', 'done');
    expect(result).toContain('**Status:** done');
    // Should be between title and body
    const lines = result.split('\n');
    expect(lines[0]).toBe('# Unit 1: Test');
    expect(lines[1]).toBe('**Status:** done');
  });

  test('prepends when no title exists', () => {
    const content = 'Just text';
    const result = upsertMetadataLine(content, 'Status', 'done');
    expect(result.startsWith('**Status:** done')).toBe(true);
  });

  test('replaces Attempts field', () => {
    const content = '# Unit 1\n**Status:** pending\n**Attempts:** 1';
    const result = upsertMetadataLine(content, 'Attempts', '2');
    expect(result).toContain('**Attempts:** 2');
    expect(result).not.toContain('**Attempts:** 1');
  });
});

// ─── replaceOrAppendSection ───────────────────────────────────────────────

describe('replaceOrAppendSection', () => {
  test('appends section when absent', () => {
    const content = '# Unit 1: Test\nSome text';
    const result = replaceOrAppendSection(content, '## Latest Build Attempt', 'Attempt 1 result');
    expect(result).toContain('## Latest Build Attempt');
    expect(result).toContain('Attempt 1 result');
  });

  test('replaces existing section body', () => {
    const content = '# Unit 1\n\n## Latest Build Attempt\n\nOld result\n\n## Done When\nAll pass.';
    const result = replaceOrAppendSection(content, '## Latest Build Attempt', 'New result');
    expect(result).toContain('New result');
    expect(result).not.toContain('Old result');
    expect(result).toContain('## Done When');
  });
});

// ─── writeUnitStatus ──────────────────────────────────────────────────────

describe('writeUnitStatus', () => {
  test('writes status and attempts to real file', () => {
    const tmp = makeTmpDir();
    const unitPath = path.join(tmp, 'unit-1.md');
    writeFileSync(unitPath, '# Unit 1: Test\n\n### Backpressure\n- `bun test`\n### Done When\nAll pass.');
    writeUnitStatus(unitPath, { status: 'done', attempts: 1, appendResult: 'All passed.' });
    const content = readFileSync(unitPath, 'utf-8');
    expect(content).toContain('**Status:** done');
    expect(content).toContain('**Attempts:** 1');
    expect(content).toContain('## Latest Build Attempt');
    expect(content).toContain('All passed.');
  });

  test('is idempotent — replaces on second write', () => {
    const tmp = makeTmpDir();
    const unitPath = path.join(tmp, 'unit-1.md');
    writeFileSync(unitPath, '# Unit 1: Test\n**Status:** pending\n**Attempts:** 0');
    writeUnitStatus(unitPath, { status: 'pending', attempts: 1, appendResult: 'Attempt 1 started.' });
    writeUnitStatus(unitPath, { status: 'done', attempts: 1, appendResult: 'Attempt 1 passed.' });
    const content = readFileSync(unitPath, 'utf-8');
    expect(content).toContain('**Status:** done');
    expect(content).toContain('**Attempts:** 1');
    expect(content).toContain('Attempt 1 passed.');
    // Should not contain the old attempt text as the main content
    expect(content).not.toContain('Attempt 1 started.');
  });
});

// ─── extractBackpressureCommands ──────────────────────────────────────────

describe('extractBackpressureCommands', () => {
  test('extracts from ## Backpressure', () => {
    const content = '# Unit 1\n## Backpressure\n- `bun test`\n- `bun run build`\n## Done When';
    expect(extractBackpressureCommands(content)).toEqual(['bun test', 'bun run build']);
  });

  test('extracts from ### Backpressure', () => {
    const content = '# Unit 1\n### Backpressure\n- `bun test src/foo.test.ts`\n### Done When';
    expect(extractBackpressureCommands(content)).toEqual(['bun test src/foo.test.ts']);
  });

  test('returns empty when no section', () => {
    expect(extractBackpressureCommands('# Unit 1\n## Done When\nAll pass.')).toEqual([]);
  });

  test('returns empty for empty section', () => {
    const content = '# Unit 1\n### Backpressure\n\n### Done When';
    expect(extractBackpressureCommands(content)).toEqual([]);
  });
});

// ─── resolveUnitPath ──────────────────────────────────────────────────────

describe('resolveUnitPath', () => {
  test('resolves unit path from plan path', () => {
    const result = resolveUnitPath('/proj/.vcp/plan/ralph-dense-mem.md', 13);
    expect(result.slug).toBe('dense-mem');
    expect(result.unitPath).toBe('/proj/.vcp/plan/ralph/dense-mem/unit-13.md');
  });

  test('throws for invalid plan filename', () => {
    expect(() => resolveUnitPath('/proj/.vcp/plan/bad-name.md', 1)).toThrow('Cannot extract slug');
  });
});

// ─── runSingleUnit integration tests ────────────────────────────────────

/** Create a minimal valid unit plan file. */
function makeUnitPlan(id: number, opts: {
  status?: string; dependsOn?: string; attempts?: number; maxAttempts?: number;
  backpressureCommands?: string[];
} = {}): string {
  const status = opts.status ?? 'pending';
  const deps = opts.dependsOn ?? 'none';
  const attempts = opts.attempts ?? 0;
  const maxAttempts = opts.maxAttempts ?? 3;
  const bpCmds = opts.backpressureCommands ?? ['bun test'];
  return [
    `# Unit ${id}: Test Unit ${id}`,
    '',
    `**Status:** ${status}`,
    `**Attempts:** ${attempts}`,
    `**Max Attempts:** ${maxAttempts}`,
    `**Depends On:** ${deps}`,
    '',
    '### Entropy', 'Low', '',
    '### Acceptance Criteria', '- AC-1: Test', '',
    '### Interface Contract', '```typescript\nfunction test(): void\n```', '',
    '### Test Stubs', '```typescript\ntest("works", () => {})\n```', '',
    '### What to Implement', 'Implement the thing.', '',
    '### Files to Touch', '- `src/test.ts` -- existing | modify', '',
    '### Backpressure',
    ...bpCmds.map(c => `- \`${c}\``),
    '',
    '### Done When', 'All backpressure commands pass.', '',
  ].join('\n');
}

/** Set up a project directory with plan file, state, and unit files. */
function setupProject(unitPlans: string[]): { projectDir: string; planPath: string; slug: string } {
  const projectDir = makeTmpDir();
  const slug = 'test-build';
  const planDir = path.join(projectDir, '.vcp', 'plan');
  const stateDir = path.join(planDir, '.state');
  const unitsDir = path.join(planDir, 'ralph', slug);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(unitsDir, { recursive: true });

  // Write plan file
  const planPath = path.join(planDir, `ralph-${slug}.md`);
  const unitTable = unitPlans.map((_, i) => `| ${i + 1} | Test Unit ${i + 1} | AC-1 | — | Low |`).join('\n');
  writeFileSync(planPath, [
    '# Test Feature',
    '**Status:** build',
    '## Discovery', 'Found things.',
    '## Requirements', '### AC-1: Test', '### UAT-1: Test',
    '## Units of Work',
    '| Unit | Title | ACs | Depends On | Entropy |',
    '|------|-------|-----|------------|---------|',
    unitTable,
  ].join('\n'));

  // Write unit files
  for (let i = 0; i < unitPlans.length; i++) {
    writeFileSync(path.join(unitsDir, `unit-${i + 1}.md`), unitPlans[i]);
  }

  // Write state file
  const state = {
    slug,
    status: 'build',
    outerIteration: 0,
    reviewIteration: 0,
    units: [],
    lastAction: 'next',
    lastTimestamp: new Date().toISOString(),
    taskIds: {},
  };
  writeFileSync(path.join(stateDir, `ralph-${slug}.json`), JSON.stringify(state, null, 2));

  return { projectDir, planPath, slug };
}

describe('runSingleUnit', () => {
  /** Skip review — avoids hitting real config/subprocess in unit tests */
  const skipReview = async () => ({ skipped: true, passed: true, feedback: '' } as UnitReviewResult);

  test('unit passes on first attempt', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Implemented.' }),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
        reviewFn: skipReview,
      },
    );

    expect(result.event).toBe('unit_done');
    expect(result.outcome).toBe('done');
    expect(result.attempt).toBe(1);
    expect(result.unitId).toBe(1);
  });

  test('unit retries then passes', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 3 })]);

    let callCount = 0;
    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => {
          callCount++;
          return { event: 'complete', stage: 'ralph-build', synthesis: 'Implemented.' };
        },
        backpressureFn: () => {
          // Fail first 2, pass on 3rd
          return [{ command: 'bun test', exitCode: callCount < 3 ? 1 : 0, stdout: '', stderr: '', passed: callCount >= 3 }];
        },
        reviewFn: skipReview,
      },
    );

    expect(result.event).toBe('unit_done');
    expect(result.attempt).toBe(3);
    expect(callCount).toBe(3);
  });

  test('unit exhausts all attempts', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 2 })]);

    let callCount = 0;
    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => {
          callCount++;
          return { event: 'complete', stage: 'ralph-build', synthesis: 'Implemented.' };
        },
        backpressureFn: () => [{ command: 'bun test', exitCode: 1, stdout: '', stderr: 'fail', passed: false }],
      },
    );

    expect(result.event).toBe('unit_failed');
    expect(result.attempt).toBe(2);
    expect(callCount).toBe(2);
  });

  test('already exhausted — dispatch not called', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { attempts: 2, maxAttempts: 2 })]);

    let dispatchCalled = false;
    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => { dispatchCalled = true; return { event: 'complete', stage: 'ralph-build' }; },
        backpressureFn: () => [],
      },
    );

    expect(result.event).toBe('unit_failed');
    expect(dispatchCalled).toBe(false);
  });

  test('already done — returns unit_error', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { status: 'done', attempts: 1 })]);

    let dispatchCalled = false;
    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => { dispatchCalled = true; return { event: 'complete', stage: 'ralph-build' }; },
        backpressureFn: () => [],
      },
    );

    expect(result.event).toBe('unit_error');
    expect(result.error).toContain('already done');
    expect(dispatchCalled).toBe(false);
  });

  test('already failed — returns unit_error', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { status: 'failed', attempts: 3 })]);

    let dispatchCalled = false;
    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => { dispatchCalled = true; return { event: 'complete', stage: 'ralph-build' }; },
        backpressureFn: () => [],
      },
    );

    expect(result.event).toBe('unit_error');
    expect(result.error).toContain('already failed');
    expect(dispatchCalled).toBe(false);
  });

  test('dispatch error with retries left — continues to next attempt', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 2 })]);

    let callCount = 0;
    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => {
          callCount++;
          if (callCount === 1) {
            return { event: 'error', stage: 'ralph-build', phase: 'dispatch_failed', error: 'stage-runner crashed' };
          }
          return { event: 'complete', stage: 'ralph-build', synthesis: 'OK' };
        },
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
        reviewFn: skipReview,
      },
    );

    expect(result.event).toBe('unit_done');
    expect(result.attempt).toBe(2);
    expect(callCount).toBe(2);
  });

  test('dispatch error exhausted', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 1 })]);

    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({
          event: 'error',
          stage: 'ralph-build',
          phase: 'dispatch_failed',
          error: 'stage-runner crashed',
        }),
        backpressureFn: () => [],
      },
    );

    expect(result.event).toBe('unit_failed');
    expect(result.attempt).toBe(1);
  });

  test('zero backpressure commands — hard failure', async () => {
    const { projectDir, planPath } = setupProject([
      makeUnitPlan(1, { backpressureCommands: [], maxAttempts: 1 }),
    ]);

    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' }),
        backpressureFn: () => [],
      },
    );

    expect(result.event).toBe('unit_failed');
    expect(result.outcome).toBe('failed');
  });

  test('unit file not found — returns unit_error', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 99 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build' }),
        backpressureFn: () => [],
      },
    );

    expect(result.event).toBe('unit_error');
    expect(result.error).toContain('not found');
  });

  test('config cap overrides unit maxAttempts', async () => {
    // Unit says maxAttempts: 10, but config caps at 3 (default)
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 10 })]);

    let callCount = 0;
    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => {
          callCount++;
          return { event: 'complete', stage: 'ralph-build', synthesis: 'Done.' };
        },
        backpressureFn: () => [{ command: 'bun test', exitCode: 1, stdout: '', stderr: 'fail', passed: false }],
      },
    );

    // Config max_build_attempts caps the unit's maxAttempts (10) — effective max is config value
    expect(result.event).toBe('unit_failed');
    expect(callCount).toBeLessThan(10);
    expect(result.attempt).toBe(callCount);
    expect(result.maxAttempts).toBeLessThan(10);
  });
});

// ─── parseReviewVerdict ──────────────────────────────────────────────────

describe('parseReviewVerdict', () => {
  test('parses PASS verdict', () => {
    const result = parseReviewVerdict('## Verdict: PASS\n\nAll ACs traced.');
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe('');
  });

  test('parses NEEDS_CHANGES with review feedback section', () => {
    const output = [
      '## Verdict: NEEDS_CHANGES',
      '',
      '## Review Feedback',
      '',
      '- AC-1 violated (src/foo.ts:42): missing error handling',
      '- Contract mismatch (src/bar.ts:10): returns void instead of Promise',
    ].join('\n');
    const result = parseReviewVerdict(output);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('AC-1 violated');
    expect(result.feedback).toContain('Contract mismatch');
  });

  test('fail-open on malformed output', () => {
    const result = parseReviewVerdict('This is garbage output with no verdict heading');
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe('');
  });

  test('handles case-insensitive verdict', () => {
    expect(parseReviewVerdict('## verdict: pass').passed).toBe(true);
    expect(parseReviewVerdict('## VERDICT: NEEDS_CHANGES\nSome feedback').passed).toBe(false);
  });
});

// ─── readFilesTouched ──────────────────────────────────────────────────

describe('readFilesTouched', () => {
  test('reads existing files from Files to Touch section', () => {
    const tmp = makeTmpDir();
    mkdirSync(path.join(tmp, 'src'), { recursive: true });
    writeFileSync(path.join(tmp, 'src', 'foo.ts'), 'export function foo() {}');
    const unitContent = '### Files to Touch\n- `src/foo.ts` -- existing | modify\n### Done When';
    const result = readFilesTouched(unitContent, tmp);
    expect(result).toContain('### File: src/foo.ts');
    expect(result).toContain('export function foo()');
  });

  test('marks missing files as NOT FOUND', () => {
    const tmp = makeTmpDir();
    const unitContent = '### Files to Touch\n- `src/missing.ts` -- new | create\n### Done When';
    const result = readFilesTouched(unitContent, tmp);
    expect(result).toContain('NOT FOUND');
  });

  test('returns empty for content without Files to Touch', () => {
    expect(readFilesTouched('# Unit 1\n### Done When', '/tmp')).toBe('');
  });
});

// ─── runSingleUnit with review ────────────────────────────────────────

describe('runSingleUnit with review', () => {
  /** Helper: review returns skipped (disabled) */
  const skippedReview: () => Promise<UnitReviewResult> = async () => ({ skipped: true, passed: true, feedback: '' });
  /** Helper: review passes */
  const passingReview: () => Promise<UnitReviewResult> = async () => ({ skipped: false, passed: true, feedback: '' });
  /** Helper: review fails */
  const failingReview = (feedback: string): (() => Promise<UnitReviewResult>) =>
    async () => ({ skipped: false, passed: false, feedback });

  test('review disabled (skipped) — unit_done same as before', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' }),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
        reviewFn: skippedReview,
      },
    );

    expect(result.event).toBe('unit_done');
    expect(result.outcome).toBe('done');
  });

  test('review passes — unit_done', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' }),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
        reviewFn: passingReview,
      },
    );

    expect(result.event).toBe('unit_done');
  });

  test('review fails then passes on retry', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 3 })]);

    let reviewCallCount = 0;
    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' }),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
        reviewFn: async () => {
          reviewCallCount++;
          if (reviewCallCount === 1) return { skipped: false, passed: false, feedback: 'AC-1 not met' };
          return { skipped: false, passed: true, feedback: '' };
        },
      },
    );

    expect(result.event).toBe('unit_done');
    expect(result.attempt).toBe(2);
    expect(reviewCallCount).toBe(2);
  });

  test('review fails and budget exhausted — unit_failed', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 1 })]);

    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' }),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
        reviewFn: failingReview('AC-2 violated: returns wrong type'),
      },
    );

    expect(result.event).toBe('unit_failed');
    expect(result.attempt).toBe(1);
    expect(result.summary).toContain('failed review');
  });

  test('review feedback written to unit file on failure', async () => {
    const { projectDir, planPath, slug } = setupProject([makeUnitPlan(1, { maxAttempts: 2 })]);

    let reviewCallCount = 0;
    await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' }),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
        reviewFn: async () => {
          reviewCallCount++;
          if (reviewCallCount === 1) return { skipped: false, passed: false, feedback: 'Missing error handling' };
          return { skipped: false, passed: true, feedback: '' };
        },
      },
    );

    // After success, review feedback should be cleared
    const unitPath = path.join(projectDir, '.vcp', 'plan', 'ralph', slug, 'unit-1.md');
    const content = readFileSync(unitPath, 'utf-8');
    // Feedback section should be empty (cleared on success)
    const feedbackMatch = content.match(/## Review Feedback\s*\n\n([\s\S]*?)(?=\n##|\n*$)/);
    if (feedbackMatch) {
      expect(feedbackMatch[1].trim()).toBe('');
    }
  });

  test('review dispatch error (fail-open) — unit_done', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' }),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
        reviewFn: async () => { throw new Error('subprocess crashed'); },
      },
    );

    // Fail-open: review throws but unit still passes
    expect(result.event).toBe('unit_done');
  });
});
