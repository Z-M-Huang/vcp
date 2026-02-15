/**
 * VCP Config Resolution — CLI entrypoint for skills.
 *
 * Reads .vcp.json, fetches the standards manifest, resolves applicable
 * standards (with ignores applied), and outputs structured JSON for
 * skills to consume.
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

const projectRoot = process.argv[2] || process.cwd();

const config = await loadConfig(projectRoot);
if (!config) {
  console.error(
    "No .vcp.json found. Run /vcp-init to configure VCP for this project.",
  );
  process.exit(1);
}

let manifest;
try {
  manifest = await fetchManifest();
} catch (err) {
  console.error(
    `Failed to fetch VCP standards manifest: ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
}

const applicableStandards = resolveApplicableStandards(manifest, config);
const ignores = parseIgnoreList(config.ignore ?? []);

const output = {
  standardsBaseUrl: manifest.standards_base_url,
  applicableStandards: applicableStandards.map((s) => ({
    id: s.id,
    path: s.path,
    scope: s.scope,
    severity: s.severity,
    tags: s.tags,
  })),
  ignoredRules: [...ignores.rules],
  severity: config.severity ?? "medium",
  exclude: ["node_modules/**", ".git/**", ...(config.exclude ?? [])],
};

console.log(JSON.stringify(output, null, 2));
