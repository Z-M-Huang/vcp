import * as fs from 'fs';
import * as path from 'path';
import { loadDevBuddyConfig } from '../pipeline-config.ts';
import { sweepCompletedPlans } from './unit-state.ts';

const SWEEP_MARKER_BASENAME = '.sweep.marker';
const DEFAULT_SWEEP_INTERVAL_HOURS = 24;

/**
 * Returns true when a sweep is due. The gate is a per-repo marker at
 * .vcp/plan/.state/.sweep.marker; no marker or an old one → due.
 */
export function isSweepDue(projectDir: string, intervalHours: number): boolean {
  try {
    const markerPath = path.join(projectDir, '.vcp', 'plan', '.state', SWEEP_MARKER_BASENAME);
    const raw = fs.readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as { lastSweptAt?: string };
    if (!parsed.lastSweptAt) return true;
    const last = Date.parse(parsed.lastSweptAt);
    if (!Number.isFinite(last)) return true;
    return Date.now() - last > intervalHours * 3_600_000;
  } catch {
    return true;
  }
}

export function touchSweepMarker(projectDir: string): void {
  try {
    const stateRoot = path.join(projectDir, '.vcp', 'plan', '.state');
    fs.mkdirSync(stateRoot, { recursive: true });
    const markerPath = path.join(stateRoot, SWEEP_MARKER_BASENAME);
    fs.writeFileSync(markerPath, JSON.stringify({ lastSweptAt: new Date().toISOString() }));
  } catch {
    // best-effort — next invocation will retry the sweep
  }
}

/**
 * Run a retention sweep when due, reading retention_days and
 * sweep_interval_hours from dev-buddy config. Silent no-op on errors.
 */
export function maybeRunRetentionSweep(projectDir: string): void {
  let retentionDays = 7;
  let intervalHours = DEFAULT_SWEEP_INTERVAL_HOURS;
  try {
    const cfg = loadDevBuddyConfig() as unknown as { retention_days?: number; sweep_interval_hours?: number };
    if (typeof cfg.retention_days === 'number') retentionDays = cfg.retention_days;
    if (typeof cfg.sweep_interval_hours === 'number') intervalHours = cfg.sweep_interval_hours;
  } catch {
    // default values above
  }
  if (retentionDays === 0) return;
  if (!isSweepDue(projectDir, intervalHours)) return;
  try {
    sweepCompletedPlans(projectDir, { retentionDays });
    touchSweepMarker(projectDir);
  } catch {
    // sweep failures are non-fatal — a later run will retry
  }
}
