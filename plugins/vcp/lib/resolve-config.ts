/**
 * VCP Config Resolution — CLI entrypoint for skills.
 *
 * Reads .vcp/config.json (project) and ~/.vcp/config.json (global), fetches the standards manifest,
 * resolves applicable standards (with ignores applied), and outputs
 * structured JSON for skills to consume.
 *
 * Usage: bun resolve-config.ts [project-root]
 *
 * Exit 0 + JSON stdout = success
 * Exit 1 + stderr message = failure (no config, network error, etc.)
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import {
  loadConfig,
  fetchManifest,
  resolveApplicableStandards,
  parseIgnoreList,
} from "./vcp-context-core";

import {
  loadGlobalConfig,
  ensureGlobalConfig,
  resolveStandardsUrl,
  applyGlobalDefaults,
  mergeIgnoreArrays,
} from "./global-config";

const projectRoot = process.argv[2] || process.cwd();

const [rawConfig, initialGlobalConfig] = await Promise.all([
  loadConfig(projectRoot),
  loadGlobalConfig(),
]);

if (!rawConfig) {
  console.error(
    "No .vcp/config.json found in this project. Run /vcp-init to configure VCP for this project.",
  );
  process.exit(1);
}

// Auto-create global config if missing but project config exists
const globalConfig = initialGlobalConfig ?? await ensureGlobalConfig(rawConfig);

const config = applyGlobalDefaults(globalConfig, rawConfig);
const standardsUrl = resolveStandardsUrl(globalConfig, rawConfig);

if (!standardsUrl) {
  console.error(
    "No standards URL available. Set standards_url in ~/.vcp/config.json (run /vcp-init) or .vcp/config.json.",
  );
  process.exit(1);
}

let manifest;
try {
  manifest = await fetchManifest(standardsUrl);
} catch (err) {
  console.error(
    `Failed to fetch VCP standards manifest from ${standardsUrl}: ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
}

const applicableStandards = resolveApplicableStandards(manifest, config);
const mergedIgnore = mergeIgnoreArrays(
  globalConfig?.defaults?.ignore ?? [],
  config.ignore ?? [],
);
const ignores = parseIgnoreList(mergedIgnore);

const output = {
  standardsUrl,
  applicableStandards: applicableStandards.map((s) => ({
    id: s.id,
    url: s.url,
    scope: s.scope,
    severity: s.severity,
    tags: s.tags,
  })),
  ignoredRules: [...ignores.rules],
  severity: config.severity ?? "medium",
  exclude: ["node_modules/**", ".git/**", ...(config.exclude ?? [])],
};

console.log(JSON.stringify(output, null, 2));
