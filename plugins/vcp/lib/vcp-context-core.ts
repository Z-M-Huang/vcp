/**
 * VCP Context Core — Shared extraction module for proactive context hooks.
 *
 * Loads project config, fetches the VCP standards manifest, resolves applicable
 * standards, extracts rule summaries, and formats them as compact context for
 * injection into the AI's conversation.
 *
 * Used by:
 * - security-context.ts (SessionStart hook)
 * - /vcp-context skill (via generate-context.ts CLI entrypoint)
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import { mkdir, rename } from "fs/promises";

import {
  loadGlobalConfig,
  validateStandardsUrl,
  resolveStandardsUrl,
  applyGlobalDefaults,
} from "./global-config";

// --- Types ---

export interface VcpConfig {
  version: string;
  scopes: Record<string, boolean>;
  compliance: string[];
  ignore?: string[];
  frameworks?: string[];
  exclude?: string[];
  severity?: string;
  pluginRoot?: string;
  standards_url?: string;
}

export interface ParsedIgnores {
  standards: Set<string>; // e.g., "core-architecture"
  rules: Set<string>; // e.g., "core-security/rule-3"
  cwes: Set<string>; // e.g., "CWE-798"
}

export interface StandardEntry {
  id: string;
  url: string;
  scope: string;
  severity: string;
  tags: string[];
  applies: string;
}

export interface Manifest {
  version: string;
  repository: string;
  scopes: string[];
  standards: StandardEntry[];
}

// --- V2 manifest types ---

export interface ManifestV2Root {
  version: string;
  repository: string;
  scopes: Record<string, { manifest: string; applies: string }>;
}

export interface ScopeManifestFile {
  scope: string;
  standards: {
    id: string;
    url: string;
    severity: string;
    tags: string[];
  }[];
}

interface StandardRules {
  title: string;
  severity: string;
  rules: string[];
}

export interface ScopedRules {
  [scope: string]: StandardRules[];
}

// --- Constants ---

export const FALLBACK_MESSAGE =
  "VCP active but not fully initialized. Run /vcp-init to configure, then /vcp-audit before committing.";

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const CHARS_PER_TOKEN = 4;
export const CORE_TOKEN_BUDGET = 1200;
export const FULL_TOKEN_BUDGET = 2500;

// --- Functions ---

export async function loadConfig(
  projectRoot: string,
): Promise<VcpConfig | null> {
  try {
    return await Bun.file(`${projectRoot}/.vcp/config.json`).json();
  } catch {
    // Auto-migrate from old location (.vcp.json → .vcp/config.json)
    try {
      const config = await Bun.file(`${projectRoot}/.vcp.json`).json();
      try {
        await mkdir(`${projectRoot}/.vcp`, { recursive: true });
        await rename(`${projectRoot}/.vcp.json`, `${projectRoot}/.vcp/config.json`);
        console.error(`[VCP] Migrated .vcp.json → .vcp/config.json`);
      } catch {
        console.error(
          `[VCP] Found .vcp.json in project root — this file has moved to .vcp/config.json. ` +
          `Run: mkdir -p .vcp && mv .vcp.json .vcp/config.json`,
        );
      }
      return config as VcpConfig;
    } catch { /* No config at either location */ }
    return null;
  }
}

/**
 * Parse the ignore array from .vcp/config.json into categorized sets.
 * Centralized so every consumer of the config gets consistent filtering.
 *
 * - Standard IDs (e.g., "core-architecture") → exclude entire standard
 * - Rule refs (e.g., "core-security/rule-3") → exclude specific rule
 * - CWE patterns (e.g., "CWE-798") → for security-gate (not used here)
 */
export function parseIgnoreList(ignore: string[]): ParsedIgnores {
  const standards = new Set<string>();
  const rules = new Set<string>();
  const cwes = new Set<string>();

  for (const entry of ignore) {
    if (/^CWE-\d+$/.test(entry)) {
      cwes.add(entry);
    } else if (entry.includes("/rule-")) {
      rules.add(entry);
    } else {
      standards.add(entry);
    }
  }

  return { standards, rules, cwes };
}

/**
 * Flatten a v2 root manifest and its resolved scope manifests into the
 * unified Manifest shape consumed by all downstream functions.
 *
 * Pure function — no I/O. Exported for testing.
 */
