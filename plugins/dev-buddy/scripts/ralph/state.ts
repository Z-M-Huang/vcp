import * as fs from 'fs';
import * as path from 'path';
import type { StateMachineState } from './types.ts';

// ─── STATE FILE I/O ─────────────────────────────────────────────────────────

/**
 * Load persisted state from `.vcp/plan/.state/ralph-{slug}.json`.
 * Returns null if the file does not exist. Throws SyntaxError on malformed JSON.
 */
export function loadState(projectDir: string, slug: string): StateMachineState | null {
  const filePath = path.join(projectDir, '.vcp', 'plan', '.state', `ralph-${slug}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as StateMachineState;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Persist state to `.vcp/plan/.state/ralph-{slug}.json` atomically.
 * Uses temp file + rename so partial writes never corrupt state.
 */
export function saveState(projectDir: string, slug: string, state: StateMachineState): void {
  const filePath = path.join(projectDir, '.vcp', 'plan', '.state', `ralph-${slug}.json`);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ─── TASK ID PERSISTENCE ────────────────────────────────────────────────────

/**
 * Register a task ID in the state file under taskIds[ref].
 * Creates the state file if it doesn't exist.
 */
export function registerTaskId(
  projectDir: string,
  slug: string,
  ref: string,
  taskId: string,
): void {
  let state = loadState(projectDir, slug);
  if (!state) {
    state = {
      slug,
      status: 'discover',
      outerIteration: 0,
      reviewIteration: 0,
      units: [],
      lastAction: 'register-task',
      lastTimestamp: new Date().toISOString(),
      taskIds: {},
    };
  }
  state.taskIds = { ...state.taskIds, [ref]: taskId };
  state.lastTimestamp = new Date().toISOString();
  saveState(projectDir, slug, state);
}
