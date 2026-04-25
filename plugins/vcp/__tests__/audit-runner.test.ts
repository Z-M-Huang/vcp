/**
 * Unit tests for the deterministic parts of audit-runner.ts.
 *
 * The LLM-driven scan path is not covered here — it requires a real preset and
 * burns token budget. An integration harness lands in a follow-up commit.
 */

import { describe, test, expect } from 'bun:test';
import { parseArgs, parseFindings } from '../scripts/audit-runner.ts';

describe('parseArgs', () => {
  test('--mode quick is sufficient', () => {
    const args = parseArgs(['bun', 'audit-runner.ts', '--mode', 'quick']);
    expect(args.mode).toBe('quick');
  });

  test('throws on missing --mode', () => {
    expect(() => parseArgs(['bun', 'audit-runner.ts'])).toThrow(/--mode is required/);
  });

  test('throws on invalid --mode value', () => {
    expect(() => parseArgs(['bun', 'audit-runner.ts', '--mode', 'bogus']))
      .toThrow(/Invalid --mode 'bogus'/);
  });

  test('compliance mode requires --framework', () => {
    expect(() => parseArgs(['bun', 'audit-runner.ts', '--mode', 'compliance']))
      .toThrow(/--framework is required/);
  });

  test('compliance + framework parses', () => {
    const args = parseArgs(['bun', 'audit-runner.ts', '--mode', 'compliance', '--framework', 'gdpr']);
    expect(args.mode).toBe('compliance');
    expect(args.framework).toBe('gdpr');
  });

  test('rejects unknown framework', () => {
    expect(() => parseArgs(['bun', 'audit-runner.ts', '--mode', 'compliance', '--framework', 'sox']))
      .toThrow(/Invalid --framework 'sox'/);
  });

  test('parses optional flags', () => {
    const args = parseArgs([
      'bun', 'audit-runner.ts',
      '--mode', 'full',
      '--path', '/tmp/proj',
      '--preset', 'my-preset',
      '--model', 'haiku',
    ]);
    expect(args.mode).toBe('full');
    expect(args.path).toBe('/tmp/proj');
    expect(args.preset).toBe('my-preset');
    expect(args.model).toBe('haiku');
  });

  test('rejects unknown flag', () => {
    expect(() => parseArgs(['bun', 'audit-runner.ts', '--mode', 'quick', '--bogus', 'x']))
      .toThrow(/Unknown flag: --bogus/);
  });

  test('rejects flag without value', () => {
    expect(() => parseArgs(['bun', 'audit-runner.ts', '--mode']))
      .toThrow(/--mode requires a value/);
  });
});

describe('parseFindings', () => {
  test('NO_FINDINGS sentinel returns empty array', () => {
    const { findings } = parseFindings('NO_FINDINGS');
    expect(findings).toHaveLength(0);
  });

  test('NO_FINDINGS with surrounding whitespace works', () => {
    const { findings } = parseFindings('\n  NO_FINDINGS  \n');
    expect(findings).toHaveLength(0);
  });

  test('parses single finding block', () => {
    const raw = `FINDING: core-security/rule-3 (critical)
FILE: src/handler.py:42
EVIDENCE: result = call_dangerous_sink(req.body.input)
ISSUE: Untrusted data flows directly into a dangerous sink
FIX: Validate at the boundary; sanitize before the sink`;

    const { findings } = parseFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      standardId: 'core-security',
      rule: 3,
      severity: 'critical',
      file: 'src/handler.py',
      line: 42,
      evidence: 'result = call_dangerous_sink(req.body.input)',
      issue: 'Untrusted data flows directly into a dangerous sink',
      fix: 'Validate at the boundary; sanitize before the sink',
    });
  });

  test('parses multiple findings separated by blank lines', () => {
    const raw = `FINDING: core-architecture/rule-3 (critical)
FILE: src/a.py:10
EVIDENCE: layer A directly imports from layer C
ISSUE: Layer boundary violation
FIX: Route through layer B abstraction

FINDING: core-error-handling/rule-7 (high)
FILE: src/b.py:5
EVIDENCE: try block swallows the exception with empty except
ISSUE: Empty exception handler hides failures
FIX: Log the exception and re-raise or handle explicitly`;

    const { findings } = parseFindings(raw);
    expect(findings).toHaveLength(2);
    expect(findings[0].standardId).toBe('core-architecture');
    expect(findings[0].rule).toBe(3);
    expect(findings[1].rule).toBe(7);
    expect(findings[1].severity).toBe('high');
  });

  test('skips preamble before first FINDING', () => {
    const raw = `Here are my findings:

FINDING: core-architecture/rule-1 (high)
FILE: src/x.py:1
EVIDENCE: foo
ISSUE: bar
FIX: baz`;

    const { findings } = parseFindings(raw);
    expect(findings).toHaveLength(1);
  });

  test('handles missing line number', () => {
    const raw = `FINDING: core-architecture/rule-1 (high)
FILE: src/foo.py
EVIDENCE: foo
ISSUE: bar
FIX: baz`;

    const { findings } = parseFindings(raw);
    expect(findings[0].line).toBeNull();
    expect(findings[0].file).toBe('src/foo.py');
  });
});