export function flattenV2Manifest(
  v2: ManifestV2Root,
  scopeManifests: { scopeKey: string; applies: string; sm: ScopeManifestFile }[],
): Manifest {
  const standards: StandardEntry[] = [];
  const scopeNames: string[] = [];

  for (const entry of scopeManifests) {
    scopeNames.push(entry.scopeKey);
    for (const std of entry.sm.standards) {
      standards.push({
        id: std.id,
        url: std.url,
        scope: entry.sm.scope,
        severity: std.severity,
        tags: std.tags,
        applies: entry.applies,
      });
    }
  }

  return {
    version: v2.version,
    repository: v2.repository,
    scopes: scopeNames,
    standards,
  };
}

export async function fetchManifest(url: string): Promise<Manifest> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: ${response.status}`);
  }
  const raw = await response.json();

  // V1 backward compat: construct full URLs from standards_base_url + path
  if (raw.version === "1.0") {
    const v1 = raw as any;
    return {
      version: v1.version,
      repository: v1.repository,
      scopes: v1.scopes,
      standards: v1.standards.map((s: any) => ({
        ...s,
        url: `${v1.standards_base_url}${s.path}`,
      })),
    };
  }

  // V2: scope manifest URLs are already full URLs — validate each before fetching
  const v2 = raw as ManifestV2Root;
  const scopeEntries = Object.entries(v2.scopes);

  const scopeManifests = await Promise.all(
    scopeEntries.map(async ([scopeKey, { manifest: manifestUrl, applies }]) => {
      const urlError = validateStandardsUrl(manifestUrl);
      if (urlError) {
        throw new Error(
          `Unsafe scope manifest URL for '${scopeKey}' (${manifestUrl}): ${urlError}`,
        );
      }
      const res = await fetch(manifestUrl);
      if (!res.ok) {
        throw new Error(
          `Failed to fetch scope manifest '${scopeKey}' (${manifestUrl}): ${res.status}`,
        );
      }
      const sm: ScopeManifestFile = await res.json();
      return { scopeKey, applies, sm };
    }),
  );

  return flattenV2Manifest(v2, scopeManifests);
}

export function resolveApplicableStandards(
  manifest: Manifest,
  config: VcpConfig | null,
): StandardEntry[] {
  const ignores = parseIgnoreList(config?.ignore ?? []);

  let filtered: StandardEntry[];
  if (!config) {
    filtered = manifest.standards.filter((s) => s.applies === "always");
  } else {
    const activeScopes = new Set<string>();
    for (const [scope, enabled] of Object.entries(config.scopes)) {
      if (enabled) activeScopes.add(scope);
    }
    const activeCompliance = new Set(config.compliance ?? []);

    filtered = manifest.standards.filter((s) => {
      if (s.applies === "always") return true;
      if (activeScopes.has(s.applies)) return true;
      if (s.applies.startsWith("compliance:")) {
        return activeCompliance.has(s.applies.slice("compliance:".length));
      }
      return false;
    });
  }

  // Remove standards that are in the ignore list
  return filtered.filter((s) => !ignores.standards.has(s.id));
}

export async function fetchStandards(
  entries: StandardEntry[],
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const dropped: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      // Validate each standard URL before fetching — manifest content is untrusted
      const urlError = validateStandardsUrl(entry.url);
      if (urlError) {
        dropped.push(`${entry.id}: unsafe URL (${urlError})`);
        return;
      }
      try {
        const response = await fetch(entry.url);
        if (!response.ok) {
          dropped.push(`${entry.id}: HTTP ${response.status}`);
        } else {
          results.set(entry.id, await response.text());
        }
      } catch (err) {
        dropped.push(`${entry.id}: ${err instanceof Error ? err.message : "fetch failed"}`);
      }
    }),
  );
  if (dropped.length > 0) {
    console.warn(
      `[VCP] ${dropped.length} standard(s) dropped during fetch:\n  ${dropped.join("\n  ")}`,
    );
  }
  return results;
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^title:\s*(.+)$/m);
  if (!match) return "Unknown";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function extractRulesSection(markdown: string): string {
  const idx = markdown.indexOf("\n## Rules");
  if (idx === -1) return "";
  const end = markdown.indexOf("\n## ", idx + 10);
  return end === -1 ? markdown.slice(idx) : markdown.slice(idx, end);
}

export function extractRuleSummaries(
  standards: Map<string, string>,
  entries: StandardEntry[],
  config: VcpConfig | null = null,
): ScopedRules {
  const ignores = parseIgnoreList(config?.ignore ?? []);
  const result: ScopedRules = {};
  const ruleRegex = /^(\d+)\.\s+\*\*(.+?)\*\*/gm;

  for (const entry of entries) {
    const markdown = standards.get(entry.id);
    if (!markdown) continue;

    const title = extractTitle(markdown);
    const rulesSection = extractRulesSection(markdown);
    const rules: string[] = [];

    let match;
    while ((match = ruleRegex.exec(rulesSection)) !== null) {
      const ruleNum = match[1];
      const ruleTitle = match[2];
      // Skip rules that are individually ignored (e.g., "core-security/rule-3")
      if (!ignores.rules.has(`${entry.id}/rule-${ruleNum}`)) {
        rules.push(ruleTitle);
      }
    }
    ruleRegex.lastIndex = 0;

    if (rules.length === 0) continue;

    if (!result[entry.scope]) result[entry.scope] = [];
    result[entry.scope].push({ title, severity: entry.severity, rules });
  }

  return result;
}

function scopeDisplayName(scope: string): string {
  return scope
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function buildOutput(rules: ScopedRules): string {
  const scopes = Object.keys(rules).sort((a, b) => {
    if (a === "core") return -1;
    if (b === "core") return 1;
    return a.localeCompare(b);
  });

  const lines: string[] = ["## VCP Standards Context"];

  for (const scope of scopes) {
    const standards = rules[scope];
    if (!standards || standards.length === 0) continue;

    lines.push("");
    lines.push(`### ${scopeDisplayName(scope)} Rules`);
    for (const std of standards) {
      lines.push(`**${std.title}** (${std.severity}): ${std.rules.join(" | ")}`);
    }
  }

  lines.push("");
  lines.push("> Run /vcp-audit for deep analysis.");
  return lines.join("\n");
}

