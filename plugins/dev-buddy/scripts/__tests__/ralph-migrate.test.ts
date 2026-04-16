import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  ensureStateMigrated,
  isMigrationNeeded,
  listLegacyMonolithSlugs,
  scanOrphanStagingDirs,
  MAX_MIGRATE_MS,
} from '../ralph/migrate.ts';

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function freshProjectDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ralph-migrate-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeLegacyMonolith(projectDir: string, slug: string, overrides: object = {}): string {
  const stateDir = path.join(projectDir, '.vcp', 'plan', '.state');
  mkdirSync(stateDir, { recursive: true });
  const body = {
    slug,
    status: 'build',
    outerIteration: 0,
    reviewIteration: 0,
    units: [], // legacy vestigial empty array — the bug the refactor removes
    lastAction: 'some-action',
    lastTimestamp: '2026-03-15T10:00:00.000Z',
    taskIds: { 'unit:1': 'task_abc', 'unit:2': 'task_def' },
    blockedBy: { 'unit:2': ['unit:1'] },
    ...overrides,
  };
  const p = path.join(stateDir, `ralph-${slug}.json`);
  writeFileSync(p, JSON.stringify(body, null, 2), 'utf-8');
  return p;
}

function writeUnitMd(projectDir: string, slug: string, id: number, body: string): string {
  const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
  mkdirSync(unitsDir, { recursive: true });
  const p = path.join(unitsDir, `unit-${id}.md`);
  writeFileSync(p, body, 'utf-8');
  return p;
}

function unitMdBody(id: number, status: 'pending' | 'done' | 'failed' = 'pending', attempts = 0, feedback: string | null = null): string {
  const base = [
    `# Unit ${id}: Example unit`,
    `**Status:** ${status}`,
    `**Attempts:** ${attempts}`,
    `**Max Attempts:** 5`,
    '',
    '## Done When',
    'All backpressure commands pass.',
    '',
    '### Dependencies',
    '- Depends on: none',
    '',
  ].join('\n');
  if (!feedback) return base;
  return base + `\n<!-- RUNNER_TAIL_START -->\n## Review Feedback\n${feedback}\n\n## Latest Build Attempt\nattempt=${attempts} outcome=retry\n`;
}

// ─── Detection ──────────────────────────────────────────────────────────────

describe('isMigrationNeeded', () => {
  test('returns true when legacy exists and new does not', () => {
    const pd = freshProjectDir();
    writeLegacyMonolith(pd, 'foo');
    expect(isMigrationNeeded(pd, 'foo')).toBe(true);
  });

  test('returns false when neither exists', () => {
    const pd = freshProjectDir();
    expect(isMigrationNeeded(pd, 'bar')).toBe(false);
  });

  test('returns false when new dir already exists', () => {
    const pd = freshProjectDir();
    const newDir = path.join(pd, '.vcp', 'plan', '.state', 'ralph-baz');
    mkdirSync(newDir, { recursive: true });
    writeFileSync(path.join(newDir, 'plan.json'), '{}');
    writeLegacyMonolith(pd, 'baz');
    expect(isMigrationNeeded(pd, 'baz')).toBe(false);
  });
});

describe('listLegacyMonolithSlugs', () => {
  test('returns empty when .state is missing', () => {
    const pd = freshProjectDir();
    expect(listLegacyMonolithSlugs(pd)).toEqual([]);
  });

  test('lists all legacy ralph-*.json files', () => {
    const pd = freshProjectDir();
    writeLegacyMonolith(pd, 'one');
    writeLegacyMonolith(pd, 'two');
    writeLegacyMonolith(pd, 'three');
    // Non-ralph files should be ignored
    writeFileSync(path.join(pd, '.vcp', 'plan', '.state', 'other.json'), '{}');
    expect(listLegacyMonolithSlugs(pd).sort()).toEqual(['one', 'three', 'two']);
  });
});

// ─── Happy path (regression test 5) ─────────────────────────────────────────

