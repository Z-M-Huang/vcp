import { describe, test, expect, afterAll, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// Stub loadDevBuddyConfig BEFORE importing BLR so composeBuildDispatch /
// recordAttemptResultAction see the injected stage map. Tests toggle
// `mockConfig.stages['unit-review'].executors` via setUnitReviewEnabled().
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
  max_build_attempts: 10,
  max_outer_iterations: 3,
};

// Preserve the real module's other exports (atomicWriteFile, validateDevBuddyConfig,
// DEFAULT_CONFIG, etc.) so test files that load later can still import them.
// Without this, `mock.module` replaces the module with ONLY the listed keys.
const realPipelineConfig = await import('../pipeline-config.ts');
mock.module('../pipeline-config.ts', () => ({
  ...realPipelineConfig,
  loadDevBuddyConfig: () => mockConfig,
}));

function setUnitReviewEnabled(enabled: boolean): void {
  mockConfig.stages['unit-review'].executors = enabled
    ? [{ system_prompt: 'ralph-code-reviewer', preset: 'anthropic-subscription', model: 'sonnet' }]
    : [];
}

const {
  parseBuildLoopArgs,
  upsertMetadataLine,
  replaceOrAppendSection,
  splitUnitFile,
  composeBuildDispatchPrompt,
  composeBuildDispatchPromptFromUnitFile,
  extractBackpressureCommands,
  resolveUnitPath,
  parseReviewVerdict,
  readFilesTouched,
  buildMechanicalContext,
  classifyAttempt,
  runUnitLoop,
} = await import('../build-loop-runner.ts');
const { RUNNER_TAIL_MARKER, demoteFeedbackHeadings } = await import('../ralph/unit-file.ts');
const { ensurePlanStateSeeded, ensureUnitStateSeeded, readUnitState, reserveAttempt } =
  await import('../ralph/unit-state.ts');
const { composeBuildDispatch, recordReviewResultAction } = await import('../ralph/build-actions.ts');
import type {
  LatestAttemptState,
  MechanicalContext,
  UnitBuildDispatchResult,
  BackpressureResult,
} from '../ralph/types.ts';
import type { BuildLoopEvent, TerminalOutcome, UnitReviewDispatchOutput } from '../build-loop-runner.ts';

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
const debugConfigPath = path.join(os.homedir(), '.vcp', 'config.json');
let originalDebugConfig: string | null = null;
let hadOriginalDebugConfig = false;
try {
  originalDebugConfig = readFileSync(debugConfigPath, 'utf-8');
  hadOriginalDebugConfig = true;
} catch {
  // no existing config
}
mkdirSync(path.dirname(debugConfigPath), { recursive: true });
writeFileSync(debugConfigPath, JSON.stringify({ debug: true }));
afterAll(() => {
  tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true }));
  if (hadOriginalDebugConfig && originalDebugConfig !== null) {
    writeFileSync(debugConfigPath, originalDebugConfig);
  } else {
    rmSync(debugConfigPath, { force: true });
  }
});

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

// ─── classifyAttempt + runUnitLoop integration tests ─────────────────────

