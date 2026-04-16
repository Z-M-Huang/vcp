import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  sweepCompletedPlans,
  readSweepMarker,
  markPlanComplete,
  readPlanState,
  writePlanState,
  planJsonPath,
  planRoot,
} from '../ralph/unit-state.ts';
import type { PlanState } from '../ralph/types.ts';

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true })); });

function makeTmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
  tmpDirs.push(d);
  return d;
}

function seedPlanState(projectDir: string, slug: string, overrides: Partial<PlanState> = {}): void {
  const stateDir = planRoot(projectDir, slug);
  mkdirSync(stateDir, { recursive: true });
  const state: PlanState = {
    slug,
    schemaVersion: 2,
    decomposeRunId: 'test-run',
    status: 'done',
    outerIteration: 0,
    reviewIteration: 0,
    taskIds: {},
    blockedBy: {},
    unitIds: [],
    unitFileHashes: {},
    startedAt: '2026-01-01T00:00:00Z',
    lastAction: 'test',
    lastTimestamp: new Date().toISOString(),
    ...overrides,
  };
  writePlanState(projectDir, slug, state);
}

function seedPlanDir(projectDir: string, slug: string): void {
  const dir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'unit-1.md'), '# Unit 1\nPlan content');
}

function seedTopLevelMd(projectDir: string, slug: string): void {
  const mdPath = path.join(projectDir, '.vcp', 'plan', `ralph-${slug}.md`);
  mkdirSync(path.dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, `**Status:** done\n**Slug:** ${slug}`);
}

describe('sweepCompletedPlans', () => {
  test('archives a plan older than retentionDays', () => {
    const projectDir = makeTmpDir();
    const slug = 'old-plan';
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();

    seedPlanState(projectDir, slug, {
      completedAt: tenDaysAgo,
      completionSource: 'state-machine',
    });
    seedPlanDir(projectDir, slug);
    seedTopLevelMd(projectDir, slug);

    const report = sweepCompletedPlans(projectDir, { retentionDays: 7 });

    expect(report.candidates).toHaveLength(1);
    expect(report.archived).toHaveLength(1);
    expect(report.archived[0].slug).toBe(slug);

    // Original locations should be gone
    expect(existsSync(planRoot(projectDir, slug))).toBe(false);
    expect(existsSync(path.join(projectDir, '.vcp', 'plan', 'ralph', slug))).toBe(false);
    expect(existsSync(path.join(projectDir, '.vcp', 'plan', `ralph-${slug}.md`))).toBe(false);

    // Archived to .archive/
    expect(existsSync(report.archived[0].target)).toBe(true);
    expect(existsSync(path.join(report.archived[0].target, 'state', 'plan.json'))).toBe(true);
    expect(existsSync(path.join(report.archived[0].target, 'plan', 'unit-1.md'))).toBe(true);
    expect(existsSync(path.join(report.archived[0].target, `ralph-${slug}.md`))).toBe(true);
  });

  test('does NOT archive a plan younger than retentionDays', () => {
    const projectDir = makeTmpDir();
    const slug = 'recent-plan';
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();

    seedPlanState(projectDir, slug, {
      completedAt: fiveDaysAgo,
      completionSource: 'state-machine',
    });

    const report = sweepCompletedPlans(projectDir, { retentionDays: 7 });

    expect(report.candidates).toHaveLength(0);
    expect(report.archived).toHaveLength(0);
    expect(existsSync(planRoot(projectDir, slug))).toBe(true);
  });

  test('does NOT archive a plan with completionSource=manual', () => {
    const projectDir = makeTmpDir();
    const slug = 'manual-plan';
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();

    seedPlanState(projectDir, slug, {
      completedAt: tenDaysAgo,
      completionSource: 'manual',
    });

    const report = sweepCompletedPlans(projectDir, { retentionDays: 7 });

    expect(report.candidates).toHaveLength(0);
  });

  test('does NOT archive a plan without completedAt', () => {
    const projectDir = makeTmpDir();
    seedPlanState(projectDir, 'incomplete', { status: 'build' });

    const report = sweepCompletedPlans(projectDir, { retentionDays: 7 });

    expect(report.candidates).toHaveLength(0);
  });

  test('retention_days=0 disables sweep', () => {
    const projectDir = makeTmpDir();
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    seedPlanState(projectDir, 'some-plan', {
      completedAt: tenDaysAgo,
      completionSource: 'state-machine',
    });

    const report = sweepCompletedPlans(projectDir, { retentionDays: 0 });

    expect(report.skipped).toBe('retention_disabled');
    expect(report.candidates).toHaveLength(0);
  });

  test('dry-run lists candidates without moving', () => {
    const projectDir = makeTmpDir();
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    seedPlanState(projectDir, 'dry-run-plan', {
      completedAt: tenDaysAgo,
      completionSource: 'state-machine',
    });

    const report = sweepCompletedPlans(projectDir, { dryRun: true, retentionDays: 7 });

    expect(report.candidates).toHaveLength(1);
    expect(report.archived).toHaveLength(0);
    expect(existsSync(planRoot(projectDir, 'dry-run-plan'))).toBe(true);
  });

  test('writes .sweep.marker after successful sweep', () => {
    const projectDir = makeTmpDir();
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    seedPlanState(projectDir, 'marker-plan', {
      completedAt: tenDaysAgo,
      completionSource: 'state-machine',
    });

    sweepCompletedPlans(projectDir, { retentionDays: 7 });

    const marker = readSweepMarker(projectDir);
    expect(marker).not.toBeNull();
    expect(marker!.lastSweptAt).toBeDefined();
  });

  test('handles empty state directory gracefully', () => {
    const projectDir = makeTmpDir();
    const report = sweepCompletedPlans(projectDir, { retentionDays: 7 });
    expect(report.candidates).toHaveLength(0);
    expect(report.archived).toHaveLength(0);
  });
});
