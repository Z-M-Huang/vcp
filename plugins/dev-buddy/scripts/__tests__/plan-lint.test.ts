import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { runPlanLint, parsePlanLintArgs } from '../plan-lint.ts';

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true })); });

function makeTmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'plan-lint-test-'));
  tmpDirs.push(d);
  return d;
}

interface FixtureUnit {
  id: number;
  backpressure: string[];
  /** Optional Contract Manifest. When undefined, no manifest section is written (legacy unit). */
  manifest?: {
    exports: Array<{ symbol: string; module: string; kind?: 'named' | 'type' | 'default' }>;
    consumes: Array<{ symbol: string; from: string }>;
  };
  /** Optional raw manifest body to inject (used for malformed-JSON tests). */
  rawManifestBody?: string;
}

function setupPlanLintFixture(
  units: FixtureUnit[],
): { planPath: string; projectDir: string } {
  const projectDir = makeTmpDir();
  const planDir = path.join(projectDir, '.vcp', 'plan');
  const slug = 'test-lint';
  const unitsDir = path.join(planDir, 'ralph', slug);
  mkdirSync(unitsDir, { recursive: true });

  writeFileSync(path.join(planDir, `ralph-${slug}.md`), `**Status:** plan_lint\n**Slug:** ${slug}\n`);

  for (const u of units) {
    const bpSection = u.backpressure.length > 0
      ? '## Backpressure\n' + u.backpressure.map(c => `- \`${c}\``).join('\n')
      : '';
    let manifestSection = '';
    if (u.rawManifestBody !== undefined) {
      manifestSection = '### Contract Manifest\n\n```json\n' + u.rawManifestBody + '\n```\n\n';
    } else if (u.manifest) {
      manifestSection = '### Contract Manifest\n\n```json\n' + JSON.stringify(u.manifest, null, 2) + '\n```\n\n';
    }
    writeFileSync(
      path.join(unitsDir, `unit-${u.id}.md`),
      `# Unit ${u.id}: Test Unit\n\n**Status:** pending\n**Attempts:** 0/5\n**Max Attempts:** 5\n\n${manifestSection}${bpSection}\n`,
    );
  }

  return { planPath: path.join(planDir, `ralph-${slug}.md`), projectDir };
}

describe('parsePlanLintArgs', () => {
  test('parses --plan and --cwd', () => {
    const result = parsePlanLintArgs(['node', 'script', '--plan', '/a/b.md', '--cwd', '/c']);
    expect(result.planPath).toBe('/a/b.md');
    expect(result.cwd).toBe('/c');
  });

  test('throws on missing --plan', () => {
    expect(() => parsePlanLintArgs(['node', 'script', '--cwd', '/c'])).toThrow('--plan');
  });
});

describe('runPlanLint', () => {
  test('passes when all unit tests fail (red — expected)', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      { id: 1, backpressure: ['bun test src/unit1.test.ts'] },
      { id: 2, backpressure: ['bun test src/unit2.test.ts'] },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 1, stderr: 'test failed' }),
    });

    expect(result.event).toBe('pass');
    expect(result.rejections).toHaveLength(0);
    expect(result.units).toHaveLength(2);
  });

  test('rejects when a unit test passes against HEAD (U13 case — feature exists)', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      { id: 1, backpressure: ['bun test src/unit1.test.ts'] },
      { id: 13, backpressure: ['bun test src/unit13.test.ts'] },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: (cmd) => {
        if (cmd.includes('unit13')) return { exitCode: 0, stderr: '' };
        return { exitCode: 1, stderr: 'test failed' };
      },
    });

    expect(result.event).toBe('reject');
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].unitId).toBe(13);
    expect(result.rejections[0].reason).toContain('passes against HEAD');
  });

  test('skips units without backpressure commands', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      { id: 1, backpressure: [] },
      { id: 2, backpressure: ['bun test'] },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 1, stderr: '' }),
    });

    expect(result.event).toBe('pass');
    expect(result.units).toHaveLength(2);
    expect(result.units[0].command).toBe('(none)');
    expect(result.units[1].command).toBe('bun test');
  });

  test('handles missing units directory gracefully', () => {
    const projectDir = makeTmpDir();
    const planPath = path.join(projectDir, '.vcp', 'plan', 'ralph-nonexistent.md');

    const result = runPlanLint(planPath, projectDir);

    expect(result.event).toBe('reject');
    expect(result.rejections[0].reason).toContain('Cannot read units directory');
  });

  test('rejects on invalid plan filename', () => {
    const result = runPlanLint('/tmp/bad-name.md', '/tmp');
    expect(result.event).toBe('reject');
    expect(result.rejections[0].reason).toContain('Cannot extract slug');
  });

  test('no build attempts consumed on rejection', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      { id: 1, backpressure: ['bun test'] },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 0, stderr: '' }),
    });

    expect(result.event).toBe('reject');
    expect(result.units[0].exitCode).toBe(0);
  });
});