/** Create a minimal valid unit plan file. */
function makeUnitPlan(id: number, opts: {
  backpressureCommands?: string[];
  maxAttempts?: number;
} = {}): string {
  const bpCmds = opts.backpressureCommands ?? ['bun test'];
  const maxAttempts = opts.maxAttempts ?? 3;
  return [
    `# Unit ${id}: Test Unit ${id}`,
    '',
    '**Status:** pending',
    '**Attempts:** 0',
    `**Max Attempts:** ${maxAttempts}`,
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

/** Set up a project directory with plan file and unit files (no state needed — composeBuildDispatch seeds on demand). */
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

/** Seed unit state eagerly (used when tests need to pre-populate reservedAttempt etc.). */
function seedUnitState(projectDir: string, slug: string, unitId: number, maxAttempts = 3): void {
  const plan = ensurePlanStateSeeded(projectDir, slug, 'build', 'test-seed');
  ensureUnitStateSeeded(projectDir, slug, unitId, plan.decomposeRunId, maxAttempts, {
    status: 'pending',
    attempts: 0,
  });
}

/** Capture BLR's streamed events for later assertions. */
function makeEmitCollector(): { events: BuildLoopEvent[]; emitFn: (e: BuildLoopEvent) => void } {
  const events: BuildLoopEvent[] = [];
  return { events, emitFn: (e) => events.push(e) };
}

function okDispatch(synthesis = 'done'): UnitBuildDispatchResult {
  return { event: 'complete', stage: 'ralph-build', synthesis } as UnitBuildDispatchResult;
}
function okBackpressure(cmds: string[]): BackpressureResult[] {
  return cmds.map((c) => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true }));
}
function failBackpressure(cmd = 'bun test', tail = 'FAIL'): BackpressureResult[] {
  return [{ command: cmd, exitCode: 1, stdout: tail, stderr: 'err', passed: false }];
}

/** dispatchFn that records the prompt it receives; multi-iteration tests need this. */
function makeDispatchSpy(synthesis = 'done') {
  const prompts: string[] = [];
  const fn = async (_plan: string, _cwd: string, _debug: boolean, promptText: string) => {
    prompts.push(promptText);
    return okDispatch(synthesis);
  };
  return { fn, prompts };
}

describe('classifyAttempt (pure function)', () => {
  test('dispatch error → dispatch_error outcome', () => {
    const ctx: MechanicalContext = {
      source: 'dispatch', command: 'stage-runner', exitCode: 2,
      stdoutHead: '', stdoutTail: '', stderrHead: '', stderrTail: 'boom',
    };
    const r = classifyAttempt({
      dispatch: { event: 'error', stage: 'ralph-build', error: 'x', mechanicalContext: ctx } as UnitBuildDispatchResult,
      backpressure: [], backpressureCommandCount: 1, contract: null,
    });
    expect(r.outcome).toBe('dispatch_error');
    expect(r.mechanicalContext).toEqual(ctx);
  });

  test('dispatch complete + backpressure fail → mechanical_fail (backpressure source)', () => {
    const r = classifyAttempt({
      dispatch: okDispatch(),
      backpressure: failBackpressure('bun test', 'FAIL'),
      backpressureCommandCount: 1, contract: null,
    });
    expect(r.outcome).toBe('mechanical_fail');
    expect(r.mechanicalContext!.source).toBe('backpressure');
    expect(r.mechanicalContext!.command).toBe('bun test');
  });

  test('dispatch complete + backpressure pass + contract fail → mechanical_fail (contract-verifier source)', () => {
    const r = classifyAttempt({
      dispatch: okDispatch(),
      backpressure: okBackpressure(['bun test']),
      backpressureCommandCount: 1,
      contract: {
        event: 'fail', unitId: 1,
        failures: [{ symbol: 'Foo', module: 'src/x.ts', kind: 'named', tsCode: 2459, message: 'nope' }],
      },
    });
    expect(r.outcome).toBe('mechanical_fail');
    expect(r.mechanicalContext!.source).toBe('contract-verifier');
  });

  test('dispatch complete + all green → mechanical_pass', () => {
    const r = classifyAttempt({
      dispatch: okDispatch(),
      backpressure: okBackpressure(['bun test']),
      backpressureCommandCount: 1,
      contract: { event: 'pass', unitId: 1 },
    });
    expect(r.outcome).toBe('mechanical_pass');
    expect(r.mechanicalContext).toBeNull();
  });

  test('zero backpressure commands + no contract → mechanical_pass (vacuous)', () => {
    const r = classifyAttempt({
      dispatch: okDispatch(),
      backpressure: [], backpressureCommandCount: 0, contract: null,
    });
    expect(r.outcome).toBe('mechanical_pass');
  });
});

