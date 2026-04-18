import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { verifyContract, formatFailureMessage } from '../contract-verifier.ts';

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true })); });

function makeTmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'contract-verifier-'));
  tmpDirs.push(d);
  return d;
}

interface ProjectFixture {
  /** project root dir */
  projectDir: string;
  /** absolute path to the unit-N.md fixture */
  unitFile: string;
}

interface FixtureSpec {
  /** Map of project-relative path → file contents. tsconfig.json is added automatically if not provided. */
  files: Record<string, string>;
  /** Body of the unit-N.md Contract Manifest section. When omitted, no manifest is written. */
  manifest?: { exports: any[]; consumes: any[] };
  /** Override the default tsconfig (compilerOptions.strict + ESNext + Node module resolution). */
  tsconfig?: object;
  /** Unit ID reflected in the unit file name. */
  unitId?: number;
}

const DEFAULT_TSCONFIG = {
  compilerOptions: {
    target: 'ESNext',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  },
  include: ['src/**/*.ts'],
};

function setupProject(spec: FixtureSpec): ProjectFixture {
  const projectDir = makeTmpDir();
  const unitId = spec.unitId ?? 1;

  if (!('tsconfig.json' in spec.files)) {
    writeFileSync(
      path.join(projectDir, 'tsconfig.json'),
      JSON.stringify(spec.tsconfig ?? DEFAULT_TSCONFIG, null, 2),
    );
  }

  for (const [rel, body] of Object.entries(spec.files)) {
    const abs = path.join(projectDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }

  const planDir = path.join(projectDir, '.vcp', 'plan', 'ralph', 'test-slug');
  mkdirSync(planDir, { recursive: true });
  const unitFile = path.join(planDir, `unit-${unitId}.md`);
  let unitContent = `# Unit ${unitId}: Test\n\n**Status:** pending\n\n`;
  if (spec.manifest) {
    unitContent +=
      '### Contract Manifest\n\n```json\n' +
      JSON.stringify(spec.manifest, null, 2) +
      '\n```\n\n';
  }
  unitContent += '## Backpressure\n- `bun test`\n';
  writeFileSync(unitFile, unitContent);

  return { projectDir, unitFile };
}

describe('verifyContract', () => {
  test('skips when unit file has no Contract Manifest', () => {
    const { projectDir, unitFile } = setupProject({
      files: { 'src/foo.ts': 'export const x = 1;\n' },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('skip');
    if (result.event !== 'skip') return;
    expect(result.skipReason).toContain('no Contract Manifest');
  });

  test('skips when manifest has empty exports[]', () => {
    const { projectDir, unitFile } = setupProject({
      files: { 'src/foo.ts': 'export const x = 1;\n' },
      manifest: { exports: [], consumes: [] },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('skip');
    if (result.event !== 'skip') return;
    expect(result.skipReason).toContain('empty exports');
  });

  test('passes when promised named export actually exists', () => {
    const { projectDir, unitFile } = setupProject({
      files: { 'src/foo.ts': 'export class Foo {}\nexport function bar() {}\n' },
      manifest: {
        exports: [
          { symbol: 'Foo', module: 'src/foo.ts', kind: 'named' },
          { symbol: 'bar', module: 'src/foo.ts', kind: 'named' },
        ],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('pass');
  });

  test('passes when promised type export actually exists', () => {
    const { projectDir, unitFile } = setupProject({
      files: { 'src/types.ts': 'export type WindowTriggerConfig = { name: string };\n' },
      manifest: {
        exports: [{ symbol: 'WindowTriggerConfig', module: 'src/types.ts', kind: 'type' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('pass');
  });

  test('fails TS2459 when named export is declared but missing the export keyword (Class A bug, file has other exports)', () => {
    // The openhive Unit 27 scenario: ConcurrencyManager class declared but no
    // `export` keyword. The file IS a module because it exports other symbols.
    // tsc emits TS2459 ("Module declares 'X' locally, but it is not exported")
    // — the most precise diagnostic for Class A: the symbol exists locally,
    // it just lacks the `export` keyword.
    const { projectDir, unitFile } = setupProject({
      files: {
        'src/concurrency-manager.ts':
          'class ConcurrencyManager {}\nexport const VERSION = 1;\n',
      },
      manifest: {
        exports: [{ symbol: 'ConcurrencyManager', module: 'src/concurrency-manager.ts', kind: 'named' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('fail');
    if (result.event !== 'fail') return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].symbol).toBe('ConcurrencyManager');
    expect(result.failures[0].tsCode).toBe(2459);
    expect(result.failures[0].kind).toBe('named');
  });

  test('fails TS2305 when named symbol does not exist in the producer file at all', () => {
    // The producer file is a module but the requested symbol simply isn't there
    // (typo, never written, was deleted). tsc emits TS2305.
    const { projectDir, unitFile } = setupProject({
      files: { 'src/utils.ts': 'export const VERSION = 1;\n' },
      manifest: {
        exports: [{ symbol: 'NonExistent', module: 'src/utils.ts', kind: 'named' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('fail');
    if (result.event !== 'fail') return;
    expect(result.failures[0].tsCode).toBe(2305);
  });

  test('fails TS2306 when the source file has no exports at all (file is not a module)', () => {
    // Pathological variant of Class A: the producer file forgot all exports,
    // not just one. tsc emits TS2306 ("File is not a module") instead of TS2305.
    // We must still flag this as a contract failure.
    const { projectDir, unitFile } = setupProject({
      files: { 'src/concurrency-manager.ts': 'class ConcurrencyManager {}\n' },
      manifest: {
        exports: [{ symbol: 'ConcurrencyManager', module: 'src/concurrency-manager.ts', kind: 'named' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('fail');
    if (result.event !== 'fail') return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].symbol).toBe('ConcurrencyManager');
    expect(result.failures[0].tsCode).toBe(2306);
  });

  test('fails TS2459 when type export is declared but missing the export keyword (Class A type-only bug)', () => {
    // The openhive Unit 22 scenario: WindowTriggerConfig declared but not exported.
    // File has another export so it is a module — tsc emits TS2459 because the
    // type exists locally, it just lacks the `export` keyword.
    const { projectDir, unitFile } = setupProject({
      files: {
        'src/types.ts':
          'type WindowTriggerConfig = { name: string };\nexport type Other = { id: string };\n',
      },
      manifest: {
        exports: [{ symbol: 'WindowTriggerConfig', module: 'src/types.ts', kind: 'type' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('fail');
    if (result.event !== 'fail') return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].symbol).toBe('WindowTriggerConfig');
    expect(result.failures[0].tsCode).toBe(2459);
  });

  test('fails with TS2307 when the module file does not exist', () => {
    const { projectDir, unitFile } = setupProject({
      files: { 'src/foo.ts': 'export const x = 1;\n' },
      manifest: {
        exports: [{ symbol: 'Whatever', module: 'src/missing.ts', kind: 'named' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('fail');
    if (result.event !== 'fail') return;
    expect(result.failures[0].tsCode).toBe(2307);
    expect(result.failures[0].module).toBe('src/missing.ts');
  });

  test('passes default exports', () => {
    const { projectDir, unitFile } = setupProject({
      files: { 'src/default.ts': 'export default class DefaultThing {}\n' },
      manifest: {
        exports: [{ symbol: 'DefaultThing', module: 'src/default.ts', kind: 'default' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('pass');
  });

  test('fails TS1192 when default export is missing (file is a module)', () => {
    const { projectDir, unitFile } = setupProject({
      files: { 'src/default.ts': 'export const x = 1;\n' },
      manifest: {
        exports: [{ symbol: 'DefaultThing', module: 'src/default.ts', kind: 'default' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('fail');
    if (result.event !== 'fail') return;
    expect(result.failures[0].tsCode).toBe(1192);
    expect(result.failures[0].kind).toBe('default');
  });

  test('handles re-exports (export { X } from)', () => {
    // Probe imports from the re-exporting file; tsc should resolve through.
    const { projectDir, unitFile } = setupProject({
      files: {
        'src/internal.ts': 'export class Inner {}\n',
        'src/index.ts': 'export { Inner } from "./internal";\n',
      },
      manifest: {
        exports: [{ symbol: 'Inner', module: 'src/index.ts', kind: 'named' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('pass');
  });

  test('handles aliased re-exports (export { X as Y } from)', () => {
    const { projectDir, unitFile } = setupProject({
      files: {
        'src/internal.ts': 'export class Inner {}\n',
        'src/index.ts': 'export { Inner as Renamed } from "./internal";\n',
      },
      manifest: {
        exports: [{ symbol: 'Renamed', module: 'src/index.ts', kind: 'named' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('pass');
  });

  test('handles export-star (export * from)', () => {
    const { projectDir, unitFile } = setupProject({
      files: {
        'src/a.ts': 'export class A {}\n',
        'src/index.ts': 'export * from "./a";\n',
      },
      manifest: {
        exports: [{ symbol: 'A', module: 'src/index.ts', kind: 'named' }],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('pass');
  });

  test('reports multiple failures across multiple modules in one run', () => {
    const { projectDir, unitFile } = setupProject({
      files: {
        'src/a.ts': 'class HiddenA {}\n',
        'src/b.ts': 'class HiddenB {}\n',
      },
      manifest: {
        exports: [
          { symbol: 'HiddenA', module: 'src/a.ts', kind: 'named' },
          { symbol: 'HiddenB', module: 'src/b.ts', kind: 'named' },
        ],
        consumes: [],
      },
    });

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('fail');
    if (result.event !== 'fail') return;
    expect(result.failures).toHaveLength(2);
    const symbols = result.failures.map(f => f.symbol).sort();
    expect(symbols).toEqual(['HiddenA', 'HiddenB']);
  });

  test('errors when no tsconfig.json is found', () => {
    const projectDir = makeTmpDir();
    const planDir = path.join(projectDir, '.vcp', 'plan', 'ralph', 'test');
    mkdirSync(planDir, { recursive: true });
    const unitFile = path.join(planDir, 'unit-1.md');
    writeFileSync(
      unitFile,
      '# Unit 1\n\n### Contract Manifest\n\n```json\n' +
        JSON.stringify({ exports: [{ symbol: 'X', module: 'src/x.ts' }], consumes: [] }) +
        '\n```\n',
    );

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('error');
    if (result.event !== 'error') return;
    expect(result.error).toContain('tsconfig');
  });

  test('errors on malformed manifest JSON', () => {
    const projectDir = makeTmpDir();
    writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify(DEFAULT_TSCONFIG));
    const planDir = path.join(projectDir, '.vcp', 'plan', 'ralph', 'test');
    mkdirSync(planDir, { recursive: true });
    const unitFile = path.join(planDir, 'unit-1.md');
    writeFileSync(unitFile, '# Unit 1\n\n### Contract Manifest\n\n```json\n{ "exports": [\n```\n');

    const result = verifyContract({ unitFile, projectDir });
    expect(result.event).toBe('error');
    if (result.event !== 'error') return;
    expect(result.error).toContain('JSON');
  });

  test('cleans up the probe file after verification (default)', () => {
    const { projectDir, unitFile } = setupProject({
      files: { 'src/foo.ts': 'export class Foo {}\n' },
      manifest: {
        exports: [{ symbol: 'Foo', module: 'src/foo.ts', kind: 'named' }],
        consumes: [],
      },
    });

    verifyContract({ unitFile, projectDir });
    const probePath = path.join(projectDir, '.vcp', '.contract-probe-unit-1.ts');
    expect(() => require('fs').readFileSync(probePath)).toThrow();
  });

  test('keeps the probe file when --keep-probe is set', () => {
    const { projectDir, unitFile } = setupProject({
      files: { 'src/foo.ts': 'export class Foo {}\n' },
      manifest: {
        exports: [{ symbol: 'Foo', module: 'src/foo.ts', kind: 'named' }],
        consumes: [],
      },
    });

    verifyContract({ unitFile, projectDir, keepProbe: true });
    const probePath = path.join(projectDir, '.vcp', '.contract-probe-unit-1.ts');
    const body = require('fs').readFileSync(probePath, 'utf-8');
    expect(body).toContain("import { Foo as _n0 } from");
  });
});

describe('formatFailureMessage', () => {
  test('renders TS2305 fail with actionable text', () => {
    const msg = formatFailureMessage({
      event: 'fail',
      unitId: 22,
      failures: [{
        symbol: 'WindowTriggerConfig',
        module: 'src/types.ts',
        kind: 'type',
        tsCode: 2305,
        message: "Module '...' has no exported member 'WindowTriggerConfig'.",
      }],
    });
    expect(msg).toContain('Unit 22');
    expect(msg).toContain('WindowTriggerConfig');
    expect(msg).toContain('Add the `export` keyword');
  });

  test('renders TS2307 fail differently from TS2305', () => {
    const msg = formatFailureMessage({
      event: 'fail',
      unitId: 1,
      failures: [{
        symbol: '(module not found)',
        module: 'src/missing.ts',
        kind: 'named',
        tsCode: 2307,
        message: "Cannot find module 'src/missing'.",
      }],
    });
    expect(msg).toContain('TS2307');
    expect(msg).toContain('src/missing.ts');
  });

  test('renders TS2459 with actionable "missing export keyword" text', () => {
    const msg = formatFailureMessage({
      event: 'fail',
      unitId: 27,
      failures: [{
        symbol: 'ConcurrencyManager',
        module: 'src/concurrency-manager.ts',
        kind: 'named',
        tsCode: 2459,
        message: "Module declares 'ConcurrencyManager' locally, but it is not exported.",
      }],
    });
    expect(msg).toContain('Unit 27');
    expect(msg).toContain('ConcurrencyManager');
    expect(msg).toContain('TS2459');
    expect(msg).toContain('declared locally');
    expect(msg).toContain('`export` keyword');
  });

  test('renders TS1192 as "default export missing"', () => {
    const msg = formatFailureMessage({
      event: 'fail',
      unitId: 5,
      failures: [{
        symbol: 'DefaultThing',
        module: 'src/default.ts',
        kind: 'default',
        tsCode: 1192,
        message: "Module has no default export.",
      }],
    });
    expect(msg).toContain('default export');
    expect(msg).toContain('export default');
  });
});
