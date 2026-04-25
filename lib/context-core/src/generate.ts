/**
 * VCP Context Generation CLI - run the full context pipeline and print
 * the formatted context string.
 *
 * Usage: bun lib/context-core/src/generate.ts [project-root]
 *
 * Always exits 0. On failure, prints a fallback message.
 */

import { generateContext } from "./index";

const projectRoot = process.argv[2] || process.cwd();
const output = await generateContext(projectRoot);
console.log(output);