export function formatContext(rules: ScopedRules): string {
  const hasNonCore = Object.keys(rules).some((s) => s !== "core");
  const charBudget =
    (hasNonCore ? FULL_TOKEN_BUDGET : CORE_TOKEN_BUDGET) * CHARS_PER_TOKEN;

  // Check if full output fits within budget
  const fullOutput = buildOutput(rules);
  if (fullOutput.length <= charBudget) return fullOutput;

  // Over budget — include highest-severity standards first
  const all: { scope: string; entry: StandardRules }[] = [];
  for (const [scope, entries] of Object.entries(rules)) {
    for (const entry of entries) {
      all.push({ scope, entry });
    }
  }
  all.sort(
    (a, b) =>
      (SEVERITY_ORDER[a.entry.severity] ?? 3) -
      (SEVERITY_ORDER[b.entry.severity] ?? 3),
  );

  const included: ScopedRules = {};
  for (const { scope, entry } of all) {
    if (!included[scope]) included[scope] = [];
    included[scope].push(entry);

    if (buildOutput(included).length > charBudget) {
      included[scope].pop();
      if (included[scope].length === 0) delete included[scope];
    }
  }

  // Ensure at least one standard is always included
  if (Object.keys(included).length === 0 && all.length > 0) {
    const first = all[0];
    included[first.scope] = [first.entry];
  }

  return buildOutput(included);
}

export async function generateContext(projectRoot: string): Promise<string> {
  try {
    const [rawConfig, globalConfig] = await Promise.all([
      loadConfig(projectRoot),
      loadGlobalConfig(),
    ]);

    const standardsUrl = resolveStandardsUrl(globalConfig, rawConfig);
    if (!standardsUrl) {
      return "VCP active but not initialized. Run /vcp-init to configure.";
    }

    const config = rawConfig
      ? applyGlobalDefaults(globalConfig, rawConfig)
      : rawConfig;

    const manifest = await fetchManifest(standardsUrl);
    const entries = resolveApplicableStandards(manifest, config);
    if (entries.length === 0) return FALLBACK_MESSAGE;

    const standards = await fetchStandards(entries);
    if (standards.size === 0) return FALLBACK_MESSAGE;

    const rules = extractRuleSummaries(standards, entries, config);
    if (Object.keys(rules).length === 0) return FALLBACK_MESSAGE;

    return formatContext(rules);
  } catch {
    return FALLBACK_MESSAGE;
  }
}
