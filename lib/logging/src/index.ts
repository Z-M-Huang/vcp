/**
 * VCP-compatible file logger. Shared across plugins.
 *
 * Writes to <projectRoot>/.vcp/<filename> using a stable line format.
 * Gated on a caller-supplied `debug` flag. Rotates at 5 MB, keeping
 * 3 versions (.log, .log.1, .log.2). Never throws — logging failures
 * are silently ignored so they cannot break plugin execution.
 *
 * Call sites bind their filename via `createLogger(filename)`; a default
 * `vcpLog` is pre-bound to `vcp.log`.
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
   * post-mortem payloads that must survive a crash of the same process.
   * The log remains best-effort under rotation; durable truth lives elsewhere.
   */
  fsync?: boolean;
}

/** Hard per-event cap for log payloads. */
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

async function writeLog(
  projectRoot: string,
  entry: LogEntry,
  debug: boolean,
  filename: string,
): Promise<void> {
  if (!debug) return;
  if (!projectRoot || !isAbsolute(projectRoot)) return;
  try {
    const logDir = join(projectRoot, '.vcp');
    await mkdir(logDir, { recursive: true });
    const logFile = join(logDir, filename);
    await rotateIfNeeded(logFile);
    const ts = new Date().toISOString();
    const det = entry.details ? ` — ${entry.details}` : '';
    const line = `${ts} [${entry.event}] ${entry.source}: ${entry.decision}${det}\n`;
    if (entry.fsync) {
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
    // chmod is a no-op on Windows — that's acceptable
    try {
      await chmod(logFile, 0o600);
    } catch {
      // chmod failures are non-fatal
    }
  } catch {
    // Never let logging failure break execution
  }
}

/** Create a logger bound to a specific filename. */
export function createLogger(filename: string) {
  return (projectRoot: string, entry: LogEntry, debug: boolean = false) =>
    writeLog(projectRoot, entry, debug, filename);
}

/** Default logger — writes to `.vcp/vcp.log`. */
export const vcpLog = createLogger('vcp.log');

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
