/**
 * VCP Stop Reminder — Stop hook
 *
 * Reminds the user to run VCP checks before committing.
 * Always exits 0 (informational only, never blocks).
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import { loadGlobalConfig } from "../lib/global-config";
import { vcpLog } from "../lib/vcp-logger";

const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const globalConfig = await loadGlobalConfig();
const debug = globalConfig?.debug ?? false;

const output = {
  systemMessage:
    "Reminder: Run /vcp-audit, /vcp-review-tests, or /vcp-pre-commit-review before committing.",
};
console.log(JSON.stringify(output));

await vcpLog(projectRoot, {
  source: "stop-reminder",
  event: "Stop",
  decision: "info",
  details: "Reminder shown",
}, debug);

process.exit(0);
