import { appendFile, mkdir } from "fs/promises";
import { isAbsolute, join } from "path";

interface LogEntry {
  source: string;
  event: string;
  decision: "allow" | "block" | "warn" | "info" | "error";
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
    const logDir = join(projectRoot, ".vcp");
    await mkdir(logDir, { recursive: true });
    const logFile = join(logDir, "vcp.log");
    const ts = new Date().toISOString();
    const det = entry.details ? ` — ${entry.details}` : "";
    const line = `${ts} [${entry.event}] ${entry.source}: ${entry.decision}${det}\n`;
    await appendFile(logFile, line);
  } catch {
    // Never let logging failure break hook execution
  }
}
