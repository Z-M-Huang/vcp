/**
 * VCP-compatible file logger for dev-buddy plugin.
 *
 * Writes to <projectRoot>/.vcp/dev-buddy.log using the same line format as
 * VCP core's vcpLog(). Reads debug flag from ~/.vcp/config.json. Never throws
 * — logging failures are silently ignored to prevent breaking plugin execution.
 */
import { appendFile, readFile, mkdir } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { homedir } from 'os';

export interface LogEntry {
  source: string;
  event: string;
  decision: 'allow' | 'block' | 'warn' | 'info' | 'error';
  details?: string;
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
