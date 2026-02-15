/**
 * VCP Context Generation — CLI entrypoint for /vcp-context skill.
 *
 * Runs the full context pipeline: config → manifest → resolve → fetch →
 * extract rules → format. Outputs the formatted context string.
 *
 * Usage: bun generate-context.ts [project-root]
 *
 * Always exits 0. On failure, outputs a fallback message.
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import { generateContext } from "./vcp-context-core";

const projectRoot = process.argv[2] || process.cwd();
const output = await generateContext(projectRoot);
console.log(output);
