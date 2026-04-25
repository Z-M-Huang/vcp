/**
 * Unit tests for the deterministic parts of audit-runner.ts.
 *
 * The LLM-driven scan path is not covered here — it requires a real preset and
 * burns token budget. An integration harness lands in a follow-up commit.
 */

import { describe, test, expect } from 'bun:test';
import {
  parseArgs,
  parseFindings,
  renderQuickMarkdown,
  partitionByDomain,
  renderFullMarkdown,
} from '../scripts/audit-runner.ts';

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

describe('renderQuickMarkdown', () => {
  test('READY when no findings', () => {
    const md = renderQuickMarkdown({
      mode: 'quick',
      target: '/proj',
      standardsLoaded: 5,
      rulesChecked: 12,
      findings: [],
      warnings: [],
    });
    expect(md).toContain('### VCP Release Readiness');
    expect(md).toContain('**Standards loaded:** 5');
    expect(md).toContain('**Rules checked:** 12 critical/high rules');
    expect(md).toContain('READY — No critical or high issues found');
  });

  test('NOT READY with critical findings', () => {
    const md = renderQuickMarkdown({
      mode: 'quick',
      target: '/proj',
      standardsLoaded: 3,
      rulesChecked: 8,
      findings: [
        { standardId: 'core-architecture', rule: 1, severity: 'critical', file: 'a.py', line: 1, evidence: '', issue: '', fix: '' },
        { standardId: 'core-architecture', rule: 2, severity: 'critical', file: 'b.py', line: 2, evidence: '', issue: '', fix: '' },
        { standardId: 'core-error-handling', rule: 3, severity: 'high', file: 'c.py', line: 3, evidence: '', issue: '', fix: '' },
      ],
      warnings: [],
    });
    expect(md).toContain('| core-architecture | FAIL | 2 critical findings |');
    expect(md).toContain('| core-error-handling | WARN | 1 high finding |');
    expect(md).toContain('NOT READY — 2 critical issues');
  });

  test('REVIEW when only high findings, no critical', () => {
    const md = renderQuickMarkdown({
      mode: 'quick',
      target: '/proj',
      standardsLoaded: 3,
      rulesChecked: 8,
      findings: [
        { standardId: 'core-error-handling', rule: 3, severity: 'high', file: 'c.py', line: 3, evidence: '', issue: '', fix: '' },
      ],
      warnings: [],
    });
    expect(md).toContain('| core-error-handling | WARN |');
    expect(md).toContain('REVIEW — 1 high finding');
    expect(md).not.toContain('NOT READY');
  });

  test('appends warnings', () => {
    const md = renderQuickMarkdown({
      mode: 'quick',
      target: '/proj',
      standardsLoaded: 1,
      rulesChecked: 1,
      findings: [],
      warnings: ['Suppressed 2 finding(s) by ignore config.'],
    });
    expect(md).toContain('> Suppressed 2 finding(s) by ignore config.');
  });
});

describe('partitionByDomain', () => {
  test('groups known standards into their declared domains', () => {
    const { groups, unmapped } = partitionByDomain([
      { id: 'core-security' },
      { id: 'web-frontend-security' },
      { id: 'database-encryption' },
      { id: 'core-architecture' },
    ]);
    expect(unmapped).toEqual([]);
    const domainNames = groups.map((g) => g.domain);
    expect(domainNames).toContain('backend');
    expect(domainNames).toContain('frontend');
    expect(domainNames).toContain('database');
    expect(domainNames).toContain('architecture');
  });

  test('falls back to architecture for unknown standards', () => {
    const { groups, unmapped } = partitionByDomain([
      { id: 'made-up-standard-id' },
    ]);
    expect(unmapped).toEqual(['made-up-standard-id']);
    const arch = groups.find((g) => g.domain === 'architecture');
    expect(arch).toBeDefined();
    expect(arch!.standards.map((s) => s.id)).toContain('made-up-standard-id');
  });

  test('groups in stable DOMAIN_MAP order', () => {
    const { groups } = partitionByDomain([
      { id: 'mobile-security' },
      { id: 'core-security' },
    ]);
    // backend (core-security) should come before mobile in the declared order
    const idxBackend = groups.findIndex((g) => g.domain === 'backend');
    const idxMobile = groups.findIndex((g) => g.domain === 'mobile');
    expect(idxBackend).toBeGreaterThanOrEqual(0);
    expect(idxMobile).toBeGreaterThanOrEqual(0);
    expect(idxBackend).toBeLessThan(idxMobile);
  });
});

describe('renderFullMarkdown', () => {
  test('full mode header and summary table', () => {
    const md = renderFullMarkdown({
      mode: 'full',
      target: '/proj',
      standardsLoaded: 5,
      rulesChecked: 30,
      findings: [
        { standardId: 'core-architecture', rule: 1, severity: 'critical', file: 'a.py', line: 10, evidence: '', issue: 'Layer violation', fix: 'Refactor' },
        { standardId: 'core-error-handling', rule: 3, severity: 'high', file: 'b.py', line: 5, evidence: '', issue: 'Empty catch', fix: 'Re-raise' },
      ],
      warnings: [],
    });
    expect(md).toContain('### VCP Audit');
    expect(md).toContain('**Standards loaded:** 5 standards, 30 rules checked');
    expect(md).toContain('**Target:** /proj');
    expect(md).toContain('| core-architecture | FAIL | 1 | 0 | 0 |');
    expect(md).toContain('| core-error-handling | WARN | 0 | 1 | 0 |');
    expect(md).toContain('**Overall: 1 critical, 1 high, 0 medium findings');
  });

  test('compliance mode uses VCP Compliance Audit header', () => {
    const md = renderFullMarkdown({
      mode: 'compliance',
      target: '/proj',
      standardsLoaded: 2,
      rulesChecked: 8,
      findings: [],
      warnings: [],
    });
    expect(md).toContain('### VCP Compliance Audit');
    expect(md).toContain('No findings across all scanned standards.');
  });

  test('orders standards by verdict severity (FAIL before WARN before PASS)', () => {
    const md = renderFullMarkdown({
      mode: 'full',
      target: '/proj',
      standardsLoaded: 3,
      rulesChecked: 5,
      findings: [
        { standardId: 'core-error-handling', rule: 3, severity: 'high', file: 'a', line: 1, evidence: '', issue: 'X', fix: 'Y' },
        { standardId: 'core-architecture', rule: 1, severity: 'critical', file: 'b', line: 1, evidence: '', issue: 'X', fix: 'Y' },
      ],
      warnings: [],
    });
    const failIdx = md.indexOf('| core-architecture | FAIL');
    const warnIdx = md.indexOf('| core-error-handling | WARN');
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(failIdx).toBeLessThan(warnIdx);
  });

  test('renders per-standard findings list with Rule N, file, fix', () => {
    const md = renderFullMarkdown({
      mode: 'full',
      target: '/proj',
      standardsLoaded: 1,
      rulesChecked: 1,
      findings: [
        { standardId: 'core-architecture', rule: 7, severity: 'critical', file: 'src/x.py', line: 42, evidence: 'foo', issue: 'Bad coupling', fix: 'Use abstraction' },
      ],
      warnings: [],
    });
    expect(md).toContain('##### core-architecture');
    expect(md).toContain('- **Rule 7** (critical) — Bad coupling');
    expect(md).toContain('  - **File:** src/x.py:42');
    expect(md).toContain('  - **Fix:** Use abstraction');
  });
});
