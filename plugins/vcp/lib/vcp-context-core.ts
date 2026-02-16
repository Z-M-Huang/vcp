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
}

export interface ParsedIgnores {
  standards: Set<string>; // e.g., "core-architecture"
  rules: Set<string>; // e.g., "core-security/rule-3"
  cwes: Set<string>; // e.g., "CWE-798"
}

export interface StandardEntry {
  id: string;
  path: string;
  scope: string;
  severity: string;
  tags: string[];
  applies: string;
}

export interface Manifest {
  version: string;
  repository: string;
  standards_base_url: string;
  scopes: string[];
  standards: StandardEntry[];
}

// --- V2 manifest types ---

export interface ManifestV2Root {
  version: string;
  repository: string;
  standards_base_url: string;
  scopes: Record<string, { manifest: string; applies: string }>;
}

export interface ScopeManifestFile {
  scope: string;
  standards: {
    id: string;
    path: string;
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

const MANIFEST_URL =
  "https://raw.githubusercontent.com/Z-M-Huang/vcp/main/standards/manifest.json";

export const FALLBACK_MESSAGE =
  "VCP active. Run /vcp-audit, /vcp-pre-commit-review before committing.";

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const CHARS_PER_TOKEN = 4;
const CORE_TOKEN_BUDGET = 700;
const FULL_TOKEN_BUDGET = 1500;

// --- Functions ---

export async function loadConfig(
  projectRoot: string,
): Promise<VcpConfig | null> {
  try {
    return await Bun.file(`${projectRoot}/.vcp.json`).json();
  } catch {
    return null;
  }
}

/**
 * Parse the ignore array from .vcp.json into categorized sets.
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
        path: std.path,
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
    standards_base_url: v2.standards_base_url,
    scopes: scopeNames,
    standards,
  };
}

export async function fetchManifest(): Promise<Manifest> {
  const response = await fetch(MANIFEST_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: ${response.status}`);
  }
  const raw = await response.json();

  // V1: already in the right shape
  if (raw.version === "1.0") {
    return raw as Manifest;
  }

  // V2: fetch scope manifests and flatten to same Manifest shape
  const v2 = raw as ManifestV2Root;
  const baseUrl = v2.standards_base_url;
  const scopeEntries = Object.entries(v2.scopes);

  const scopeManifests = await Promise.all(
    scopeEntries.map(async ([scopeKey, { manifest: manifestPath, applies }]) => {
      const res = await fetch(`${baseUrl}${manifestPath}`);
      if (!res.ok) {
        throw new Error(
          `Failed to fetch scope manifest '${scopeKey}' (${baseUrl}${manifestPath}): ${res.status}`,
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
  baseUrl: string,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  await Promise.all(
    entries.map(async (entry) => {
      const response = await fetch(`${baseUrl}${entry.path}`);
      if (response.ok) {
        results.set(entry.id, await response.text());
      }
    }),
  );
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
    const [config, manifest] = await Promise.all([
      loadConfig(projectRoot),
      fetchManifest(),
    ]);

    const entries = resolveApplicableStandards(manifest, config);
    if (entries.length === 0) return FALLBACK_MESSAGE;

    const standards = await fetchStandards(entries, manifest.standards_base_url);
    if (standards.size === 0) return FALLBACK_MESSAGE;

    const rules = extractRuleSummaries(standards, entries, config);
    if (Object.keys(rules).length === 0) return FALLBACK_MESSAGE;

    return formatContext(rules);
  } catch {
    return FALLBACK_MESSAGE;
  }
}
