/**
 * VCP Security Context — SessionStart hook (Layer A)
 *
 * Injects VCP rule summaries into the AI's context at session start.
 * Always exits 0 (informational injection, never blocks).
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import { generateContext } from "../lib/vcp-context-core";

const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const output = await generateContext(projectRoot);
if (output) console.log(output);
process.exit(0);
