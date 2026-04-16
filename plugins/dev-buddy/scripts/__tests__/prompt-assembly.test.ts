import { describe, test, expect } from 'bun:test';
import {
  composeBuildDispatchPrompt,
  composeBuildDispatchPromptFromUnitFile,
  renderMechanicalBlock,
} from '../ralph/prompt-assembly.ts';
import type { MechanicalContext, LatestAttemptState } from '../ralph/types.ts';

function makeMech(overrides: Partial<MechanicalContext> = {}): MechanicalContext {
  return {
    source: 'dispatch', command: 'bun test', exitCode: 1,
    stdoutHead: '', stdoutTail: 'FAIL', stderrHead: '', stderrTail: 'TS2345',
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<LatestAttemptState> = {}): LatestAttemptState {
  return {
    attempt: 1, dispatchEvent: 'complete', dispatchError: null,
    backpressure: [], outcome: 'retry', mechanicalContext: makeMech(),
    ...overrides,
  };
}

describe('prompt-assembly standalone', () => {
  test('imports directly from ralph/prompt-assembly (not via BLR)', () => {
    const result = composeBuildDispatchPrompt('Plan text', '', null, '/unit.md');
    expect(result.priority).toBe('none');
    expect(result.prompt).toContain('Plan text');
  });

  test('review-first ordering (§13)', () => {
    const result = composeBuildDispatchPrompt(
      'Plan', 'Fix the frobulator', makeAttempt(), '/u.md',
    );
    expect(result.priority).toBe('review_first');
    const ri = result.prompt.indexOf('MUST ADDRESS');
    const mi = result.prompt.indexOf('PRIOR MECHANICAL FAILURE');
    const pi = result.prompt.indexOf('STATIC UNIT PLAN');
    expect(ri).toBeGreaterThan(-1);
    expect(mi).toBeGreaterThan(ri);
    expect(pi).toBeGreaterThan(mi);
  });

  test('renderMechanicalBlock formats all channels', () => {
    const block = renderMechanicalBlock(makeMech({
      stdoutHead: 'H', stdoutTail: 'T', stderrHead: 'EH', stderrTail: 'ET',
    }));
    expect(block).toContain('stdout (head):');
    expect(block).toContain('stdout (tail):');
    expect(block).toContain('stderr (head):');
    expect(block).toContain('stderr (tail):');
  });

  test('composeBuildDispatchPromptFromUnitFile splits and composes', () => {
    const content = '# Unit 1\nPlan body';
    const result = composeBuildDispatchPromptFromUnitFile(content, '/u.md', null);
    expect(result.priority).toBe('none');
    expect(result.prompt).toContain('Plan body');
  });
});
