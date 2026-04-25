/**
 * @vcp-lib/config — barrel re-exports.
 *
 * Sub-paths:
 *   @vcp-lib/config/types   — VcpConfig schema
 *   @vcp-lib/config/global  — global-config helpers
 *   @vcp-lib/config/project — CLI for resolving project config + standards
 */

export type { VcpConfig } from "./types";

export {
  DEFAULT_MANIFEST_URL,
  globalConfigPath,
  loadGlobalConfig,
  ensureGlobalConfig,
  saveGlobalConfig,
  validateStandardsUrl,
  resolveStandardsUrl,
  resolvePluginRoot,
  mergeIgnoreArrays,
  applyGlobalDefaults,
  type VcpGlobalConfig,
} from "./global";