describe('ensureStateMigrated — happy path', () => {
  test('migrates legacy monolith + unit files into per-unit tree', () => {
    const pd = freshProjectDir();
    writeLegacyMonolith(pd, 'adr40', {
      status: 'build',
      outerIteration: 2,
      reviewIteration: 1,
    });
    writeUnitMd(pd, 'adr40', 1, unitMdBody(1, 'done', 3));
    writeUnitMd(pd, 'adr40', 2, unitMdBody(2, 'failed', 5, 'Needs retry: rate limiter was not wired.'));
    writeUnitMd(pd, 'adr40', 3, unitMdBody(3, 'pending', 0));

    const result = ensureStateMigrated(pd, 'adr40');
    expect(result.status).toBe('migrated');
    expect(result.unitsMigrated).toBe(3);

    // plan.json was written
    const planJson = JSON.parse(readFileSync(path.join(pd, '.vcp', 'plan', '.state', 'ralph-adr40', 'plan.json'), 'utf-8'));
    expect(planJson.schemaVersion).toBe(2);
    expect(planJson.slug).toBe('adr40');
    expect(planJson.status).toBe('build');
    expect(planJson.outerIteration).toBe(2);
    expect(planJson.reviewIteration).toBe(1);
    expect(planJson.unitIds.sort((a: number, b: number) => a - b)).toEqual([1, 2, 3]);
    expect(planJson.decomposeRunId).toMatch(/^[0-9a-z]+-[0-9a-f]+$/);
    expect(planJson.taskIds['unit:1']).toBe('task_abc');
    expect(planJson.blockedBy['unit:2']).toEqual(['unit:1']);
    expect(planJson.completedAt).toBeUndefined();

    // Each unit has a state file with matching decomposeRunId
    const unit1 = JSON.parse(readFileSync(path.join(pd, '.vcp', 'plan', '.state', 'ralph-adr40', 'units', 'unit-1.json'), 'utf-8'));
    expect(unit1.id).toBe(1);
    expect(unit1.status).toBe('done');
    expect(unit1.attempts).toBe(3);
    expect(unit1.generation).toBe(0);
    expect(unit1.attemptHistory).toEqual([]);
    expect(unit1.decomposeRunId).toBe(planJson.decomposeRunId);

    const unit2 = JSON.parse(readFileSync(path.join(pd, '.vcp', 'plan', '.state', 'ralph-adr40', 'units', 'unit-2.json'), 'utf-8'));
    expect(unit2.status).toBe('failed');
    expect(unit2.reviewFeedback).toContain('rate limiter was not wired');
    expect(unit2.unitFileHashAtReview).toMatch(/^[a-f0-9]{40}$/);

    const unit3 = JSON.parse(readFileSync(path.join(pd, '.vcp', 'plan', '.state', 'ralph-adr40', 'units', 'unit-3.json'), 'utf-8'));
    expect(unit3.reviewFeedback).toBeUndefined();

    // Legacy monolith moved to .legacy/
    expect(existsSync(path.join(pd, '.vcp', 'plan', '.state', 'ralph-adr40.json'))).toBe(false);
    const legacyArchive = path.join(pd, '.vcp', 'plan', '.state', '.legacy');
    expect(existsSync(legacyArchive)).toBe(true);
  });

  test('idempotent: second invocation returns already_migrated', () => {
    const pd = freshProjectDir();
    writeLegacyMonolith(pd, 'idem');
    writeUnitMd(pd, 'idem', 1, unitMdBody(1));
    ensureStateMigrated(pd, 'idem');
    const second = ensureStateMigrated(pd, 'idem');
    expect(second.status).toBe('already_migrated');
  });

  test('nothing_to_migrate when neither layout exists', () => {
    const pd = freshProjectDir();
    const result = ensureStateMigrated(pd, 'nope');
    expect(result.status).toBe('nothing_to_migrate');
  });
});

// ─── Crash recovery — regression test 5b (post-commit, pre-retire) ─────────

describe('ensureStateMigrated — post-commit, pre-retire crash recovery', () => {
  test('retires dangling legacy monolith when new layout already exists', () => {
    const pd = freshProjectDir();
    // Simulate: new tree already committed
    const newDir = path.join(pd, '.vcp', 'plan', '.state', 'ralph-crash');
    mkdirSync(path.join(newDir, 'units'), { recursive: true });
    writeFileSync(path.join(newDir, 'plan.json'), JSON.stringify({
      slug: 'crash', schemaVersion: 2, status: 'build',
    }));
    // Simulate: legacy monolith still present (crash happened before retirement)
    writeLegacyMonolith(pd, 'crash');

    const result = ensureStateMigrated(pd, 'crash');
    expect(result.status).toBe('retired_dangling_legacy');
    expect(result.legacyArchivedAt).toBeTruthy();

    // Legacy is now under .legacy/
    expect(existsSync(path.join(pd, '.vcp', 'plan', '.state', 'ralph-crash.json'))).toBe(false);
    expect(existsSync(path.join(pd, '.vcp', 'plan', '.state', '.legacy'))).toBe(true);
    // New tree is untouched
    expect(existsSync(path.join(newDir, 'plan.json'))).toBe(true);
  });
});

