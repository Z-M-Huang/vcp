/**
 * Shim - global-config helpers moved to @vcp-lib/config/global in v0.6.0.
 *
 * The plugin keeps this file as a re-export so import paths like
 * `../lib/global-config` from hooks and scripts continue to resolve
 * without modification.
 */

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
} from "@vcp-lib/config/global";
