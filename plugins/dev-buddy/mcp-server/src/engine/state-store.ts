/**
 * State store for Ralph runs.
 *
 * Layout:
 *   <project_root>/.vcp/ralph/<run-id>/
 *     state.json          — current RunState (atomic write via temp + rename)
 *     lease.json          — active step lease (only present while a step runs)
 *     .lock               — per-run mutation lock (only during state read-mutate-rename)
 *     events.jsonl        — append-only event log for this run
 *     subprocess-stderr/  — captured stderr from any LLM subprocess this run spawned
 *
 * Concurrency primitives (per the v0.6.0 plan):
 *   - withLock     — guards the state-file mutation window. Stale-PID detection
 *                    via writing process.pid into the lock file.
 *   - tryAcquireLease / heartbeatLease / releaseLease — prevents two callers
 *                    from running the same step concurrently. Reclamation kicks
 *                    in when heartbeat_at is older than lease_ttl_ms * 2.
 */

import {
  openSync, writeFileSync, readFileSync, renameSync, unlinkSync,
  existsSync, mkdirSync, closeSync, readdirSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logEvent } from "./event-log.ts";

export const STATE_SCHEMA_VERSION = 1 as const;

export interface RunState {
  schema_version: typeof STATE_SCHEMA_VERSION;
  run_id: string;
  goal: string;
  project_path: string;
  status: "pending" | "running" | "complete" | "failed" | "interrupted";
  step: string;
  created_at: string;
  updated_at: string;
  summary?: string;
  subprocess_pids: number[];
}

export interface Lease {
  owner_id: string;
  step_name: string;
  acquired_at: string;
  heartbeat_at: string;
  lease_ttl_ms: number;
  owned_subprocess_pids: number[];
}

// ─── Path helpers ──────────────────────────────────────────────────────

export function ralphRoot(projectRoot: string): string {
  return join(projectRoot, ".vcp", "ralph");
}

export function runDir(projectRoot: string, runId: string): string {
  return join(ralphRoot(projectRoot), runId);
}

export function statePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "state.json");
}

export function leasePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "lease.json");
}

export function lockPath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), ".lock");
}

export function logPath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "events.jsonl");
}

// ─── Atomic write ──────────────────────────────────────────────────────

export function atomicWrite(path: string, content: string): void {
  const tmp = path + ".tmp." + process.pid + "." + Date.now();
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ─── Run dir lifecycle ─────────────────────────────────────────────────

export function initRunDir(projectRoot: string, runId: string): void {
  mkdirSync(runDir(projectRoot, runId), { recursive: true });
  mkdirSync(join(runDir(projectRoot, runId), "subprocess-stderr"), { recursive: true });
}

// ─── State read/write ──────────────────────────────────────────────────

export function readState(projectRoot: string, runId: string): RunState | null {
  const p = statePath(projectRoot, runId);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  if (raw.schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `state schema mismatch: got ${raw.schema_version}, expected ${STATE_SCHEMA_VERSION}`,
    );
  }
  return raw as RunState;
}

export function writeState(projectRoot: string, state: RunState): void {
  atomicWrite(statePath(projectRoot, state.run_id), JSON.stringify(state, null, 2));
}

// ─── Run discovery ─────────────────────────────────────────────────────

export interface RunSummary {
  run_id: string;
  status: RunState["status"];
  step: string;
  goal: string;
  created_at: string;
  updated_at: string;
}