// ─── Orphan recovery — regression test 5a (mid-stage crash) ────────────────

describe('scanOrphanStagingDirs', () => {
  test('removes staging dirs with started_at older than MAX_MIGRATE_MS and no finished_at', () => {
    const pd = freshProjectDir();
    const stagingRoot = path.join(pd, '.vcp', 'plan', '.state', '.migrate');
    const staleTxn = path.join(stagingRoot, 'stale-txn');
    mkdirSync(staleTxn, { recursive: true });
    const staleStartedAt = new Date(Date.now() - MAX_MIGRATE_MS - 60_000).toISOString();
    writeFileSync(path.join(staleTxn, '_manifest.json'), JSON.stringify({
      txnId: 'stale-txn', slug: 'oops', sources: {}, started_at: staleStartedAt,
      finished_at: null, units: [], progressFilesAttributed: [], notes: [],
    }));

    const fresh = path.join(stagingRoot, 'fresh-txn');
    mkdirSync(fresh, { recursive: true });
    writeFileSync(path.join(fresh, '_manifest.json'), JSON.stringify({
      txnId: 'fresh-txn', slug: 'fresh', sources: {}, started_at: new Date().toISOString(),
      finished_at: null, units: [], progressFilesAttributed: [], notes: [],
    }));

    const reports = scanOrphanStagingDirs(pd);
    expect(reports.length).toBe(1);
    expect(reports[0].slug).toBe('oops');
    expect(reports[0].removed).toBe(true);
    expect(existsSync(staleTxn)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test('dryRun leaves staging dirs in place', () => {
    const pd = freshProjectDir();
    const stagingRoot = path.join(pd, '.vcp', 'plan', '.state', '.migrate');
    const staleTxn = path.join(stagingRoot, 'dry-stale');
    mkdirSync(staleTxn, { recursive: true });
    writeFileSync(path.join(staleTxn, '_manifest.json'), JSON.stringify({
      txnId: 'dry-stale', slug: 'dry', sources: {},
      started_at: new Date(Date.now() - MAX_MIGRATE_MS - 5_000).toISOString(),
      finished_at: null, units: [], progressFilesAttributed: [], notes: [],
    }));

    const reports = scanOrphanStagingDirs(pd, { dryRun: true });
    expect(reports.length).toBe(1);
    expect(reports[0].removed).toBe(false);
    expect(existsSync(staleTxn)).toBe(true);
  });

  test('removes committed-but-uncleaned staging shells regardless of age', () => {
    const pd = freshProjectDir();
    const stagingRoot = path.join(pd, '.vcp', 'plan', '.state', '.migrate');
    const freshlyFinished = path.join(stagingRoot, 'finished-txn');
    mkdirSync(freshlyFinished, { recursive: true });
    writeFileSync(path.join(freshlyFinished, '_manifest.json'), JSON.stringify({
      txnId: 'finished-txn', slug: 'done', sources: {},
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      units: [], progressFilesAttributed: [], notes: [],
    }));
    const reports = scanOrphanStagingDirs(pd);
    expect(reports.length).toBe(1);
    expect(existsSync(freshlyFinished)).toBe(false);
  });

  test('returns [] when .migrate directory does not exist', () => {
    const pd = freshProjectDir();
    expect(scanOrphanStagingDirs(pd)).toEqual([]);
  });

  test('falls back to mtime when manifest is missing', () => {
    const pd = freshProjectDir();
    const stagingRoot = path.join(pd, '.vcp', 'plan', '.state', '.migrate');
    const noManifest = path.join(stagingRoot, 'no-manifest');
    mkdirSync(noManifest, { recursive: true });
    const oldMs = Date.now() - MAX_MIGRATE_MS - 60_000;
    utimesSync(noManifest, new Date(oldMs), new Date(oldMs));
    const reports = scanOrphanStagingDirs(pd);
    expect(reports.length).toBe(1);
    expect(reports[0].reason).toBe('staging with no manifest');
    expect(existsSync(noManifest)).toBe(false);
  });
});
