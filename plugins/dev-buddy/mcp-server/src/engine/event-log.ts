import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append a JSONL event to a per-run log file. Logging must never throw,
 * never write to stdout (reserved for MCP framing), and never write to
 * stderr (some hosts surface stderr as a user-facing alert).
 */
export function logEvent(logPath: string, event: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
    );
  } catch {
    // Swallow; logging is best-effort.
  }
}
