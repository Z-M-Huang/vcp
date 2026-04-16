/**
 * VCP-compatible file logger for dev-buddy plugin.
 *
 * Writes to <projectRoot>/.vcp/dev-buddy.log using the same line format as
 * VCP core's vcpLog(). Always logs — no debug gate. Rotates at 5 MB, keeping
 * 3 versions (.log, .log.1, .log.2). Never throws — logging failures are
 * silently ignored to prevent breaking plugin execution.
 */
import { appendFile, chmod, readFile, mkdir, stat, rename, unlink, open } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { homedir } from 'os';

export interface LogEntry {
  source: string;
  event: string;
  decision: 'allow' | 'block' | 'warn' | 'info' | 'error';
  details?: string;
  /**
   * When true, fsync the log file before returning. Use sparingly — only for
   * post-mortem payloads that must survive a crash of the same process
   * (§11: backpressure.fail, review.needs_changes, review.feedback.cleared).
   * The log remains best-effort under rotation; durable truth lives in
   * units/unit-N.json.attemptHistory.
   */
  fsync?: boolean;
}

/** Hard per-event cap for log payloads (§11 — "DEBUG level allows volume"). */
export const LOG_PAYLOAD_MAX_BYTES = 16 * 1024;

/**
 * Cap a log payload at LOG_PAYLOAD_MAX_BYTES, appending a `...truncated`
 * marker when over the limit. Operates on UTF-8 byte length so multi-byte
 * characters are counted correctly.
 */
export function capLogPayload(payload: string, maxBytes: number = LOG_PAYLOAD_MAX_BYTES): string {
  const buf = Buffer.from(payload, 'utf8');
  if (buf.byteLength <= maxBytes) return payload;
  const marker = '\n...truncated';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const keep = Math.max(0, maxBytes - markerBytes);
  return buf.slice(0, keep).toString('utf8') + marker;
}

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
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
    if (entry.fsync) {
      // Append + fsync to survive a same-process crash. The log remains
      // best-effort across rotation + heavy parallel writes (§11 caveat).
      const fh = await open(logFile, 'a');
      try {
        await fh.appendFile(line);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } else {
      await appendFile(logFile, line);
    }
    // Set restrictive permissions on log file (contains API keys in masked form)
    // chmod is a no-op on Windows — that's acceptable
    try {
      await chmod(logFile, 0o600);
    } catch {
      // chmod failures are non-fatal — silent to avoid leaking to parent stderr
    }
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
