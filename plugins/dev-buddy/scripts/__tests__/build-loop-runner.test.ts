import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  parseBuildLoopArgs,
  upsertMetadataLine,
  replaceOrAppendSection,
  splitUnitFile,
  composeBuildDispatchPrompt,
  composeBuildDispatchPromptFromUnitFile,
  extractBackpressureCommands,
  resolveUnitPath,
  runSingleAttempt,
  parseReviewVerdict,
  readFilesTouched,
  buildMechanicalContext,
} from '../build-loop-runner.ts';
import { RUNNER_TAIL_MARKER, demoteFeedbackHeadings } from '../ralph/unit-file.ts';
import type {
  LatestAttemptState,
  MechanicalContext,
  UnitBuildDispatchResult,
  BackpressureResult,
} from '../ralph/types.ts';

// ─── Fixture helpers ───────────────────────────────────────────────────────

function makeMechanicalContext(overrides: Partial<MechanicalContext> = {}): MechanicalContext {
  return {
    source: 'dispatch',
    command: 'bun test',
    exitCode: 1,
    stdoutHead: '',
    stdoutTail: 'FAIL src/foo.test.ts > unit-1 > null check',
    stderrHead: '',
    stderrTail: 'error TS2345: null not assignable',
    ...overrides,
  };
}

