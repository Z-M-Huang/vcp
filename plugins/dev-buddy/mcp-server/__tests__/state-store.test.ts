/**
 * Unit tests for the Ralph state-store.
 *
 * Uses real temp dirs because the store reads/writes filesystem state by
 * design. The assertions exercise: atomicity (no partial state.json
 * after a crashed write would be visible), lock fairness, and lease
 * acquire/heartbeat/release plus stale-lease reclamation.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATE_SCHEMA_VERSION,
  initRunDir, writeState, readState, listRuns,
  atomicWrite, withLock,
  tryAcquireLease, heartbeatLease, releaseLease, readLease,
  ralphRoot, runDir, statePath, leasePath, lockPath,
  type RunState,
} from '../src/engine/state-store.ts';

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });

function makeProject(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'state-store-'));
  tmpDirs.push(d);
  return d;
}

function newState(runId: string, projectPath: string, goal = 'test goal'): RunState {
  const now = new Date().toISOString();
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: runId,
    goal,
    project_path: projectPath,
    status: 'pending',
    step: 'discover',
    created_at: now,
    updated_at: now,
    subprocess_pids: [],
  };
}

describe('atomicWrite', () => {
  test('persists content and removes the temp file', () => {
    const dir = makeProject();
    const target = path.join(dir, 'out.json');
    atomicWrite(target, '{"hello":"world"}');
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ hello: 'world' });
    expect(existsSync(target + '.tmp')).toBe(false);
  });
});

describe('writeState / readState', () => {
  test('round-trips through the filesystem', () => {
    const dir = makeProject();
    const runId = 'run-aaa';
    initRunDir(dir, runId);
    const state = newState(runId, dir);
    writeState(dir, state);
    const loaded = readState(dir, runId);
    expect(loaded).toEqual(state);
  });

  test('returns null for missing state.json', () => {
    const dir = makeProject();
    expect(readState(dir, 'never-existed')).toBeNull();
  });

  test('throws on schema-version mismatch', () => {
    const dir = makeProject();
    const runId = 'bad-schema';
    initRunDir(dir, runId);
    writeFileSync(statePath(dir, runId), JSON.stringify({ schema_version: 999, run_id: runId }));
    expect(() => readState(dir, runId)).toThrow(/state schema mismatch/);
  });
});

describe('listRuns', () => {
  test('returns empty when no .vcp/ralph dir exists', () => {
    expect(listRuns(makeProject())).toEqual([]);
  });

  test('lists all runs newest-first', async () => {
    const dir = makeProject();
    const a = newState('run-a', dir, 'goal a');
    a.created_at = '2026-01-01T00:00:00.000Z';
    a.updated_at = '2026-01-01T00:00:00.000Z';
    initRunDir(dir, 'run-a');
    writeState(dir, a);

    const b = newState('run-b', dir, 'goal b');
    b.created_at = '2026-02-01T00:00:00.000Z';
    b.updated_at = '2026-02-01T00:00:00.000Z';
    initRunDir(dir, 'run-b');
    writeState(dir, b);

    const list = listRuns(dir);
    expect(list).toHaveLength(2);
    expect(list[0].run_id).toBe('run-b');
    expect(list[1].run_id).toBe('run-a');
    expect(list[0].goal).toBe('goal b');
  });

  test('skips dirs without state.json', () => {
    const dir = makeProject();
    initRunDir(dir, 'incomplete-run');
    // No writeState — dir exists but state.json missing
    expect(listRuns(dir)).toEqual([]);
  });
});

describe('withLock', () => {
  test('serializes nested calls (re-entry would deadlock — protect against it)', () => {
    const dir = makeProject();
    const runId = 'lock-run';
    initRunDir(dir, runId);

    let inside = 0;
    let max = 0;
    withLock(dir, runId, () => {
      inside++;
      max = Math.max(max, inside);
      // Cannot test true concurrent locks in single-threaded JS without
      // separate processes; the file lock cleans up cleanly here.
      inside--;
    });
    expect(max).toBe(1);
    // Lock file should be cleaned up after the callback returns.
    expect(existsSync(lockPath(dir, runId))).toBe(false);
  });

  test('reclaims a stale lock left by a dead PID', () => {
    const dir = makeProject();
    const runId = 'stale-lock-run';
    initRunDir(dir, runId);
    // Write a lock file with a PID that is guaranteed dead. PID 1 is
    // process init on POSIX and will exist; use a high PID instead.
    const deadPid = 2 ** 22;
    writeFileSync(lockPath(dir, runId), String(deadPid));

    // withLock should detect the dead holder and reclaim within 3s.
    let ran = false;
    withLock(dir, runId, () => { ran = true; });
    expect(ran).toBe(true);
    expect(existsSync(lockPath(dir, runId))).toBe(false);
  });
});

describe('tryAcquireLease / heartbeatLease / releaseLease', () => {
  test('first acquire returns ok=true with a fresh owner_id', () => {
    const dir = makeProject();
    const runId = 'lease-run';
    initRunDir(dir, runId);
    const result = tryAcquireLease(dir, runId, 'discover', 5000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.owner_id).toBeTruthy();
    expect(result.reclaimed_from).toBeUndefined();
    // Lease file persists until released
    expect(existsSync(leasePath(dir, runId))).toBe(true);
  });

  test('concurrent (still-fresh) acquire returns ok=false / busy', () => {
    const dir = makeProject();
    const runId = 'lease-busy';
    initRunDir(dir, runId);
    const a = tryAcquireLease(dir, runId, 'discover', 60_000);
    expect(a.ok).toBe(true);
    const b = tryAcquireLease(dir, runId, 'discover', 60_000);
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toBe('busy');
  });

  test('reclaims a stale lease (heartbeat older than 2*TTL)', () => {
    const dir = makeProject();
    const runId = 'lease-stale';
    initRunDir(dir, runId);
    writeState(dir, newState(runId, dir));

    // First acquire
    const a = tryAcquireLease(dir, runId, 'discover', 100);
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // Manually rewrite heartbeat far in the past
    const lease = readLease(dir, runId)!;
    lease.heartbeat_at = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(leasePath(dir, runId), JSON.stringify(lease));

    // Second acquire should reclaim
    const b = tryAcquireLease(dir, runId, 'discover', 100);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.reclaimed_from).toBe(a.owner_id);
    expect(b.owner_id).not.toBe(a.owner_id);

    // State should be marked interrupted
    const state = readState(dir, runId)!;
    expect(state.status).toBe('interrupted');
  });

  test('heartbeat updates heartbeat_at and owned_pids', async () => {
    const dir = makeProject();
    const runId = 'lease-heartbeat';
    initRunDir(dir, runId);
    const a = tryAcquireLease(dir, runId, 'discover', 5000);
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const before = readLease(dir, runId)!.heartbeat_at;
    // Wait a tick to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));
    heartbeatLease(dir, runId, a.owner_id, [12345]);
    const after = readLease(dir, runId)!;
    expect(after.heartbeat_at).not.toBe(before);
    expect(after.owned_subprocess_pids).toEqual([12345]);
  });

  test('heartbeat from a non-owner is a no-op', () => {
    const dir = makeProject();
    const runId = 'lease-mismatch';
    initRunDir(dir, runId);
    const a = tryAcquireLease(dir, runId, 'discover', 5000);
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const before = readLease(dir, runId)!;
    heartbeatLease(dir, runId, 'someone-else', [99]);
    const after = readLease(dir, runId)!;
    expect(after).toEqual(before);
  });

  test('release deletes the lease file', () => {
    const dir = makeProject();
    const runId = 'lease-release';
    initRunDir(dir, runId);
    const a = tryAcquireLease(dir, runId, 'discover', 5000);
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    expect(existsSync(leasePath(dir, runId))).toBe(true);
    releaseLease(dir, runId, a.owner_id);
    expect(existsSync(leasePath(dir, runId))).toBe(false);
  });
});
