/**
 * VCP Security Context — SessionStart hook (Layer A)
 *
 * Injects VCP rule summaries into the AI's context at session start.
 * Always exits 0 (informational injection, never blocks).
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import { generateContext } from "../lib/vcp-context-core";
import { loadGlobalConfig } from "../lib/global-config";
import { vcpLog } from "@vcp-lib/logging";
import { projectDir } from "@vcp-lib/runtime-adapter";

const projectRoot = projectDir();
const [output, globalConfig] = await Promise.all([
  generateContext(projectRoot),
  loadGlobalConfig(),
]);
const debug = globalConfig?.debug ?? false;
if (output) console.log(output);

await vcpLog(projectRoot, {
  source: "security-context",
  event: "SessionStart",
  decision: "info",
  details: `Generated context (${output?.length ?? 0} chars)\n--- BEGIN CONTEXT ---\n${output ?? "(empty)"}\n--- END CONTEXT ---`,
}, debug);

process.exit(0);
