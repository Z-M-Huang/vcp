import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  parseBuildLoopArgs,
  upsertMetadataLine,
  replaceOrAppendSection,
  writeUnitStatus,
  writeRunnerTail,
  RUNNER_TAIL_MARKER,
  demoteFeedbackHeadings,
  splitUnitFile,
  composeBuildDispatchPrompt,
  composeBuildDispatchPromptFromUnitFile,
  extractBackpressureCommands,
  resolveUnitPath,
  runSingleUnit,
  parseReviewVerdict,
  readFilesTouched,
  buildMechanicalContext,
  buildLatestAttemptState,
} from '../build-loop-runner.ts';
import type {
  UnitReviewResult,
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

// ─── writeRunnerTail ──────────────────────────────────────────────────────

describe('writeRunnerTail', () => {
  test('marker path: truncates from marker to EOF and re-emits tail', () => {
    const content = [
      '# Unit 1: Test',
      '**Status:** pending',
      '',
      '### Done When',
      'pass.',
      '',
      RUNNER_TAIL_MARKER,
      '## Review Feedback',
      'OLD feedback',
      '',
      '## Latest Build Attempt',
      'OLD attempt',
    ].join('\n');
    const result = writeRunnerTail(content, { reviewFeedback: 'NEW feedback', latestAttempt: 'NEW attempt' });
    expect(result.path).toBe('marker');
    expect(result.content).toContain('NEW feedback');
    expect(result.content).toContain('NEW attempt');
    expect(result.content).not.toContain('OLD feedback');
    expect(result.content).not.toContain('OLD attempt');
    // Marker appears exactly once
    expect(result.content.split(RUNNER_TAIL_MARKER).length - 1).toBe(1);
  });

  test('legacy_done_when path: splices tail right after Done When', () => {
    const content = [
      '# Unit 1: Test',
      '**Status:** pending',
      '',
      '### Done When',
      'All pass.',
      '',
      '## Orphaned Garbage Section From The Bug',
      'should be discarded.',
    ].join('\n');
    const result = writeRunnerTail(content, { reviewFeedback: 'fb', latestAttempt: 'att' });
    expect(result.path).toBe('legacy_done_when');
    expect(result.content).toContain(RUNNER_TAIL_MARKER);
    expect(result.content).toContain('All pass.');
    expect(result.content).not.toContain('Orphaned Garbage Section');
    expect(result.content).not.toContain('should be discarded');
  });

  test('legacy_done_when path: ignores Done When inside fenced code block', () => {
    const content = [
      '# Unit 1: Test',
      '',
      '### What to Implement',
      'Example:',
      '```markdown',
      '## Done When',
      'fake heading inside fence',
      '```',
      '',
      '### Done When',
      'real heading.',
    ].join('\n');
    const result = writeRunnerTail(content, { reviewFeedback: 'fb', latestAttempt: 'att' });
    expect(result.path).toBe('legacy_done_when');
    // The real heading "real heading." should be retained
    expect(result.content).toContain('real heading.');
    // The fenced fake heading should be retained too (it's part of the static plan)
    expect(result.content).toContain('fake heading inside fence');
  });

  test('legacy_done_when path: picks the LAST Done When when multiple exist', () => {
    const content = [
      '# Unit 1',
      '## Done When',
      'first one (malformed).',
      '## Other Section',
      'middle.',
      '## Done When',
      'real (last) one.',
    ].join('\n');
    const result = writeRunnerTail(content, { reviewFeedback: 'fb', latestAttempt: 'att' });
    expect(result.path).toBe('legacy_done_when');
    // Both "real (last) one." and the earlier "first one (malformed)." should be retained
    expect(result.content).toContain('first one (malformed).');
    expect(result.content).toContain('middle.');
    expect(result.content).toContain('real (last) one.');
    // Marker comes after the LAST Done When section
    const lastDoneWhenIdx = result.content.lastIndexOf('## Done When');
    const markerIdx = result.content.indexOf(RUNNER_TAIL_MARKER);
    expect(markerIdx).toBeGreaterThan(lastDoneWhenIdx);
  });

  test('append_eof path: no Done When and no marker — preserves content', () => {
    const content = '# Unit 1: Test\n**Status:** pending\nNo Done When heading anywhere.';
    const result = writeRunnerTail(content, { reviewFeedback: 'fb', latestAttempt: 'att' });
    expect(result.path).toBe('append_eof');
    expect(result.content).toContain('No Done When heading anywhere.');
    expect(result.content).toContain(RUNNER_TAIL_MARKER);
  });

  test('reviewFeedback undefined: preserves existing feedback from file', () => {
    const content = [
      '# Unit 1', '### Done When', 'pass.', '',
      RUNNER_TAIL_MARKER,
      '## Review Feedback',
      'PRESERVE THIS',
      '',
      '## Latest Build Attempt',
      'old attempt',
    ].join('\n');
    const result = writeRunnerTail(content, { latestAttempt: 'new attempt' });
    expect(result.preservedFeedback).toBe(true);
    expect(result.content).toContain('PRESERVE THIS');
    expect(result.content).toContain('new attempt');
    expect(result.content).not.toContain('old attempt');
  });

  test('reviewFeedback empty string: explicitly clears the block', () => {
    const content = [
      '# Unit 1', '### Done When', 'pass.', '',
      RUNNER_TAIL_MARKER,
      '## Review Feedback',
      'CLEAR ME',
      '',
      '## Latest Build Attempt',
      'old',
    ].join('\n');
    const result = writeRunnerTail(content, { reviewFeedback: '', latestAttempt: 'new' });
    expect(result.preservedFeedback).toBe(false);
    expect(result.content).not.toContain('CLEAR ME');
    expect(result.content).toContain('## Review Feedback');
    expect(result.feedbackChars).toBe(0);
  });

  test('reviewFeedback string: replaces existing feedback', () => {
    const content = [
      '# Unit 1', '### Done When', 'pass.', '',
      RUNNER_TAIL_MARKER,
      '## Review Feedback',
      'OLD',
      '',
      '## Latest Build Attempt',
      'a',
    ].join('\n');
    const result = writeRunnerTail(content, { reviewFeedback: 'NEW', latestAttempt: 'b' });
    expect(result.preservedFeedback).toBe(false);
    expect(result.content).not.toContain('OLD');
    expect(result.content).toContain('NEW');
  });

  test('round-trip stability: repeated calls with same args produce identical output', () => {
    const content = '# Unit 1\n### Done When\npass.\n';
    const r1 = writeRunnerTail(content, { reviewFeedback: 'fb', latestAttempt: 'att' });
    const r2 = writeRunnerTail(r1.content, { reviewFeedback: 'fb', latestAttempt: 'att' });
    expect(r2.content).toBe(r1.content);
    expect(r2.path).toBe('marker');
  });

  test('append_eof: file with only fenced Done When (no real heading) — does not truncate fence', () => {
    const content = [
      '# Unit 1',
      '```markdown',
      '## Done When',
      'fenced.',
      '```',
      'tail content',
    ].join('\n');
    const result = writeRunnerTail(content, { reviewFeedback: 'fb', latestAttempt: 'att' });
    expect(result.path).toBe('append_eof');
    expect(result.content).toContain('fenced.');
    expect(result.content).toContain('tail content');
  });

  test('legacy bug fixture: replaceOrAppendSection-style unit file collapses to clean tail after one write', () => {
    // Simulates the dense-mem unit-12.md bug: multiple orphaned H2 subsections
    // from feedback runs accumulated by the old naive-regex replacer, plus an
    // empty `## Review Feedback` anchor near EOF.
    const legacy = [
      '# Unit 12: Audit handler',
      '**Status:** pending',
      '**Attempts:** 4',
      '',
      '### Entropy', 'LOW',
      '',
      '### Acceptance Criteria',
      '- AC-1: Deny on nil principal',
      '',
      '### Done When',
      '- Tests pass for nil principal path.',
      '',
      // --- orphaned feedback from attempts 1-3 (the bug) ---
      '## Executive Summary',
      'Reviewer ran once at T0, left residue.',
      '',
      '## Critical Issues',
      '- Null check missing at src/audit.ts:42',
      '',
      '## Executive Summary',
      'Reviewer ran again at T1, more residue.',
      '',
      '## Critical Issues',
      '- Null check STILL missing at src/audit.ts:42',
      '',
      // --- empty anchor that the old code wrote each attempt ---
      '## Review Feedback',
      '',
      '## Latest Build Attempt',
      'Mechanical commands passed; review failed.',
    ].join('\n');

    const result = writeRunnerTail(legacy, {
      reviewFeedback: '- AC-1 violated (src/audit.ts:42): add `if (!ctx.principal) return deny()`',
      latestAttempt: 'Attempt 5 backpressure: tests pass.',
    });

    // Legacy path: no marker, Done When is the last anchor → legacy_done_when
    expect(result.path).toBe('legacy_done_when');
    // Exactly one marker
    expect(result.content.split(RUNNER_TAIL_MARKER).length - 1).toBe(1);
    // Exactly one `## Review Feedback` and one `## Latest Build Attempt`
    expect(result.content.split('## Review Feedback').length - 1).toBe(1);
    expect(result.content.split('## Latest Build Attempt').length - 1).toBe(1);
    // No orphaned H2 subsections survived
    expect(result.content).not.toContain('## Executive Summary');
    expect(result.content).not.toContain('## Critical Issues');
    // New feedback present; old residue gone
    expect(result.content).toContain('AC-1 violated');
    expect(result.content).not.toContain('Reviewer ran once at T0');
    expect(result.content).not.toContain('Reviewer ran again at T1');
    expect(result.content).not.toContain('Null check STILL missing');
    // Static plan preserved through Done When
    expect(result.content).toContain('AC-1: Deny on nil principal');
    expect(result.content).toContain('Tests pass for nil principal path.');
    // Output size bounded: ≤ legacy + new feedback + small constants
    expect(result.content.length).toBeLessThanOrEqual(legacy.length + result.feedbackChars + 512);
    // Telemetry fields populated
    expect(result.bytesBefore).toBe(legacy.length);
    expect(result.bytesAfter).toBe(result.content.length);
    expect(result.hadExistingFeedback).toBe(false); // empty anchor body = no prior feedback
  });

  test('second write on a legacy-cleaned file uses marker path (round-trip)', () => {
    const legacy = [
      '# Unit 1', '### Done When', 'pass.',
      '',
      '## Orphaned Section From Bug',
      'residue',
      '',
      '## Review Feedback',
      '',
      '## Latest Build Attempt',
      'old',
    ].join('\n');
    const first = writeRunnerTail(legacy, { reviewFeedback: 'fb1', latestAttempt: 'att1' });
    expect(first.path).toBe('legacy_done_when');
    const second = writeRunnerTail(first.content, { reviewFeedback: 'fb2', latestAttempt: 'att2' });
    expect(second.path).toBe('marker');
    expect(second.content).toContain('fb2');
    expect(second.content).not.toContain('fb1');
    expect(second.content).not.toContain('Orphaned Section From Bug');
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
  test('pristine state → priority=none, placeholder feedback', () => {
    const { prompt, priority, feedbackChars, mechanicalChars } =
      composeBuildDispatchPrompt('# Unit 1\n### Done When\npass.', '', null, '/p/u-1.md');
    expect(priority).toBe('none');
    expect(prompt).toContain('--- STATIC UNIT PLAN ---');
    expect(prompt).toContain('--- PRIOR REVIEW FEEDBACK (ADDRESS EVERY FINDING) ---');
    expect(prompt).toContain('(none — first attempt for this unit)');
    expect(prompt).not.toContain('--- PRIOR MECHANICAL FAILURE ---');
    expect(feedbackChars).toBe(0);
    expect(mechanicalChars).toBe(0);
  });

  test('review feedback only → priority=review_first, address-every-finding label', () => {
    const { prompt, priority, feedbackChars, mechanicalChars } =
      composeBuildDispatchPrompt(
        '# Unit 1\n### Done When\npass.',
        'AC-1 violated: missing null check at src/foo.ts:42',
        null,
        '/p/u-1.md',
      );
    expect(priority).toBe('review_first');
    expect(prompt).toContain('--- PRIOR REVIEW FEEDBACK (ADDRESS EVERY FINDING) ---');
    expect(prompt).toContain('AC-1 violated');
    expect(prompt).not.toContain('--- PRIOR MECHANICAL FAILURE ---');
    expect(prompt).not.toContain('ADDRESS AFTER MECHANICAL IS GREEN');
    expect(feedbackChars).toBeGreaterThan(0);
    expect(mechanicalChars).toBe(0);
    expect(prompt).toMatch(/address each finding/i);
  });

  test('mechanical failure only → priority=mechanical_first, no review block', () => {
    const previousAttempt = makeLatestAttempt({
      mechanicalContext: makeMechanicalContext({
        command: 'go test ./...',
        stdoutTail: 'FAIL: TestFoo (0.00s)\n    foo_test.go:42: expected 1, got 0',
      }),
    });
    const { prompt, priority, mechanicalChars, feedbackChars } =
      composeBuildDispatchPrompt('# Unit 1\n### Done When\npass.', '', previousAttempt, '/p/u-1.md');
    expect(priority).toBe('mechanical_first');
    expect(prompt).toContain('--- PRIOR MECHANICAL FAILURE ---');
    expect(prompt).toContain('Command: go test ./...');
    expect(prompt).toContain('FAIL: TestFoo');
    expect(prompt).not.toContain('--- PRIOR REVIEW FEEDBACK');
    expect(prompt).toMatch(/restore mechanical first/i);
    expect(mechanicalChars).toBeGreaterThan(0);
    expect(feedbackChars).toBe(0);
  });

  test('mechanical + review feedback → mechanical first, review labelled AFTER MECHANICAL IS GREEN', () => {
    const { prompt, priority } =
      composeBuildDispatchPrompt(
        '# Unit 1\n### Done When\npass.',
        'AC-2 violated: unchecked array access',
        makeLatestAttempt(),
        '/p/u-1.md',
      );
    expect(priority).toBe('mechanical_first');
    const mechanicalIdx = prompt.indexOf('--- PRIOR MECHANICAL FAILURE ---');
    const reviewIdx = prompt.indexOf('--- PRIOR REVIEW FEEDBACK (ADDRESS AFTER MECHANICAL IS GREEN) ---');
    expect(mechanicalIdx).toBeGreaterThan(0);
    expect(reviewIdx).toBeGreaterThan(mechanicalIdx);
    expect(prompt).toContain('AC-2 violated');
    expect(prompt).not.toContain('ADDRESS EVERY FINDING');
  });

  test('retry outcome without mechanicalContext → falls back to review_first (does not claim mechanical)', () => {
    const { prompt, priority } =
      composeBuildDispatchPrompt(
        '# Unit 1\n### Done When\npass.',
        'some review note',
        makeLatestAttempt({ mechanicalContext: null }),
        '/p/u-1.md',
      );
    expect(priority).toBe('review_first');
    expect(prompt).not.toContain('--- PRIOR MECHANICAL FAILURE ---');
  });

  test('always includes do-not-modify and unit plan path header', () => {
    const { prompt } = composeBuildDispatchPrompt('# Unit 1', '', null, '/path/to/unit-1.md');
    expect(prompt).toMatch(/Do NOT modify the unit plan file/i);
    expect(prompt).toContain('Unit plan path: /path/to/unit-1.md');
  });
});

describe('composeBuildDispatchPromptFromUnitFile', () => {
  test('first attempt: feedback section says (none)', () => {
    const content = '# Unit 1\n### Done When\npass.\n';
    const { prompt, staticPlanChars, feedbackChars, priority } =
      composeBuildDispatchPromptFromUnitFile(content, '/path/to/unit-1.md', null);
    expect(priority).toBe('none');
    expect(prompt).toContain('--- STATIC UNIT PLAN ---');
    expect(prompt).toContain('--- PRIOR REVIEW FEEDBACK (ADDRESS EVERY FINDING) ---');
    expect(prompt).toContain('(none — first attempt for this unit)');
    expect(prompt).toContain('--- INSTRUCTION ---');
    expect(prompt).toContain('Unit plan path: /path/to/unit-1.md');
    expect(staticPlanChars).toBeGreaterThan(0);
    expect(feedbackChars).toBe(0);
  });

  test('with feedback in markdown: feedback section contains the feedback body, not buried in plan', () => {
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
    const feedbackHeaderIdx = prompt.indexOf('--- PRIOR REVIEW FEEDBACK');
    const feedbackTextIdx = prompt.indexOf('AC-1 violated');
    expect(feedbackTextIdx).toBeGreaterThan(feedbackHeaderIdx);
    const staticStartIdx = prompt.indexOf('--- STATIC UNIT PLAN ---');
    const staticContent = prompt.slice(staticStartIdx, feedbackHeaderIdx);
    expect(staticContent).not.toContain('AC-1 violated');
  });

  test('always includes do-not-modify instruction and address-feedback instruction', () => {
    const { prompt } = composeBuildDispatchPromptFromUnitFile('# Unit 1\n### Done When\npass.', '/p/u-1.md', null);
    expect(prompt).toMatch(/Do NOT modify the unit plan file/i);
    expect(prompt).toMatch(/address each finding/i);
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
    // Body between ## Review Feedback and ## Latest Build Attempt should be blank
    const fbIdx = content.indexOf('## Review Feedback');
    const lbaIdx = content.indexOf('## Latest Build Attempt');
    expect(fbIdx).toBeGreaterThan(-1);
    expect(lbaIdx).toBeGreaterThan(fbIdx);
    const body = content.slice(fbIdx + '## Review Feedback'.length, lbaIdx).trim();
    expect(body).toBe('');
    // Feedback from prior failed attempt should not survive
    expect(content).not.toContain('Missing error handling');
  });

  test('review dispatch error (fail-closed) — unit_failed at exhaustion', async () => {
    const { projectDir, planPath, slug } = setupProject([makeUnitPlan(1, { maxAttempts: 1 })]);

    const result = await runSingleUnit(
      { planPath, cwd: projectDir, unitId: 1 },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' }),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
        reviewFn: async () => { throw new Error('subprocess crashed'); },
      },
    );

    // Fail-closed: catastrophic reviewer exception blocks the unit
    expect(result.event).toBe('unit_failed');
    const unitPath = path.join(projectDir, '.vcp', 'plan', 'ralph', slug, 'unit-1.md');
    const content = readFileSync(unitPath, 'utf-8');
    expect(content).toContain('Review function threw');
    expect(content).toContain('subprocess crashed');
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

// ─── buildLatestAttemptState ────────────────────────────────────────────────

describe('buildLatestAttemptState', () => {
  function dispatchComplete(): UnitBuildDispatchResult {
    return { event: 'complete', stage: 'ralph-build', synthesis: '', mechanicalContext: null };
  }
  function dispatchError(ctx: MechanicalContext | null = null): UnitBuildDispatchResult {
    return { event: 'error', stage: 'ralph-build', error: 'dispatch failed', mechanicalContext: ctx };
  }

  test('prefers dispatch.mechanicalContext when present', () => {
    const dispatchCtx: MechanicalContext = {
      source: 'dispatch',
      command: 'stage-runner',
      exitCode: 2,
      stdoutHead: 'out1',
      stdoutTail: '',
      stderrHead: 'err1',
      stderrTail: '',
    };
    const bp: BackpressureResult[] = [
      { command: 'bun test', exitCode: 1, stdout: 'test fail', stderr: '', passed: false },
    ];
    const state = buildLatestAttemptState(dispatchError(dispatchCtx), bp, 'retry', 2);
    expect(state.mechanicalContext).toEqual(dispatchCtx);
    expect(state.attempt).toBe(2);
    expect(state.dispatchEvent).toBe('error');
    expect(state.dispatchError).toBe('dispatch failed');
    expect(state.outcome).toBe('retry');
    expect(state.backpressure).toEqual([{ name: 'bun test', exitCode: 1 }]);
  });

  test('falls back to first failing backpressure command when dispatch is clean', () => {
    const bp: BackpressureResult[] = [
      { command: 'bun build', exitCode: 0, stdout: '', stderr: '', passed: true },
      { command: 'bun test', exitCode: 1, stdout: 'assertion failed', stderr: 'err', passed: false },
      { command: 'lint', exitCode: 2, stdout: 'style', stderr: '', passed: false },
    ];
    const state = buildLatestAttemptState(dispatchComplete(), bp, 'retry', 1);
    expect(state.mechanicalContext).not.toBeNull();
    expect(state.mechanicalContext!.source).toBe('backpressure');
    expect(state.mechanicalContext!.command).toBe('bun test');
    expect(state.mechanicalContext!.exitCode).toBe(1);
  });

  test('mechanicalContext null on done outcome with no failing commands', () => {
    const bp: BackpressureResult[] = [
      { command: 'bun test', exitCode: 0, stdout: '', stderr: '', passed: true },
    ];
    const state = buildLatestAttemptState(dispatchComplete(), bp, 'done', 3);
    expect(state.mechanicalContext).toBeNull();
    expect(state.outcome).toBe('done');
  });
});

