/**
 * Unit tests for scan-runner.ts deterministic logic.
 *
 * Filesystem-walk tests use real temp directories with fixture trees
 * because the walker reads dirent metadata directly — mocking fs would
 * shadow what we're trying to verify (recursion, exclude rules, source
 * detection).
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  parseArgs,
  resolveManifestUri,
  loadManifestResources,
  walkProject,
  assignPriority,
  categorize,
  renderMarkdown,
} from '../scripts/scan-runner.ts';

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });

function makeTmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'scan-runner-'));
  tmpDirs.push(d);
  return d;
}

describe('parseArgs', () => {
  test('defaults format to markdown and projectRoot to cwd', () => {
    const args = parseArgs(['bun', 'scan-runner.ts']);
    expect(args.format).toBe('markdown');
    expect(args.projectRoot).toBe(process.cwd());
  });

  test('--format json', () => {
    const args = parseArgs(['bun', 'scan-runner.ts', '--format', 'json']);
    expect(args.format).toBe('json');
  });

  test('rejects invalid format', () => {
    expect(() => parseArgs(['bun', 'scan-runner.ts', '--format', 'yaml']))
      .toThrow(/Invalid --format/);
  });

  test('--path captures subtree', () => {
    const args = parseArgs(['bun', 'scan-runner.ts', '--path', 'src/api']);
    expect(args.path).toBe('src/api');
  });

  test('rejects unknown flag', () => {
    expect(() => parseArgs(['bun', 'scan-runner.ts', '--mode', 'x']))
      .toThrow(/Unknown flag: --mode/);
  });
});

describe('resolveManifestUri', () => {
  test('strips ../ from manifest-relative URI', () => {
    expect(resolveManifestUri('../src/api/README.md')).toBe('src/api/README.md');
  });

  test('strips multiple ../ segments', () => {
    expect(resolveManifestUri('../../shared/docs/api.md')).toBe('../shared/docs/api.md');
  });

  test('handles ./ prefix', () => {
    expect(resolveManifestUri('./README.md')).toBe('.mcp/README.md');
  });
});

describe('assignPriority', () => {
  test('critical for src/app/lib/core', () => {
    expect(assignPriority('src', 0)).toBe('critical');
    expect(assignPriority('app', 0)).toBe('critical');
    expect(assignPriority('lib', 0)).toBe('critical');
    expect(assignPriority('core', 0)).toBe('critical');
  });

  test('critical for *api / *routes suffixes', () => {
    expect(assignPriority('src/api', 0)).toBe('critical');
    expect(assignPriority('packages/web-api', 0)).toBe('critical');
    expect(assignPriority('src/routes', 0)).toBe('critical');
  });

  test('high for services/utils/auth/models/shared', () => {
    expect(assignPriority('src/services', 0)).toBe('high');
    expect(assignPriority('src/auth', 0)).toBe('high');
    expect(assignPriority('shared', 0)).toBe('high');
  });

  test('medium for config/middleware/helpers', () => {
    expect(assignPriority('src/config', 0)).toBe('medium');
    expect(assignPriority('src/middleware', 0)).toBe('medium');
  });

  test('low for tests/scripts/tools/examples', () => {
    expect(assignPriority('tests', 0)).toBe('low');
    expect(assignPriority('__tests__', 0)).toBe('low');
    expect(assignPriority('scripts', 0)).toBe('low');
  });

  test('default by file count when name is generic', () => {
    expect(assignPriority('src/something-unique', 12)).toBe('high');
    expect(assignPriority('src/something-unique', 7)).toBe('medium');
    expect(assignPriority('src/something-unique', 2)).toBe('low');
  });
});

describe('loadManifestResources', () => {
  test('returns exists=false when manifest is missing', () => {
    const dir = makeTmp();
    const result = loadManifestResources(dir);
    expect(result.exists).toBe(false);
    expect(result.resources).toEqual([]);
  });

  test('parses resources array from valid YAML', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, '.mcp'));
    writeFileSync(path.join(dir, '.mcp', 'manifest.yml'), `
schemaVersion: '1.0'
name: test-project
resources:
  - name: src_readme
    uri: ../src/README.md
    description: Source root readme
  - name: docs_api
    uri: ../docs/api.md
    description: API docs
`.trimStart());
    const result = loadManifestResources(dir);
    expect(result.exists).toBe(true);
    expect(result.resources).toHaveLength(2);
    expect(result.resources[0]).toEqual({
      name: 'src_readme',
      uri: '../src/README.md',
      description: 'Source root readme',
    });
  });

  test('skips invalid resource entries', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, '.mcp'));
    writeFileSync(path.join(dir, '.mcp', 'manifest.yml'), `
resources:
  - name: ok
    uri: ../ok.md
  - missing-uri: yes
  - uri: ../no-name.md
`.trimStart());
    const result = loadManifestResources(dir);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].name).toBe('ok');
  });

  test('throws on malformed YAML', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, '.mcp'));
    writeFileSync(path.join(dir, '.mcp', 'manifest.yml'), 'resources:\n  - this: is\n   :bad indent');
    expect(() => loadManifestResources(dir)).toThrow(/not valid YAML/);
  });
});

describe('walkProject', () => {
  test('finds source dirs and doc files', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const x = 1;');
    writeFileSync(path.join(dir, 'src', 'README.md'), '# src');
    writeFileSync(path.join(dir, 'README.md'), '# project');

    const result = walkProject(dir);
    expect(result.significantDirs.has('src')).toBe(true);
    expect(result.docFiles.has('src/README.md')).toBe(true);
    expect(result.docFiles.has('README.md')).toBe(true);
  });

  test('excludes node_modules and dist', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    mkdirSync(path.join(dir, 'dist'));
    writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'x');
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'index.ts'), 'x');

    const result = walkProject(dir);
    expect(result.significantDirs.has('src')).toBe(true);
    expect([...result.significantDirs].some((d) => d.includes('node_modules'))).toBe(false);
    expect([...result.significantDirs].some((d) => d.includes('dist'))).toBe(false);
  });

  test('detects non-markdown docs', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, 'api'));
    writeFileSync(path.join(dir, 'api', 'openapi.yaml'), 'openapi: 3.0.0');
    writeFileSync(path.join(dir, 'api', 'index.ts'), 'x');

    const result = walkProject(dir);
    expect(result.nonMarkdownDocs.length).toBe(1);
    expect(result.nonMarkdownDocs[0]).toBe('api/openapi.yaml');
  });

  test('subtree limits scope', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(dir, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'a', 'a.ts'), 'x');
    writeFileSync(path.join(dir, 'src', 'b', 'b.ts'), 'x');

    const result = walkProject(dir, 'src/a');
    expect(result.significantDirs.has('src/a')).toBe(true);
    expect(result.significantDirs.has('src/b')).toBe(false);
  });

  test('returns empty result for missing subtree', () => {
    const dir = makeTmp();
    const result = walkProject(dir, 'does/not/exist');
    expect(result.significantDirs.size).toBe(0);
    expect(result.docFiles.size).toBe(0);
  });

  test('rejects subtree paths that escape projectRoot', () => {
    const dir = makeTmp();
    expect(() => walkProject(dir, '../../etc'))
      .toThrow(/resolves outside project root/);
    expect(() => walkProject(dir, '/totally/elsewhere'))
      .toThrow(/resolves outside project root/);
  });
});

describe('categorize', () => {
  test('classifies documented-indexed when manifest has the doc', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'README.md'), '# src');

    const report = categorize({
      projectRoot: dir,
      docFiles: new Set(['src/README.md']),
      significantDirs: new Set(['src']),
      manifestResourcePaths: new Set(['src/README.md']),
      nonMarkdownDocs: [],
      scope: 'entire project',
    });

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].status).toBe('documented-indexed');
    expect(report.totals.documentedIndexed).toBe(1);
  });

  test('classifies documented-not-indexed when manifest is missing the doc', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'README.md'), '# src');

    const report = categorize({
      projectRoot: dir,
      docFiles: new Set(['src/README.md']),
      significantDirs: new Set(['src']),
      manifestResourcePaths: new Set(),
      nonMarkdownDocs: [],
      scope: 'entire project',
    });

    expect(report.entries[0].status).toBe('documented-not-indexed');
  });

  test('classifies undocumented and assigns priority', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'index.ts'), 'x');

    const report = categorize({
      projectRoot: dir,
      docFiles: new Set(),
      significantDirs: new Set(['src']),
      manifestResourcePaths: new Set(),
      nonMarkdownDocs: [],
      scope: 'entire project',
    });

    expect(report.entries[0].status).toBe('undocumented');
    expect(report.entries[0].priority).toBe('critical');
  });

  test('flags stale entries when manifest references deleted files', () => {
    const dir = makeTmp();

    const report = categorize({
      projectRoot: dir,
      docFiles: new Set(),
      significantDirs: new Set(),
      manifestResourcePaths: new Set(['src/legacy/README.md']),
      nonMarkdownDocs: [],
      scope: 'entire project',
    });

    const stale = report.entries.find((e) => e.status === 'stale');
    expect(stale).toBeDefined();
    expect(stale!.docFile).toBe('src/legacy/README.md');
  });

  test('orders stale before undocumented before documented entries', () => {
    const dir = makeTmp();
    mkdirSync(path.join(dir, 'src'));
    mkdirSync(path.join(dir, 'lib'));
    writeFileSync(path.join(dir, 'src', 'index.ts'), 'x');
    writeFileSync(path.join(dir, 'lib', 'README.md'), '# lib');

    const report = categorize({
      projectRoot: dir,
      docFiles: new Set(['lib/README.md']),
      significantDirs: new Set(['src', 'lib']),
      manifestResourcePaths: new Set(['lib/README.md', 'old/dead.md']),
      nonMarkdownDocs: [],
      scope: 'entire project',
    });

    const statuses = report.entries.map((e) => e.status);
    const idxStale = statuses.indexOf('stale');
    const idxUndoc = statuses.indexOf('undocumented');
    const idxDocIdx = statuses.indexOf('documented-indexed');
    expect(idxStale).toBeLessThan(idxUndoc);
    expect(idxUndoc).toBeLessThan(idxDocIdx);
  });
});

describe('renderMarkdown', () => {
  test('renders header, totals, and table', () => {
    const md = renderMarkdown({
      scope: 'entire project',
      totals: { significantDirs: 3, documentedIndexed: 1, documentedNotIndexed: 1, undocumented: 1, stale: 0 },
      entries: [
        { path: 'src', status: 'undocumented', priority: 'critical', inManifest: false },
        { path: 'lib', status: 'documented-not-indexed', docFile: 'lib/README.md', inManifest: false },
        { path: 'core', status: 'documented-indexed', docFile: 'core/README.md', inManifest: true },
      ],
      nonMarkdownDocs: [],
    });

    expect(md).toContain('Documentation Coverage Report');
    expect(md).toContain('Scope: entire project');
    expect(md).toContain('Total significant directories: 3');
    expect(md).toContain('| src | Undocumented | critical | — | — |');
    expect(md).toContain('| lib | Documented, not indexed |');
    expect(md).toContain('| core | Documented & indexed |');
  });

  test('lists non-markdown docs when present', () => {
    const md = renderMarkdown({
      scope: 'entire project',
      totals: { significantDirs: 0, documentedIndexed: 0, documentedNotIndexed: 0, undocumented: 0, stale: 0 },
      entries: [],
      nonMarkdownDocs: ['api/openapi.yaml'],
    });
    expect(md).toContain('Non-markdown documentation detected');
    expect(md).toContain('  - api/openapi.yaml');
  });
});