describe('runUnitLoop — plan §F test cases 1-8', () => {
  // Test 1a — backpressure-only, retry then pass.
  test('[1a] mech_fail → retry → mech_pass → {status:"done", attempts:2}', async () => {
    setUnitReviewEnabled(false);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 3 })]);
    let call = 0;
    const { events, emitFn } = makeEmitCollector();
    let reviewCalled = false;

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: (cmds) => (++call === 1 ? failBackpressure() : okBackpressure(cmds)),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
        reviewDispatchFn: async () => { reviewCalled = true; return { synthesis: '' }; },
        emitFn,
      },
    );

    expect(terminal.status).toBe('done');
    expect(terminal.attempts).toBe(2);
    expect(reviewCalled).toBe(false);
    expect(readUnitState(projectDir, 'test-build', 1)!.status).toBe('done');
    // Two attempt_start events (one per attempt); one terminal complete.
    expect(events.filter((e) => e.event === 'attempt_start')).toHaveLength(2);
    expect(events[events.length - 1].event).toBe('complete');
  });

  // Test 1b — backpressure-only, exhaustion.
  test('[1b] mech_fail × maxAttempts → {status:"failed"}; markUnitFailed fires once', async () => {
    setUnitReviewEnabled(false);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 2 })]);

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: () => failBackpressure(),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
      },
    );

    expect(terminal.status).toBe('failed');
    const state = readUnitState(projectDir, 'test-build', 1)!;
    expect(state.status).toBe('failed');
    // unit-level markUnitFailed sets a single `failed` record — the one from recordAttempt.
    // If BLR had also called markUnitFailed we would expect a duplicate; the count
    // of 'failed'-outcome records in attemptHistory should be exactly 1.
    const failedRecords = state.attemptHistory.filter((a) => a.outcome === 'failed');
    expect(failedRecords).toHaveLength(1);
  });

  // Test 2a — review enabled, immediate pass.
  test('[2a] mech_pass → review PASS → {status:"done", attempts:1}', async () => {
    setUnitReviewEnabled(true);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 3 })]);

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: (cmds) => okBackpressure(cmds),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
        reviewDispatchFn: async () => ({ synthesis: '## Verdict: PASS\n' }),
      },
    );

    expect(terminal.status).toBe('done');
    expect(terminal.attempts).toBe(1);
    expect(readUnitState(projectDir, 'test-build', 1)!.status).toBe('done');
  });

  test('[2a2] mech_pass → malformed affirmative review PASS is salvaged and logged', async () => {
    setUnitReviewEnabled(true);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 3 })]);

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: (cmds) => okBackpressure(cmds),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
        reviewDispatchFn: async () => ({
          synthesis: [
            'I\'ve reviewed all three implementation files against the unit specification. The implementation is complete and correct. Here\'s my verification:',
            '',
            '## ✅ Implementation Review',
            '',
            'Ready for backpressure verification.',
          ].join('\n'),
        }),
      },
    );

    expect(terminal.status).toBe('done');
    expect(readUnitState(projectDir, 'test-build', 1)!.status).toBe('done');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const logBody = readFileSync(path.join(projectDir, '.vcp', 'dev-buddy.log'), 'utf-8');
    expect(logBody).toContain('unit-review.verdict_salvaged_pass');
    expect(logBody).toContain('reason=affirmative_pass_family_without_verdict');
  });

  // Test 2b — review-driven retry with feedback carry.
  test('[2b] review NEEDS_CHANGES → retry → review PASS; 2nd build prompt carries MUST ADDRESS feedback', async () => {
    setUnitReviewEnabled(true);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 3 })]);
    const spy = makeDispatchSpy();
    let reviewCall = 0;

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: spy.fn,
        backpressureFn: (cmds) => okBackpressure(cmds),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
        reviewDispatchFn: async (): Promise<UnitReviewDispatchOutput> => (++reviewCall === 1
          ? { synthesis: '## Verdict: NEEDS_CHANGES\n\n## Review Feedback\n- AC-1 violated at src/test.ts:42' }
          : { synthesis: '## Verdict: PASS\n' }),
      },
    );

    expect(terminal.status).toBe('done');
    expect(terminal.attempts).toBe(2);
    expect(spy.prompts).toHaveLength(2);
    // First attempt: no prior feedback.
    expect(spy.prompts[0]).not.toContain('MUST ADDRESS');
    // Second attempt: feedback threaded in at §13 priority (review_first).
    expect(spy.prompts[1]).toContain('PRIOR REVIEW FEEDBACK (MUST ADDRESS');
    expect(spy.prompts[1]).toContain('AC-1 violated');
  });

  // Test 2c — review NEEDS_CHANGES × maxAttempts → failed.
  test('[2c] review NEEDS_CHANGES × maxAttempts → {status:"failed"}', async () => {
    setUnitReviewEnabled(true);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 2 })]);

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: (cmds) => okBackpressure(cmds),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
        reviewDispatchFn: async () => ({ synthesis: '## Verdict: NEEDS_CHANGES\n\n## Review Feedback\n- still wrong' }),
      },
    );

    expect(terminal.status).toBe('failed');
    expect(readUnitState(projectDir, 'test-build', 1)!.status).toBe('failed');
  });

  // Test 3 — review feedback persisted by recordReviewResultAction is read back
  // by the next composeBuildDispatch and injected into the build prompt under
  // "PRIOR REVIEW FEEDBACK". The plan §F described a hash-guard that would drop
  // stale feedback when unit-N.md was mutated between review and next compose,
  // but the current codebase stores `unitFileHashAtReview` without comparing it
  // on read (build-actions.ts:143 reads state.reviewFeedback unconditionally).
  // Adding a read-side guard is out-of-scope for this plan; the test validates
  // the feedback flow that IS implemented (persistence + re-injection).
  test('[3] review NEEDS_CHANGES feedback is persisted and re-injected in next compose prompt', async () => {
    setUnitReviewEnabled(true);
    const { projectDir } = setupProject([makeUnitPlan(1, { maxAttempts: 3 })]);

    // Simulate attempt 1 mech_pass → review NEEDS_CHANGES without going through
    // runUnitLoop (the write path is owned by build-actions.ts; BLR just observes).
    seedUnitState(projectDir, 'test-build', 1, 3);
    const r1 = reserveAttempt(projectDir, 'test-build', 1, 0);
    await recordReviewResultAction(
      projectDir, 'test-build',
      { unitId: 1, lease: r1.lease, passed: false, feedback: '- AC-1 violated at src/test.ts:42' },
      false,
    );

    // Feedback is persisted in unit-N.json with the hash at review time.
    const state = readUnitState(projectDir, 'test-build', 1)!;
    expect(state.reviewFeedback).toContain('AC-1 violated');
    expect(state.unitFileHashAtReview).toBeDefined();

    // Fresh compose: persisted feedback flows into the next prompt.
    const dispatch = composeBuildDispatch(projectDir, 'test-build', 1);
    expect(dispatch.prompt).toContain('PRIOR REVIEW FEEDBACK');
    expect(dispatch.prompt).toContain('AC-1 violated at src/test.ts:42');
  });

  // Test 4 — stuck detection (non-terminal).
  test('[4] 3 identical mech_fails → {status:"stuck"}; unit-N.json status NOT failed; markUnitFailed NOT called', async () => {
    setUnitReviewEnabled(false);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 5 })]);

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        // Identical backpressure failure on every attempt — command+exitCode+tails match.
        backpressureFn: () => [
          { command: 'bun test', exitCode: 1, stdout: 'same-tail', stderr: 'same-err', passed: false },
        ],
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
      },
    );

    expect(terminal.status).toBe('stuck');
    const state = readUnitState(projectDir, 'test-build', 1)!;
    expect(state.status).not.toBe('failed');
    expect(state.identicalFailureCount).toBe(2);
    // No 'failed' records in attemptHistory → markUnitFailed was not called.
    expect(state.attemptHistory.filter((a) => a.outcome === 'failed')).toHaveLength(0);
  });

  // Test 5 — fresh-state seeding by composeBuildDispatch, with clamping.
  test('[5] no pre-seeded unit state → composeBuildDispatch seeds and attempt 1 runs to completion', async () => {
    setUnitReviewEnabled(false);
    // Unit-level maxAttempts=15 clamps down to mockConfig.max_build_attempts=10.
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 15 })]);

    // Precondition: no unit-N.json yet.
    expect(readUnitState(projectDir, 'test-build', 1)).toBeNull();

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: (cmds) => okBackpressure(cmds),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
      },
    );

    expect(terminal.status).toBe('done');
    const state = readUnitState(projectDir, 'test-build', 1)!;
    expect(state).not.toBeNull();
    expect(state.maxAttempts).toBe(10); // mockConfig.max_build_attempts=10 clamps unit-level 15→10
  });

  // Test 6 — stale-reservation recovery.
  test('[6] pre-seeded stale reservedAttempt → composeBuildDispatch abandons, reserves fresh, run completes', async () => {
    setUnitReviewEnabled(false);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 3 })]);

    // Seed + simulate a crashed dispatch with a 60-minute-old reservation.
    seedUnitState(projectDir, 'test-build', 1, 3);
    const before = reserveAttempt(projectDir, 'test-build', 1, 0);
    const statePath = path.join(projectDir, '.vcp', 'plan', '.state', 'ralph-test-build', 'units', 'unit-1.json');
    const frozen = JSON.parse(readFileSync(statePath, 'utf-8'));
    frozen.reservedAttempt.reservedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(statePath, JSON.stringify(frozen));

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: (cmds) => okBackpressure(cmds),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
      },
    );

    expect(terminal.status).toBe('done');
    const state = readUnitState(projectDir, 'test-build', 1)!;
    expect(state.attemptHistory.find((a) => a.outcome === 'abandoned')).toBeDefined();
    expect(state.reservedAttempt).toBeUndefined();
    expect(before.lease).toBeDefined();
  });

  test('[6b] stale reservedAttempt at exhausted budget marks unit failed before BLR exits', async () => {
    setUnitReviewEnabled(false);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 1 })]);

    seedUnitState(projectDir, 'test-build', 1, 1);
    reserveAttempt(projectDir, 'test-build', 1, 0);
    const statePath = path.join(projectDir, '.vcp', 'plan', '.state', 'ralph-test-build', 'units', 'unit-1.json');
    const frozen = JSON.parse(readFileSync(statePath, 'utf-8'));
    frozen.reservedAttempt.reservedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(statePath, JSON.stringify(frozen));

    const terminal = await runUnitLoop({ planPath, cwd: projectDir, unitId: 1 });

    expect(terminal.status).toBe('failed');
    expect(terminal.reason).toContain('exhausted budget');
    const state = readUnitState(projectDir, 'test-build', 1)!;
    expect(state.status).toBe('failed');
    expect(state.reservedAttempt).toBeUndefined();
    expect(state.attemptHistory.find((a) => a.outcome === 'abandoned')).toBeDefined();
  });

  // Test 7 — terminal JSON shape.
  test('[7] terminal emit has event:complete + orchestratorHints for done/failed; no hints for stuck; no hints on intermediate', async () => {
    setUnitReviewEnabled(true);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 3 })]);
    const { events, emitFn } = makeEmitCollector();

    const terminal = await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: (cmds) => okBackpressure(cmds),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
        reviewDispatchFn: async () => ({ synthesis: '## Verdict: PASS\n' }),
        emitFn,
      },
    );

    // done case.
    expect(terminal).toMatchObject({
      event: 'complete', status: 'done', unitId: 1,
      orchestratorHints: { claudeCode: { tool: 'TaskUpdate', status: 'completed' } },
    });
    expect(terminal.orchestratorHints!.claudeCode.note).toContain('passed review');
    // Intermediate events must not carry orchestratorHints.
    const intermediate = events.filter((e) => e.event !== 'complete') as Array<Record<string, unknown>>;
    for (const e of intermediate) {
      expect((e as { orchestratorHints?: unknown }).orchestratorHints).toBeUndefined();
    }

    // stuck case: no orchestratorHints.
    setUnitReviewEnabled(false);
    const { projectDir: p2, planPath: pp2 } = setupProject([makeUnitPlan(1, { maxAttempts: 5 })]);
    const stuckTerminal = await runUnitLoop(
      { planPath: pp2, cwd: p2, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: () => [{ command: 'bun test', exitCode: 1, stdout: 'x', stderr: 'x', passed: false }],
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
      },
    );
    expect(stuckTerminal.status).toBe('stuck');
    expect(stuckTerminal.orchestratorHints).toBeUndefined();

    // failed case: "failed — " prefix in note.
    const { projectDir: p3, planPath: pp3 } = setupProject([makeUnitPlan(1, { maxAttempts: 1 })]);
    const failedTerminal = await runUnitLoop(
      { planPath: pp3, cwd: p3, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: () => failBackpressure(),
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
      },
    );
    expect(failedTerminal.status).toBe('failed');
    expect(failedTerminal.orchestratorHints!.claudeCode.note).toMatch(/^failed — /);
  });

  // Test 8 — review-driven retry resets identical-failure counter.
  test('[8] mech_fail × identical → mech_pass → review NEEDS_CHANGES → retry → mech_pass → review PASS: identicalFailureCount resets to 0', async () => {
    setUnitReviewEnabled(true);
    const { projectDir, planPath } = setupProject([makeUnitPlan(1, { maxAttempts: 6 })]);

    let bpCall = 0;
    let reviewCall = 0;
    const identicalFail: BackpressureResult[] = [
      { command: 'bun test', exitCode: 1, stdout: 'same-tail', stderr: 'same-err', passed: false },
    ];

    await runUnitLoop(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => okDispatch(),
        backpressureFn: (cmds) => {
          bpCall += 1;
          // attempt 1: fail, attempt 2: fail (identical), attempts 3+: pass.
          if (bpCall <= 2) return identicalFail;
          return okBackpressure(cmds);
        },
        verifyContractFn: () => ({ event: 'pass', unitId: 1 }),
        reviewDispatchFn: async (): Promise<UnitReviewDispatchOutput> => (++reviewCall === 1
          ? { synthesis: '## Verdict: NEEDS_CHANGES\n\n## Review Feedback\n- f1' }
          : { synthesis: '## Verdict: PASS\n' }),
      },
    );

    const state = readUnitState(projectDir, 'test-build', 1)!;
    expect(state.status).toBe('done');
    // After the review-driven retry (commit outcome='retry', identicalFailure=false),
    // the counter is cleared. Subsequent review-PASS keeps it at 0.
    expect(state.identicalFailureCount).toBe(0);
  });
});