function makeLatestAttempt(overrides: Partial<LatestAttemptState> = {}): LatestAttemptState {
  return {
    attempt: 1,
    dispatchEvent: 'complete',
    dispatchError: null,
    backpressure: [],
    outcome: 'retry',
    mechanicalContext: makeMechanicalContext(),
    ...overrides,
  };
}


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

  test('parses optional --lease flag', () => {
    const result = parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a/b.md', '--cwd', '/c', '--unit', '1', '--lease', 'tok-abc']);
    expect(result.lease).toBe('tok-abc');
  });

  test('lease is undefined when not provided', () => {
    const result = parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a/b.md', '--cwd', '/c', '--unit', '1']);
    expect(result.lease).toBeUndefined();
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


describe('splitUnitFile', () => {
  test('marker present: static plan = before marker, feedback = body of ## Review Feedback in tail', () => {
    const content = [
      '# Unit 1',
      '### Done When',
      'pass.',
      '',
      RUNNER_TAIL_MARKER,
      '## Review Feedback',
      'AC-1 violated at src/foo.ts:42',
      '',
      '## Latest Build Attempt',
      'attempt body',
    ].join('\n');
    const { staticPlan, reviewFeedback } = splitUnitFile(content);
    expect(staticPlan).toContain('### Done When');
    expect(staticPlan).not.toContain(RUNNER_TAIL_MARKER);
    expect(staticPlan).not.toContain('## Review Feedback');
    expect(reviewFeedback).toContain('AC-1 violated');
  });

  test('no marker, has Done When: static plan ends after Done When section', () => {
    const content = [
      '# Unit 1',
      '### Done When',
      'pass.',
      '',
      '## Stale Latest Build Attempt',
      'this is stale orphan content',
    ].join('\n');
    const { staticPlan } = splitUnitFile(content);
    expect(staticPlan).toContain('### Done When');
    expect(staticPlan).toContain('pass.');
    expect(staticPlan).not.toContain('Stale Latest Build Attempt');
  });

  test('no marker, no Done When: whole file is static, feedback empty', () => {
    const content = '# Unit 1\nNo headings of interest.';
    const { staticPlan, reviewFeedback } = splitUnitFile(content);
    expect(staticPlan).toContain('No headings of interest.');
    expect(reviewFeedback).toBe('');
  });
});

describe('composeBuildDispatchPrompt (direct API)', () => {
  test('pristine state → priority=none, no review or mechanical blocks', () => {
    const { prompt, priority, feedbackChars, mechanicalChars } =
      composeBuildDispatchPrompt('# Unit 1\n### Done When\npass.', '', null, '/p/u-1.md');
    expect(priority).toBe('none');
    expect(prompt).toContain('--- STATIC UNIT PLAN (authoritative contract');
    expect(prompt).not.toContain('--- PRIOR REVIEW FEEDBACK');
    expect(prompt).not.toContain('--- PRIOR MECHANICAL FAILURE');
    expect(prompt).toMatch(/first attempt for this unit/i);
    expect(feedbackChars).toBe(0);
    expect(mechanicalChars).toBe(0);
  });

  test('review feedback only → priority=review_first, MUST ADDRESS heading', () => {
    const { prompt, priority, feedbackChars, mechanicalChars } =
      composeBuildDispatchPrompt(
        '# Unit 1\n### Done When\npass.',
        'AC-1 violated: missing null check at src/foo.ts:42',
        null,
        '/p/u-1.md',
      );
    expect(priority).toBe('review_first');
    expect(prompt).toContain('--- PRIOR REVIEW FEEDBACK (MUST ADDRESS');
    expect(prompt).toContain('AC-1 violated');
    expect(prompt).not.toContain('--- PRIOR MECHANICAL FAILURE');
    expect(prompt).not.toContain('ADDRESS AFTER MECHANICAL IS GREEN');
    expect(prompt).not.toContain('ADDRESS EVERY FINDING');
    expect(feedbackChars).toBeGreaterThan(0);
    expect(mechanicalChars).toBe(0);
  });

  test('mechanical failure only → priority=mechanical_only, no review block', () => {
    const previousAttempt = makeLatestAttempt({
      mechanicalContext: makeMechanicalContext({
        command: 'go test ./...',
        stdoutTail: 'FAIL: TestFoo (0.00s)\n    foo_test.go:42: expected 1, got 0',
      }),
    });
    const { prompt, priority, mechanicalChars, feedbackChars } =
      composeBuildDispatchPrompt('# Unit 1\n### Done When\npass.', '', previousAttempt, '/p/u-1.md');
    expect(priority).toBe('mechanical_only');
    expect(prompt).toContain('--- PRIOR MECHANICAL FAILURE ---');
    expect(prompt).toContain('Command: go test ./...');
    expect(prompt).toContain('FAIL: TestFoo');
    expect(prompt).not.toContain('--- PRIOR REVIEW FEEDBACK');
    expect(prompt).toMatch(/Restore the green mechanical state/i);
    expect(mechanicalChars).toBeGreaterThan(0);
    expect(feedbackChars).toBe(0);
  });

  test('mechanical + review feedback → REVIEW first, mechanical labeled "address alongside"', () => {
    const { prompt, priority } =
      composeBuildDispatchPrompt(
        '# Unit 1\n### Done When\npass.',
        'AC-2 violated: unchecked array access',
        makeLatestAttempt(),
        '/p/u-1.md',
      );
    expect(priority).toBe('review_first');
    const reviewIdx = prompt.indexOf('--- PRIOR REVIEW FEEDBACK (MUST ADDRESS');
    const mechanicalIdx = prompt.indexOf('--- PRIOR MECHANICAL FAILURE (address alongside the review feedback) ---');
    expect(reviewIdx).toBeGreaterThan(0);
    expect(mechanicalIdx).toBeGreaterThan(reviewIdx);
    expect(prompt).toContain('AC-2 violated');
    // §13: the "ADDRESS AFTER MECHANICAL IS GREEN" demotion is removed
    expect(prompt).not.toContain('ADDRESS AFTER MECHANICAL IS GREEN');
    expect(prompt).not.toContain('ADDRESS EVERY FINDING');
  });

  test('retry outcome without mechanicalContext → falls back to review_first', () => {
    const { prompt, priority } =
      composeBuildDispatchPrompt(
        '# Unit 1\n### Done When\npass.',
        'some review note',
        makeLatestAttempt({ mechanicalContext: null }),
        '/p/u-1.md',
      );
    expect(priority).toBe('review_first');
    expect(prompt).not.toContain('--- PRIOR MECHANICAL FAILURE');
  });

  test('always includes do-not-modify and unit plan path header', () => {
    const { prompt } = composeBuildDispatchPrompt('# Unit 1', '', null, '/path/to/unit-1.md');
    expect(prompt).toMatch(/Do NOT modify the unit plan file/i);
    expect(prompt).toContain('Unit plan path: /path/to/unit-1.md');
  });

  test('static plan is rendered last (stays on-screen as builder reads down)', () => {
    const { prompt } = composeBuildDispatchPrompt(
      '# Unit 1\n### Done When\npass.',
      'AC-1 finding',
      makeLatestAttempt(),
      '/p/u-1.md',
    );
    const reviewIdx = prompt.indexOf('--- PRIOR REVIEW FEEDBACK');
    const mechanicalIdx = prompt.indexOf('--- PRIOR MECHANICAL FAILURE');
    const staticIdx = prompt.indexOf('--- STATIC UNIT PLAN');
    expect(reviewIdx).toBeGreaterThan(-1);
    expect(mechanicalIdx).toBeGreaterThan(reviewIdx);
    expect(staticIdx).toBeGreaterThan(mechanicalIdx);
  });
});

describe('composeBuildDispatchPromptFromUnitFile', () => {
  test('first attempt: no prior-feedback block rendered', () => {
    const content = '# Unit 1\n### Done When\npass.\n';
    const { prompt, staticPlanChars, feedbackChars, priority } =
      composeBuildDispatchPromptFromUnitFile(content, '/path/to/unit-1.md', null);
    expect(priority).toBe('none');
    expect(prompt).toContain('--- STATIC UNIT PLAN (authoritative contract');
    expect(prompt).not.toContain('--- PRIOR REVIEW FEEDBACK');
    expect(prompt).toMatch(/first attempt for this unit/i);
    expect(prompt).toContain('--- INSTRUCTION ---');
    expect(prompt).toContain('Unit plan path: /path/to/unit-1.md');
    expect(staticPlanChars).toBeGreaterThan(0);
    expect(feedbackChars).toBe(0);
  });

  test('with feedback in markdown: feedback section appears BEFORE the static plan (§13)', () => {
    const content = [
      '# Unit 1',
      '### Done When',
      'pass.',
      '',
      RUNNER_TAIL_MARKER,
      '## Review Feedback',
      'AC-1 violated: missing null check at src/foo.ts:42',
      '',
      '## Latest Build Attempt',
      'attempt 1 done',
    ].join('\n');
    const { prompt, feedbackChars, priority } =
      composeBuildDispatchPromptFromUnitFile(content, '/nonexistent/plan/unit-1.md', null);
    expect(priority).toBe('review_first');
    expect(prompt).toContain('AC-1 violated: missing null check');
    expect(feedbackChars).toBeGreaterThan(0);
    const feedbackHeaderIdx = prompt.indexOf('--- PRIOR REVIEW FEEDBACK (MUST ADDRESS');
    const feedbackTextIdx = prompt.indexOf('AC-1 violated');
    const staticStartIdx = prompt.indexOf('--- STATIC UNIT PLAN');
    expect(feedbackHeaderIdx).toBeGreaterThan(-1);
    expect(feedbackTextIdx).toBeGreaterThan(feedbackHeaderIdx);
    // §13: review feedback comes BEFORE the static plan
    expect(staticStartIdx).toBeGreaterThan(feedbackTextIdx);
  });

  test('always includes do-not-modify instruction', () => {
    const { prompt } = composeBuildDispatchPromptFromUnitFile('# Unit 1\n### Done When\npass.', '/p/u-1.md', null);
    expect(prompt).toMatch(/Do NOT modify the unit plan file/i);
  });
});

describe('demoteFeedbackHeadings', () => {
  test('demotes H1 to H3', () => {
    expect(demoteFeedbackHeadings('# Title\nbody')).toBe('### Title\nbody');
  });
  test('demotes H2 to H3', () => {
    expect(demoteFeedbackHeadings('## Title\nbody')).toBe('### Title\nbody');
  });
  test('leaves H3 and below untouched', () => {
    expect(demoteFeedbackHeadings('### Title\n#### Sub')).toBe('### Title\n#### Sub');
  });
  test('does not touch text containing # in body', () => {
    expect(demoteFeedbackHeadings('text with # hash inside')).toBe('text with # hash inside');
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

// ─── runSingleAttempt integration tests ───────────────────────────────

/** Create a minimal valid unit plan file. */
function makeUnitPlan(id: number, opts: {
  backpressureCommands?: string[];
} = {}): string {
  const bpCmds = opts.backpressureCommands ?? ['bun test'];
  return [
    `# Unit ${id}: Test Unit ${id}`,
    '',
    '**Status:** pending',
    '**Attempts:** 0',
    '**Max Attempts:** 3',
    '**Depends On:** none',
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

/** Set up a project directory with plan file and unit files (no state needed for BLR). */
function setupProject(unitPlans: string[]): { projectDir: string; planPath: string; slug: string } {
  const projectDir = makeTmpDir();
  const slug = 'test-build';
  const planDir = path.join(projectDir, '.vcp', 'plan');
  const unitsDir = path.join(planDir, 'ralph', slug);
  mkdirSync(unitsDir, { recursive: true });

  const planPath = path.join(planDir, `ralph-${slug}.md`);
  writeFileSync(planPath, '# Test Feature\n**Status:** build\n');

  for (let i = 0; i < unitPlans.length; i++) {
    writeFileSync(path.join(unitsDir, `unit-${i + 1}.md`), unitPlans[i]);
  }

  return { projectDir, planPath, slug };
}

describe('runSingleAttempt', () => {
  test('dispatch complete + backpressure passes → mechanical_pass', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Implemented.' } as UnitBuildDispatchResult),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
      },
    );

    expect(result.event).toBe('attempt_complete');
    expect(result.outcome).toBe('mechanical_pass');
    expect(result.unitId).toBe(1);
    expect(result.mechanicalContext).toBeNull();
    expect(result.synthesis).toBe('Implemented.');
  });

  test('dispatch complete + backpressure fails → mechanical_fail with context', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' } as UnitBuildDispatchResult),
        backpressureFn: () => [{ command: 'bun test', exitCode: 1, stdout: 'FAIL', stderr: 'error TS2345', passed: false }],
      },
    );

    expect(result.event).toBe('attempt_complete');
    expect(result.outcome).toBe('mechanical_fail');
    expect(result.mechanicalContext).not.toBeNull();
    expect(result.mechanicalContext!.source).toBe('backpressure');
    expect(result.mechanicalContext!.command).toBe('bun test');
    expect(result.mechanicalContext!.exitCode).toBe(1);
    expect(result.backpressureResults).toHaveLength(1);
  });

  test('dispatch error → dispatch_error with context', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);
    const dispatchCtx = makeMechanicalContext({ source: 'dispatch', command: 'stage-runner' });

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({
          event: 'error', stage: 'ralph-build', phase: 'dispatch_failed',
          error: 'stage-runner crashed', mechanicalContext: dispatchCtx,
        } as UnitBuildDispatchResult),
        backpressureFn: () => [],
      },
    );

    expect(result.event).toBe('attempt_complete');
    expect(result.outcome).toBe('dispatch_error');
    expect(result.mechanicalContext).toEqual(dispatchCtx);
    expect(result.backpressureResults).toHaveLength(0);
  });

  test('dispatch error without mechanicalContext → dispatch_error, null context', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({
          event: 'error', stage: 'ralph-build', error: 'crashed',
        } as UnitBuildDispatchResult),
        backpressureFn: () => [],
      },
    );

    expect(result.outcome).toBe('dispatch_error');
    expect(result.mechanicalContext).toBeNull();
  });

  test('zero backpressure commands → mechanical_pass (vacuous)', async () => {
    const { projectDir, planPath } = setupProject([
      makeUnitPlan(1, { backpressureCommands: [] }),
    ]);

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' } as UnitBuildDispatchResult),
        backpressureFn: () => [],
      },
    );

    expect(result.event).toBe('attempt_complete');
    expect(result.outcome).toBe('mechanical_pass');
    expect(result.backpressureResults).toHaveLength(0);
  });

  test('lease echoed back in result', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1, lease: 'tok-abc-123' },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'OK' } as UnitBuildDispatchResult),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
      },
    );

    expect(result.lease).toBe('tok-abc-123');
  });

  test('lease is null when not provided', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build' } as UnitBuildDispatchResult),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
      },
    );

    expect(result.lease).toBeNull();
  });

  test('unit file not found → throws', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    await expect(runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 99 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build' } as UnitBuildDispatchResult),
        backpressureFn: () => [],
      },
    )).rejects.toThrow();
  });

  test('promptText passed through to dispatch', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);
    let receivedPrompt: string | null = null;

    await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1, promptText: 'SM-composed prompt text' },
      {
        dispatchFn: async (_plan, _cwd, _unit, _debug, prompt) => {
          receivedPrompt = prompt;
          return { event: 'complete', stage: 'ralph-build', synthesis: 'OK' } as UnitBuildDispatchResult;
        },
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
      },
    );

    expect(receivedPrompt).toBe('SM-composed prompt text');
  });

  test('multiple backpressure: first fail builds context', async () => {
    const { projectDir, planPath } = setupProject([
      makeUnitPlan(1, { backpressureCommands: ['bun build', 'bun test', 'bun lint'] }),
    ]);

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' } as UnitBuildDispatchResult),
        backpressureFn: () => [
          { command: 'bun build', exitCode: 0, stdout: '', stderr: '', passed: true },
          { command: 'bun test', exitCode: 1, stdout: 'FAIL test1', stderr: 'err1', passed: false },
          { command: 'bun lint', exitCode: 2, stdout: 'lint issues', stderr: 'err2', passed: false },
        ],
      },
    );

    expect(result.outcome).toBe('mechanical_fail');
    expect(result.mechanicalContext!.command).toBe('bun test');
    expect(result.mechanicalContext!.exitCode).toBe(1);
    expect(result.backpressureResults).toHaveLength(3);
  });

  test('backpressure skipped when dispatch errors', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);
    let bpCalled = false;

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'error', stage: 'ralph-build', error: 'fail' } as UnitBuildDispatchResult),
        backpressureFn: () => { bpCalled = true; return []; },
      },
    );

    expect(result.outcome).toBe('dispatch_error');
    expect(bpCalled).toBe(false);
  });

  test('synthesis is null when dispatch has none', async () => {
    const { projectDir, planPath } = setupProject([makeUnitPlan(1)]);

    const result = await runSingleAttempt(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build' } as UnitBuildDispatchResult),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
      },
    );

    expect(result.synthesis).toBeNull();
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

  test('fail-closed on malformed output — no verdict header', () => {
    const result = parseReviewVerdict('This is garbage output with no verdict heading');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('unparseable');
    expect(result.feedback).toContain('This is garbage output');
  });

  test('fail-closed truncates very long unparseable output to cap', () => {
    const huge = 'x'.repeat(20_000);
    const result = parseReviewVerdict(huge);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('truncated');
    expect(result.feedback.length).toBeLessThan(20_000);
  });

  test('demotes H1/H2 inside captured feedback to H3', () => {
    const output = [
      '## Verdict: NEEDS_CHANGES',
      '',
      '## Review Feedback',
      '# Top-level finding',
      '## Sub-finding',
      '### Already-H3',
      'body',
    ].join('\n');
    const result = parseReviewVerdict(output);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('### Top-level finding');
    expect(result.feedback).toContain('### Sub-finding');
    expect(result.feedback).toContain('### Already-H3');
    expect(result.feedback).not.toMatch(/^#\s/m);
    expect(result.feedback).not.toMatch(/^##\s/m);
  });

  test('falls back to post-verdict body when ## Review Feedback heading absent', () => {
    const output = '## Verdict: NEEDS_CHANGES\n\nDirect feedback body without a Feedback heading.';
    const result = parseReviewVerdict(output);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('Direct feedback body');
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

// ─── buildMechanicalContext ────────────────────────────────────────────────

describe('buildMechanicalContext', () => {
  test('short streams: head = full content, tail = empty string', () => {
    const ctx = buildMechanicalContext('dispatch', 'bun test', 1, 'hello', 'boom');
    expect(ctx.source).toBe('dispatch');
    expect(ctx.command).toBe('bun test');
    expect(ctx.exitCode).toBe(1);
    expect(ctx.stdoutHead).toBe('hello');
    expect(ctx.stdoutTail).toBe('');
    expect(ctx.stderrHead).toBe('boom');
    expect(ctx.stderrTail).toBe('');
  });

  test('long streams: head = first 1000 chars, tail = last 1000 chars', () => {
    // Marker sits at offset 1500 (past head's 1000-char window) and the tail
    // starts at offset 2500 (total length - 1000). Neither slice should see it.
    const big = 'x'.repeat(1500) + 'MIDDLE_MARKER' + 'y'.repeat(2000);
    const ctx = buildMechanicalContext('backpressure', 'go test', 1, big, '');
    expect(ctx.stdoutHead.length).toBe(1000);
    expect(ctx.stdoutTail.length).toBe(1000);
    expect(ctx.stdoutHead.startsWith('x')).toBe(true);
    expect(ctx.stdoutTail.endsWith('y')).toBe(true);
    // The exact middle is NOT preserved — documented trade-off
    expect(ctx.stdoutHead.includes('MIDDLE_MARKER')).toBe(false);
    expect(ctx.stdoutTail.includes('MIDDLE_MARKER')).toBe(false);
  });

  test('persists excerpts verbatim (no redaction)', () => {
    const stdout = 'FAIL: compile error on line 42';
    const stderr = 'error: undefined symbol `foo`';
    const ctx = buildMechanicalContext('dispatch', 'stage-runner', 1, stdout, stderr);
    expect(ctx.stdoutHead).toBe(stdout);
    expect(ctx.stderrHead).toBe(stderr);
  });
});


