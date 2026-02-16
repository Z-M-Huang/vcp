/**
 * VCP Security Context — SessionStart hook (Layer A)
 *
 * Injects VCP rule summaries into the AI's context at session start.
 * Always exits 0 (informational injection, never blocks).
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import { generateContext } from "../lib/vcp-context-core";
import { vcpLog } from "../lib/vcp-logger";

const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const output = await generateContext(projectRoot);
if (output) console.log(output);

await vcpLog(projectRoot, {
  source: "security-context",
  event: "SessionStart",
  decision: "info",
  details: `Generated context (${output?.length ?? 0} chars)`,
});

process.exit(0);