// ─── parseReviewVerdict ──────────────────────────────────────────────────

describe('parseReviewVerdict', () => {
  test('parses PASS verdict', () => {
    const result = parseReviewVerdict('## Verdict: PASS\n\nAll ACs traced.');
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe('');
    expect(result.parseMode).toBe('strict');
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
    expect(result.parseMode).toBe('strict');
  });

  test('fail-closed on malformed output — no verdict header', () => {
    const result = parseReviewVerdict('This is garbage output with no verdict heading');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('unparseable');
    expect(result.feedback).toContain('This is garbage output');
    expect(result.parseMode).toBe('unparseable');
  });

  test('fail-closed truncates very long unparseable output to cap', () => {
    const huge = 'x'.repeat(20_000);
    const result = parseReviewVerdict(huge);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('truncated');
    expect(result.feedback.length).toBeLessThan(20_000);
    expect(result.parseMode).toBe('unparseable');
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
    expect(result.parseMode).toBe('strict');
  });

  test('handles case-insensitive verdict', () => {
    expect(parseReviewVerdict('## verdict: pass').passed).toBe(true);
    expect(parseReviewVerdict('## VERDICT: NEEDS_CHANGES\nSome feedback').passed).toBe(false);
  });

  test('salvages affirmative implementation-review summary without verdict header', () => {
    const output = [
      'I\'ve reviewed all three implementation files against the unit specification. The implementation is complete and correct. Here\'s my verification:',
      '',
      '## ✅ Implementation Review',
      '',
      'Ready for backpressure verification.',
    ].join('\n');
    const result = parseReviewVerdict(output);
    expect(result).toMatchObject({
      passed: true,
      feedback: '',
      parseMode: 'salvaged_pass',
      reason: 'affirmative_pass_family_without_verdict',
    });
  });

  test('salvages affirmative coverage summary without verdict header', () => {
    const output = [
      'All four implementation files are already present and well-structured. Let me verify the code quality against the specification by checking a few key aspects.',
      '',
      'The implementation covers:',
      '',
      'The implementation is complete and matches AC-54 requirements. Ready to mark `[x]` once backpressure passes.',
    ].join('\n');
    const result = parseReviewVerdict(output);
    expect(result).toMatchObject({
      passed: true,
      feedback: '',
      parseMode: 'salvaged_pass',
      reason: 'affirmative_pass_family_without_verdict',
    });
  });

  test('salvages review feedback no-findings body without verdict header', () => {
    const output = [
      '## Review Feedback',
      '(no findings — all ACs satisfied)',
    ].join('\n');
    const result = parseReviewVerdict(output);
    expect(result).toMatchObject({
      passed: true,
      feedback: '',
      parseMode: 'salvaged_pass',
      reason: 'review_feedback_no_findings_without_verdict',
    });
  });

  test('does not salvage malformed output when review feedback contains findings', () => {
    const output = [
      '## Review Feedback',
      '- AC-1 violated (src/foo.ts:42): missing error handling',
    ].join('\n');
    const result = parseReviewVerdict(output);
    expect(result.passed).toBe(false);
    expect(result.parseMode).toBe('unparseable');
  });

  test('does not salvage affirmative prose when actionable findings are present', () => {
    const output = [
      'The implementation is complete and correct.',
      '',
      '## ✅ Implementation Review',
      '',
      '- Contract mismatch (src/bar.ts:10): returns void instead of Promise',
    ].join('\n');
    const result = parseReviewVerdict(output);
    expect(result.passed).toBe(false);
    expect(result.parseMode).toBe('unparseable');
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

// ─── Import-surface guard (replaces the planned eslint lint rule) ──────────

// Guard against re-introducing the v0.5.6 dual-write-path bug. All state
// transitions during the build stage must funnel through the three
// `ralph/build-actions.ts` action functions; BLR must never import low-level
// state helpers from `./ralph/unit-state.ts` directly.
describe('build-loop-runner.ts import-surface guard', () => {
  test('does NOT import from ./ralph/unit-state.ts', () => {
    const src = readFileSync(path.join(__dirname, '..', 'build-loop-runner.ts'), 'utf-8');
    expect(src).not.toMatch(/from\s+['"]\.\/ralph\/unit-state\.ts?['"]/);
    expect(src).not.toMatch(/from\s+['"]\.\/ralph\/unit-state['"]/);
  });

  test('does NOT reference the forbidden state-transition helpers by identifier', () => {
    const src = readFileSync(path.join(__dirname, '..', 'build-loop-runner.ts'), 'utf-8');
    // Imports from unit-state.ts would bring these names into scope; verify
    // they're not referenced as callable identifiers. (Comments are allowed.)
    const forbidden = [
      'reserveAttempt', 'commitAttemptResult', 'markUnitDone', 'markUnitFailed',
      'setReviewFeedback', 'abandonReservation', 'hashUnitFile', 'detectStuck',
    ];
    // Strip single-line and block comments so legitimate references in docstrings don't trip the guard.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const name of forbidden) {
      // Word boundary + open-paren means "called as a function" — what we ban.
      const re = new RegExp(`\\b${name}\\s*\\(`);
      expect({ name, matched: re.test(code) }).toEqual({ name, matched: false });
    }
  });
});
