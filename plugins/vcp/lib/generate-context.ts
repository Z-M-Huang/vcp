/**
 * VCP Context Generation CLI shim - delegates to @vcp-lib/context-core/generate.
 *
 * The plugin keeps this file at its historical path because the
 * /vcp-context skill invokes it as `bun "<pluginRoot>/lib/generate-context.ts"`.
 * The bare side-effect import runs the workspace package's CLI module
 * with the same process.argv this shim received.
 */

import "@vcp-lib/context-core/generate";
