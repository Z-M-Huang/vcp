/**
 * VCP Config Resolution CLI shim - delegates to @vcp-lib/config/project.
 *
 * The plugin keeps this file at its historical path because eight
 * SKILL.md files invoke it as `bun "<pluginRoot>/lib/resolve-config.ts"`.
 * The bare side-effect import runs the workspace package's CLI module
 * with the same process.argv this shim received.
 */

import "@vcp-lib/config/project";
