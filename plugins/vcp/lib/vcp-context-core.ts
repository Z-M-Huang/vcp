/**
 * Shim - context-core moved to @vcp-lib/context-core in v0.6.0.
 *
 * The plugin keeps this file as a re-export so import paths like
 * `../lib/vcp-context-core` from hooks and the Glob existence check
 * referenced by SKILL.md files continue to resolve without modification.
 */

export {
  FALLBACK_MESSAGE,
  CHARS_PER_TOKEN,
  CORE_TOKEN_BUDGET,
  FULL_TOKEN_BUDGET,
  loadConfig,
  parseIgnoreList,
  flattenV2Manifest,
  fetchManifest,
  resolveApplicableStandards,
  fetchStandards,
  extractRuleSummaries,
  buildReferenceSection,
  formatContext,
  generateContext,
  type VcpConfig,
  type ParsedIgnores,
  type StandardEntry,
  type Manifest,
  type ManifestV2Root,
  type ScopeManifestFile,
  type StandardRules,
  type ScopedRules,
} from "@vcp-lib/context-core";
