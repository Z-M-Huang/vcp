/**
 * Tests for the dispatcher + state-machine. Each step handler is a
 * skeleton that signals patch.status='complete' on success, so a full
 * run walks discover -> requirements -> decompose -> build ->
 * code-review -> uat in six advance() calls.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATE_SCHEMA_VERSION, initRunDir, writeState, readState,
  type RunState,
} from '../src/engine/state-store.ts';
import { nextStep, STEP_ORDER, FIRST_STEP } from '../src/engine/dispatcher.ts';
import { advance } from '../src/engine/state-machine.ts';

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });

function makeProject(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'state-machine-'));
  tmpDirs.push(d);
  return d;
}

function newState(runId: string, projectPath: string, overrides: Partial<RunState> = {}): RunState {
  const now = new Date().toISOString();
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: runId,
    goal: 'test',
    project_path: projectPath,
    status: 'pending',
    step: FIRST_STEP,
    created_at: now,
    updated_at: now,
    subprocess_pids: [],
    ...overrides,
  };
}

describe('nextStep', () => {
  test('pending starts on whatever state.step says (discover by default)', () => {
    const state = newState('a', '/x');
    expect(nextStep(state)).toBe('discover');
  });

  test('running points at the next step to execute', () => {
    const state = newState('a', '/x', { status: 'running', step: 'requirements' });
    expect(nextStep(state)).toBe('requirements');
  });

  test('returns null when run is complete', () => {
    const state = newState('a', '/x', { status: 'complete', step: 'uat' });
    expect(nextStep(state)).toBeNull();
  });

  test('failed/interrupted resumes the same step', () => {
    const failed = newState('a', '/x', { status: 'failed', step: 'build' });
    expect(nextStep(failed)).toBe('build');
    const interrupted = newState('a', '/x', { status: 'interrupted', step: 'build' });
    expect(nextStep(interrupted)).toBe('build');
  });

  test('returns null when state.step is no longer in the canonical order', () => {
    const state = newState('a', '/x', { status: 'running', step: 'unknown-step' });
    expect(nextStep(state)).toBeNull();
  });
});

describe('advance', () => {
  test('returns failure on missing run', async () => {
    const dir = makeProject();
    const result = await advance(dir, 'does-not-exist');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no state.json/);
  });

  test('runs one step and advances state', async () => {
    const dir = makeProject();
    const runId = 'run-1';
    initRunDir(dir, runId);
    writeState(dir, newState(runId, dir));

    const result = await advance(dir, runId);
    expect(result.ok).toBe(true);
    expect(result.step_run).toBe('discover');
    expect(result.status).toBe('running');
    expect(result.next_step).toBe('requirements');

    const persisted = readState(dir, runId)!;
    expect(persisted.status).toBe('running');
    expect(persisted.step).toBe('requirements');
  });

  test('walks the full step order across six advance() calls', async () => {
    const dir = makeProject();
    const runId = 'run-full';
    initRunDir(dir, runId);
    writeState(dir, newState(runId, dir));

    const order: string[] = [];
    for (let i = 0; i < STEP_ORDER.length + 2; i++) {
      const r = await advance(dir, runId);
      if (r.step_run) order.push(r.step_run);
      if (r.status === 'complete') break;
    }
    expect(order).toEqual([...STEP_ORDER]);

    const persisted = readState(dir, runId)!;
    expect(persisted.status).toBe('complete');
  });

  test('idempotent on completed runs (no-op advance)', async () => {
    const dir = makeProject();
    const runId = 'run-done';
    initRunDir(dir, runId);
    writeState(dir, newState(runId, dir, { status: 'complete', step: 'uat' }));

    const result = await advance(dir, runId);
    expect(result.ok).toBe(true);
    expect(result.step_run).toBeNull();
    expect(result.next_step).toBeNull();
    expect(result.status).toBe('complete');
  });

  test('releases lease after a successful step', async () => {
    const dir = makeProject();
    const runId = 'run-lease';
    initRunDir(dir, runId);
    writeState(dir, newState(runId, dir));

    await advance(dir, runId);
    const leasePath = path.join(dir, '.vcp', 'ralph', runId, 'lease.json');
    expect(existsSync(leasePath)).toBe(false);
  });
});
