/**
 * VCP-compatible file logger for dev-buddy plugin.
 *
 * Writes to <projectRoot>/.vcp/dev-buddy.log using the same line format as
 * VCP core's vcpLog(). Always logs — no debug gate. Rotates at 2 MB, keeping
 * 3 versions (.log, .log.1, .log.2). Never throws — logging failures are
 * silently ignored to prevent breaking plugin execution.
 */
import { appendFile, readFile, mkdir, stat, rename, unlink } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { homedir } from 'os';

export interface LogEntry {
  source: string;
  event: string;
  decision: 'allow' | 'block' | 'warn' | 'info' | 'error';
  details?: string;
}

const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_LOG_VERSIONS = 3; // .log, .log.1, .log.2

/**
 * Rotate the log file when it exceeds MAX_LOG_SIZE.
 * Keeps at most MAX_LOG_VERSIONS files:
 *   .log (current) → .log.1 → .log.2 (oldest, deleted on next rotate)
 */
async function rotateIfNeeded(logFile: string): Promise<void> {
  try {
    const st = await stat(logFile);
    if (st.size < MAX_LOG_SIZE) return;

    for (let i = MAX_LOG_VERSIONS - 1; i >= 1; i--) {
      const older = `${logFile}.${i}`;
      if (i === MAX_LOG_VERSIONS - 1) {
        try { await unlink(older); } catch { /* may not exist */ }
      }
      const newer = i === 1 ? logFile : `${logFile}.${i - 1}`;
      try { await rename(newer, older); } catch { /* may not exist */ }
    }
  } catch {
    // File doesn't exist yet or can't stat — no rotation needed
  }
}

export async function vcpLog(
  projectRoot: string,
  entry: LogEntry,
  debug: boolean = false,
): Promise<void> {
  if (!debug) return;
  if (!projectRoot || !isAbsolute(projectRoot)) return;
  try {
    const logDir = join(projectRoot, '.vcp');
    await mkdir(logDir, { recursive: true });
    const logFile = join(logDir, 'dev-buddy.log');
    await rotateIfNeeded(logFile);
    const ts = new Date().toISOString();
    const det = entry.details ? ` — ${entry.details}` : '';
    const line = `${ts} [${entry.event}] ${entry.source}: ${entry.decision}${det}\n`;
    await appendFile(logFile, line);
  } catch {
    // Never let logging failure break execution
  }
}

/** Read debug flag from ~/.vcp/config.json. Returns false on any error. */
export async function isDebugEnabled(): Promise<boolean> {
  try {
    const configPath = join(homedir(), '.vcp', 'config.json');
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return config?.debug === true;
  } catch {
    return false;
  }
}