export function listRuns(projectRoot: string): RunSummary[] {
  const root = ralphRoot(projectRoot);
  if (!existsSync(root)) return [];

  const entries: RunSummary[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let s;
    try {
      s = statSync(dir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    try {
      const st = readState(projectRoot, name);
      if (!st) continue;
      entries.push({
        run_id: st.run_id,
        status: st.status,
        step: st.step,
        goal: st.goal,
        created_at: st.created_at,
        updated_at: st.updated_at,
      });
    } catch {
      // Skip dirs whose state.json is missing or unreadable rather than
      // failing the whole list. The user can reach for events.jsonl
      // directly if they want to debug.
      continue;
    }
  }
  // Newest first
  entries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return entries;
}

// ─── Per-run file lock ─────────────────────────────────────────────────
// Scope: guard state.json read-mutate-rename. NOT the mechanism that
// prevents duplicate step work — that is the step lease below.

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(lockFile: string): number | null {
  try {
    const raw = readFileSync(lockFile, "utf-8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function withLock<T>(projectRoot: string, runId: string, fn: () => T): T {
  const lockFile = lockPath(projectRoot, runId);
  let fd: number | null = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      fd = openSync(lockFile, "wx");
      writeFileSync(lockFile, String(process.pid));
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLockPid(lockFile);
      if (holder !== null && holder !== process.pid && !pidAlive(holder)) {
        try { unlinkSync(lockFile); } catch { /* someone else cleaned up */ }
        continue;
      }
      Bun.sleepSync?.(25) ?? null;
    }
  }
  if (fd === null) {
    throw new Error(`could not acquire lock for run ${runId} within 3s`);
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* fd already closed */ }
    try { unlinkSync(lockFile); } catch { /* already removed */ }
  }
}

// ─── Step lease ────────────────────────────────────────────────────────
// Acquired BEFORE any subprocess fanout. Heartbeat every 2s. Released on
// step completion / abort / TTL expiry. If heartbeat is older than
// lease_ttl_ms * 2, a new caller may reclaim — reclamation logs a
// lease_expired event, kills owned subprocess PIDs, marks the step
// interrupted, then proceeds.

export interface LeaseAcquireResult {
  ok: true;
  owner_id: string;
  reclaimed_from?: string;
}

export interface LeaseBusyResult {
  ok: false;
  reason: "busy";
  owner_id: string;
  heartbeat_at: string;
}

export function tryAcquireLease(
  projectRoot: string,
  runId: string,
  stepName: string,
  leaseTtlMs: number,
): LeaseAcquireResult | LeaseBusyResult {
  return withLock(projectRoot, runId, () => {
    const p = leasePath(projectRoot, runId);
    const now = new Date().toISOString();
    let reclaimedFrom: string | undefined;

    if (existsSync(p)) {
      const existing = JSON.parse(readFileSync(p, "utf-8")) as Lease;
      const ageMs = Date.now() - new Date(existing.heartbeat_at).getTime();
      // Use the stored TTL, not the caller's; a new caller with a
      // shorter TTL must not shrink the holder's grace period.
      const stale = ageMs > existing.lease_ttl_ms * 2;
      if (!stale) {
        return {
          ok: false as const,
          reason: "busy" as const,
          owner_id: existing.owner_id,
          heartbeat_at: existing.heartbeat_at,
        };
      }
      reclaimedFrom = existing.owner_id;
      for (const pid of existing.owned_subprocess_pids) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      }
      logEvent(logPath(projectRoot, runId), {
        event: "lease_expired",
        run_id: runId,
        prior_owner: existing.owner_id,
        age_ms: ageMs,
        killed_pids: existing.owned_subprocess_pids,
      });
      try {
        const sp = statePath(projectRoot, runId);
        if (existsSync(sp)) {
          const raw = JSON.parse(readFileSync(sp, "utf-8"));
          if (raw.schema_version === STATE_SCHEMA_VERSION) {
            raw.status = "interrupted";
            raw.updated_at = now;
            raw.summary = `step ${existing.step_name} interrupted by lease reclaim (prior_owner=${existing.owner_id})`;
            atomicWrite(sp, JSON.stringify(raw, null, 2));
          }
        }
      } catch {
        // state may not yet exist; skip
      }
    }

    const ownerId = randomUUID();
    const lease: Lease = {
      owner_id: ownerId,
      step_name: stepName,
      acquired_at: now,
      heartbeat_at: now,
      lease_ttl_ms: leaseTtlMs,
      owned_subprocess_pids: [],
    };
    atomicWrite(p, JSON.stringify(lease, null, 2));
    logEvent(logPath(projectRoot, runId), {
      event: "lease_acquired",
      run_id: runId,
      owner_id: ownerId,
      step: stepName,
      reclaimed_from: reclaimedFrom,
    });
    return reclaimedFrom
      ? { ok: true as const, owner_id: ownerId, reclaimed_from: reclaimedFrom }
      : { ok: true as const, owner_id: ownerId };
  });
}

export function heartbeatLease(
  projectRoot: string,
  runId: string,
  ownerId: string,
  pids: number[],
): void {
  withLock(projectRoot, runId, () => {
    const p = leasePath(projectRoot, runId);
    if (!existsSync(p)) return;
    const lease = JSON.parse(readFileSync(p, "utf-8")) as Lease;
    if (lease.owner_id !== ownerId) return;
    lease.heartbeat_at = new Date().toISOString();
    lease.owned_subprocess_pids = pids;
    atomicWrite(p, JSON.stringify(lease, null, 2));
  });
}

export function releaseLease(
  projectRoot: string,
  runId: string,
  ownerId: string,
): void {
  withLock(projectRoot, runId, () => {
    const p = leasePath(projectRoot, runId);
    if (!existsSync(p)) return;
    const lease = JSON.parse(readFileSync(p, "utf-8")) as Lease;
    if (lease.owner_id !== ownerId) return;
    unlinkSync(p);
    logEvent(logPath(projectRoot, runId), {
      event: "lease_released",
      run_id: runId,
      owner_id: ownerId,
    });
  });
}

export function readLease(projectRoot: string, runId: string): Lease | null {
  const p = leasePath(projectRoot, runId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Lease;
  } catch {
    return null;
  }
}