describe('runPlanLint — Contract Manifest wiring', () => {
  test('passes when consumes resolves to an earlier unit\'s exports', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      {
        id: 1,
        backpressure: ['bun test src/unit1.test.ts'],
        manifest: {
          exports: [{ symbol: 'Foo', module: 'src/foo.ts' }],
          consumes: [],
        },
      },
      {
        id: 2,
        backpressure: ['bun test src/unit2.test.ts'],
        manifest: {
          exports: [],
          consumes: [{ symbol: 'Foo', from: 'src/foo.ts' }],
        },
      },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 1, stderr: 'red' }),
    });

    expect(result.event).toBe('pass');
    expect(result.warnings).toHaveLength(0);
    expect(result.rejections).toHaveLength(0);
  });

  test('rejects when consumes references a forward (later) unit', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      {
        id: 1,
        backpressure: ['bun test'],
        manifest: {
          exports: [],
          consumes: [{ symbol: 'Foo', from: 'src/foo.ts' }],
        },
      },
      {
        id: 2,
        backpressure: ['bun test'],
        manifest: {
          exports: [{ symbol: 'Foo', module: 'src/foo.ts' }],
          consumes: [],
        },
      },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 1, stderr: 'red' }),
    });

    expect(result.event).toBe('reject');
    // Forward-reference: producer exists but is later in the unit order.
    expect(result.rejections.some(r => r.unitId === 1 && r.reason.includes('not earlier'))).toBe(true);
  });

  test('rejects when no unit exports a consumed symbol (strict mode)', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      {
        id: 1,
        backpressure: ['bun test'],
        manifest: {
          exports: [],
          consumes: [{ symbol: 'Missing', from: 'src/missing.ts' }],
        },
      },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 1, stderr: 'red' }),
    });

    expect(result.event).toBe('reject');
    expect(result.rejections[0].reason).toContain('Missing');
  });

  test('warns (does not reject) on unresolved consumes when any unit lacks a manifest (degraded mode)', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      // Unit 1 is legacy — no manifest at all.
      { id: 1, backpressure: ['bun test'] },
      {
        id: 2,
        backpressure: ['bun test'],
        manifest: {
          exports: [],
          consumes: [{ symbol: 'MaybeFromLegacy', from: 'src/legacy.ts' }],
        },
      },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 1, stderr: 'red' }),
    });

    expect(result.event).toBe('pass');
    expect(result.warnings.some(w => w.unitId === 1 && w.reason.includes('legacy mode'))).toBe(true);
    expect(result.warnings.some(w => w.unitId === 2 && w.reason.includes('MaybeFromLegacy'))).toBe(true);
    expect(result.rejections).toHaveLength(0);
  });

  test('rejects when two units claim the same (symbol, module) export', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      {
        id: 1,
        backpressure: ['bun test'],
        manifest: {
          exports: [{ symbol: 'Conflicting', module: 'src/foo.ts' }],
          consumes: [],
        },
      },
      {
        id: 2,
        backpressure: ['bun test'],
        manifest: {
          exports: [{ symbol: 'Conflicting', module: 'src/foo.ts' }],
          consumes: [],
        },
      },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 1, stderr: 'red' }),
    });

    expect(result.event).toBe('reject');
    expect(result.rejections.some(r => r.unitId === 2 && r.reason.includes('already claims'))).toBe(true);
  });

  test('rejects on malformed manifest JSON', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      {
        id: 1,
        backpressure: ['bun test'],
        rawManifestBody: '{ "exports": [',
      },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 1, stderr: 'red' }),
    });

    expect(result.event).toBe('reject');
    expect(result.rejections[0].reason).toContain('JSON parse failed');
  });

  test('legacy plan (all units missing manifest) warns but does not reject', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      { id: 1, backpressure: ['bun test'] },
      { id: 2, backpressure: ['bun test'] },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: () => ({ exitCode: 1, stderr: 'red' }),
    });

    expect(result.event).toBe('pass');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every(w => w.reason.includes('legacy mode'))).toBe(true);
    expect(result.rejections).toHaveLength(0);
  });

  test('combined: red-test pass AND wiring failure both rejected', () => {
    const { planPath, projectDir } = setupPlanLintFixture([
      {
        id: 1,
        backpressure: ['bun test src/unit1.test.ts'],
        manifest: {
          exports: [],
          consumes: [{ symbol: 'Missing', from: 'src/missing.ts' }],
        },
      },
      {
        id: 2,
        backpressure: ['bun test src/unit2.test.ts'],
        manifest: { exports: [], consumes: [] },
      },
    ]);

    const result = runPlanLint(planPath, projectDir, {
      execFn: (cmd) => cmd.includes('unit2')
        ? { exitCode: 0, stderr: '' }
        : { exitCode: 1, stderr: 'red' },
    });

    expect(result.event).toBe('reject');
    expect(result.rejections.length).toBeGreaterThanOrEqual(2);
    expect(result.rejections.some(r => r.unitId === 1 && r.reason.includes('Missing'))).toBe(true);
    expect(result.rejections.some(r => r.unitId === 2 && r.reason.includes('passes against HEAD'))).toBe(true);
  });
});
