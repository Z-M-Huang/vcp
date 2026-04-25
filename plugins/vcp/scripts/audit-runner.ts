#!/usr/bin/env bun
/**
 * VCP Audit Runner — script-first audit driver.
 *
 * Replaces the Claude-only Team-and-Task-tool orchestration in vcp-audit/SKILL.md
 * with @vcp-lib/llm-runner calls (works on Claude Code AND Codex CLI).
 * Emits structured JSON to stdout for the host LLM to render.
 *
 * Usage:
 *   bun audit-runner.ts --mode quick [--path <dir>] [--preset <name>] [--model <id>]
 *   bun audit-runner.ts --mode full [--path <dir>] ...
 *   bun audit-runner.ts --mode compliance --framework gdpr ...
 *
 * Modes:
 *   quick       — Single LLM scan for critical+high rules, no validation
 *   full        — Per-domain parallel scanners + 7-step validator (NOT YET IMPLEMENTED)
 *   compliance  — Like full, filtered to compliance + security standards (NOT YET IMPLEMENTED)
 *
 * Subscription presets are not supported (no Task-tool equivalent in TS).
 * Configure an API preset via /vcp-config or ~/.vcp/ai-presets.json.
 *
 * Exit codes:
 *   0 - Success (JSON on stdout)
 *   1 - Validation error (bad args, missing config, no preset)
 *   2 - Scan error (LLM failure, network error)
 */

import path from "path";
import {
  loadConfig,
  fetchManifest,
  resolveApplicableStandards,
  fetchStandards,
  parseIgnoreList,
  extractRuleSummaries,
} from "@vcp-lib/context-core";
import {
  loadGlobalConfig,
  ensureGlobalConfig,
  resolveStandardsUrl,
  applyGlobalDefaults,
  mergeIgnoreArrays,
} from "@vcp-lib/config/global";
import { readPresets } from "@vcp-lib/llm-runner/presets";
import { createRunner } from "@vcp-lib/llm-runner";
import type { ApiPreset } from "@vcp-lib/llm-runner/types";
import { projectDir as adapterProjectDir } from "@vcp-lib/runtime-adapter";

// ─── Types ──────────────────────────────────────────────────────────────────

type Mode = "quick" | "full" | "compliance";
type Framework = "gdpr" | "pci-dss" | "hipaa";
type Format = "markdown" | "json";

interface ParsedArgs {
  mode: Mode;
  framework?: Framework;
  path?: string;
  preset?: string;
  model?: string;
  format: Format;
}

interface Finding {
  standardId: string;
  rule: number;
  severity: string;
  file: string;
  line: number | null;
  evidence: string;
  issue: string;
  fix: string;
}

interface AuditOutput {
  mode: Mode;
  target: string;
  standardsLoaded: number;
  rulesChecked: number;
  findings: Finding[];
  warnings: string[];
}

// ─── CLI Arg Parsing ────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: Partial<ParsedArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case "--mode":
        if (!value) throw new Error("--mode requires a value");
        if (value !== "quick" && value !== "full" && value !== "compliance") {
          throw new Error(`Invalid --mode '${value}'. Expected: quick | full | compliance`);
        }
        result.mode = value;
        i++;
        break;
      case "--framework":
        if (!value) throw new Error("--framework requires a value");
        if (value !== "gdpr" && value !== "pci-dss" && value !== "hipaa") {
          throw new Error(`Invalid --framework '${value}'. Expected: gdpr | pci-dss | hipaa`);
        }
        result.framework = value;
        i++;
        break;
      case "--path":
        if (!value) throw new Error("--path requires a value");
        result.path = value;
        i++;
        break;
      case "--preset":
        if (!value) throw new Error("--preset requires a value");
        result.preset = value;
        i++;
        break;
      case "--model":
        if (!value) throw new Error("--model requires a value");
        result.model = value;
        i++;
        break;
      case "--format":
        if (!value) throw new Error("--format requires a value");
        if (value !== "markdown" && value !== "json") {
          throw new Error(`Invalid --format '${value}'. Expected: markdown | json`);
        }
        result.format = value;
        i++;
        break;
      default:
        if (flag.startsWith("--")) throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (!result.mode) throw new Error("--mode is required");
  if (result.mode === "compliance" && !result.framework) {
    throw new Error("--framework is required when --mode=compliance");
  }
  if (!result.format) result.format = "markdown";
  return result as ParsedArgs;
}

// ─── Config Resolution ──────────────────────────────────────────────────────

interface ResolvedConfig {
  applicableStandards: ReturnType<typeof resolveApplicableStandards>;
  ignoredRules: string[];
  severity: string;
  exclude: string[];
}

async function resolveConfig(projectRoot: string): Promise<ResolvedConfig> {
  const [rawConfig, initialGlobalConfig] = await Promise.all([
    loadConfig(projectRoot),
    loadGlobalConfig(),
  ]);

  if (!rawConfig) {
    throw new Error(
      "No .vcp/config.json found. Run /vcp-init to configure VCP for this project.",
    );
  }

  const globalConfig = initialGlobalConfig ?? (await ensureGlobalConfig(rawConfig));
  const config = applyGlobalDefaults(globalConfig, rawConfig);
  const standardsUrl = resolveStandardsUrl(globalConfig, rawConfig);

  if (!standardsUrl) {
    throw new Error(
      "No standards URL configured. Set standards_url in ~/.vcp/config.json (run /vcp-init).",
    );
  }

  const manifest = await fetchManifest(standardsUrl);
  const ignoredRules = mergeIgnoreArrays(globalConfig?.ignore, config.ignore);
  const parsedIgnores = parseIgnoreList(ignoredRules);
  const applicableStandards = resolveApplicableStandards(manifest, config, parsedIgnores);

  return {
    applicableStandards,
    ignoredRules,
    severity: config.severity ?? "medium",
    exclude: config.exclude ?? [],
  };
}

// ─── Preset Selection ───────────────────────────────────────────────────────

function pickPreset(name?: string, model?: string): { preset: ApiPreset; model: string } {
  const presets = readPresets();
  const entries = Object.entries(presets.presets);

  let chosen: [string, (typeof entries)[number][1]] | undefined;
  if (name) {
    chosen = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (!chosen) {
      throw new Error(
        `Preset '${name}' not found. Available: ${entries.map(([k]) => k).join(", ")}`,
      );
    }
  } else {
    chosen = entries.find(([, p]) => p.type === "api");
    if (!chosen) {
      throw new Error(
        "No API preset configured. Run /vcp-config to add one (audit-runner only supports API presets).",
      );
    }
  }

  const [presetName, preset] = chosen;
  if (preset.type !== "api") {
    throw new Error(
      `Preset '${presetName}' is type '${preset.type}'. audit-runner requires an API preset (subscription/cli unsupported).`,
    );
  }

  const apiPreset = preset as ApiPreset;
  const resolvedModel = model ?? apiPreset.models[0];
  if (!apiPreset.models.includes(resolvedModel)) {
    throw new Error(
      `Model '${resolvedModel}' not in preset '${presetName}': [${apiPreset.models.join(", ")}]`,
    );
  }

  return { preset: apiPreset, model: resolvedModel };
}

// ─── Quick-mode Prompt Builder ──────────────────────────────────────────────

function buildQuickPrompt(opts: {
  projectRoot: string;
  exclude: string[];
  rules: string;
}): string {
  const excludeBlock = opts.exclude.length > 0
    ? opts.exclude.map((g) => `  - \`${g}\``).join("\n")
    : "  (none)";

  return `You are a security and code-quality auditor. Scan the codebase at ${opts.projectRoot} for violations of the rules below. This is a QUICK release-readiness scan: critical and high severity ONLY. Skip medium-severity rules for speed.

Use Glob to enumerate code files (skip the Exclude patterns below). Use Read to inspect files. Use Grep when looking for specific patterns. Do NOT use Bash to run commands.

Exclude patterns:
${excludeBlock}

Focus on:
- Hardcoded secrets, credentials, or API keys committed in source
- SQL injection (string concatenation into queries with user input)
- Command injection (shell invocations with unsanitized input)
- Dynamic code evaluation on untrusted input (eval, Function constructors, etc.)
- Missing authentication on sensitive routes
- Critical compliance gaps (unencrypted PII, missing audit logging) when present

Output format — one block per finding, no preamble, no summary:

FINDING: {standard-id}/rule-{N} ({severity})
FILE: {relative-path}:{line}
EVIDENCE: {3-5 lines of the actual code, exactly as it appears}
ISSUE: {one-sentence problem description}
FIX: {one-sentence remediation}

If no findings: output exactly the string "NO_FINDINGS" and nothing else.

Rules to check (extracted summaries):

${opts.rules}
`;
}

// ─── Finding Parser ─────────────────────────────────────────────────────────

const FINDING_RE = /^FINDING:\s*([\w-]+)\/rule-(\d+)\s*\((\w+)\)\s*$/i;

export function parseFindings(raw: string): { findings: Finding[]; parseWarnings: string[] } {
  const findings: Finding[] = [];
  const parseWarnings: string[] = [];

  if (raw.trim() === "NO_FINDINGS") return { findings, parseWarnings };

  // Split on blank lines preceding "FINDING:"
  const blocks = raw.split(/\n(?=FINDING:)/);

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    const headerMatch = FINDING_RE.exec(lines[0]);
    if (!headerMatch) {
      // Not a finding block — likely preamble before the first FINDING.
      continue;
    }

    const standardId = headerMatch[1];
    const rule = parseInt(headerMatch[2], 10);
    const severity = headerMatch[3].toLowerCase();

    const get = (key: string): string => {
      const line = lines.find((l) => l.toUpperCase().startsWith(`${key.toUpperCase()}:`));
      return line ? line.slice(key.length + 1).trim() : "";
    };

    const fileLine = get("FILE");
    const colonIdx = fileLine.lastIndexOf(":");
    const file = colonIdx >= 0 ? fileLine.slice(0, colonIdx) : fileLine;
    const lineNum = colonIdx >= 0 ? parseInt(fileLine.slice(colonIdx + 1), 10) : NaN;

    findings.push({
      standardId,
      rule,
      severity,
      file,
      line: Number.isFinite(lineNum) ? lineNum : null,
      evidence: get("EVIDENCE"),
      issue: get("ISSUE"),
      fix: get("FIX"),
    });
  }

  return { findings, parseWarnings };
}

// ─── Quick Mode ─────────────────────────────────────────────────────────────

async function runQuickMode(opts: {
  projectRoot: string;
  config: ResolvedConfig;
  preset: ApiPreset;
  model: string;
}): Promise<AuditOutput> {
  const { applicableStandards, exclude, ignoredRules } = opts.config;

  // Fetch standards content + extract rules
  const standardsContent = await fetchStandards(applicableStandards);
  const ruleSummaries = extractRuleSummaries(standardsContent);

  // Build a flat rule listing for the prompt: "core-security rule 1 (critical) — Validate all input..."
  const ruleLines: string[] = [];
  let totalRules = 0;
  for (const [standardId, scoped] of Object.entries(ruleSummaries)) {
    for (const rule of scoped.rules) {
      // Quick mode = critical + high only
      const severity = (rule.severity ?? scoped.severity ?? "medium").toLowerCase();
      if (severity !== "critical" && severity !== "high") continue;
      ruleLines.push(
        `${standardId} rule ${rule.number} (${severity}) — ${rule.summary}`,
      );
      totalRules++;
    }
  }

  if (ruleLines.length === 0) {
    return {
      mode: "quick",
      target: opts.projectRoot,
      standardsLoaded: applicableStandards.length,
      rulesChecked: 0,
      findings: [],
      warnings: ["No critical/high rules to scan in quick mode."],
    };
  }

  const prompt = buildQuickPrompt({
    projectRoot: opts.projectRoot,
    exclude,
    rules: ruleLines.join("\n"),
  });

  const runner = createRunner(opts.preset);
  const timeoutMs = opts.preset.timeout_ms ?? 600_000;
  const result = await runner.run(prompt, {
    model: opts.model,
    timeoutMs,
    cwd: opts.projectRoot,
    debugEnabled: false,
    presetName: opts.preset.name,
    allowedTools: ["Read", "Glob", "Grep"],
  });

  if (result.timedOut) throw new Error("Quick scan timed out");
  if (result.error) throw new Error(`Quick scan failed: ${result.error}`);
  if (!result.result) throw new Error("Quick scan returned empty output");

  const { findings, parseWarnings } = parseFindings(result.result);

  // Apply ignore list
  const ignoreSet = new Set(ignoredRules);
  const filtered = findings.filter(
    (f) => !ignoreSet.has(`${f.standardId}/rule-${f.rule}`) &&
           !ignoreSet.has(f.standardId),
  );
  const suppressed = findings.length - filtered.length;
  const warnings = [...parseWarnings];
  if (suppressed > 0) warnings.push(`Suppressed ${suppressed} finding(s) by ignore config.`);

  return {
    mode: "quick",
    target: opts.projectRoot,
    standardsLoaded: applicableStandards.length,
    rulesChecked: totalRules,
    findings: filtered,
    warnings,
  };
}

// ─── Markdown Renderer ──────────────────────────────────────────────────────

interface StandardSummary {
  standardId: string;
  critical: number;
  high: number;
  medium: number;
  verdict: "FAIL" | "WARN" | "PASS";
}

function summarizeByStandard(findings: Finding[]): StandardSummary[] {
  const grouped = new Map<string, { critical: number; high: number; medium: number }>();
  for (const f of findings) {
    const sev = f.severity.toLowerCase();
    const cur = grouped.get(f.standardId) ?? { critical: 0, high: 0, medium: 0 };
    if (sev === "critical") cur.critical++;
    else if (sev === "high") cur.high++;
    else cur.medium++;
    grouped.set(f.standardId, cur);
  }

  return [...grouped.entries()].map(([standardId, counts]) => {
    let verdict: StandardSummary["verdict"];
    if (counts.critical > 0) verdict = "FAIL";
    else if (counts.high > 0) verdict = "WARN";
    else verdict = "PASS";
    return { standardId, ...counts, verdict };
  });
}

export function renderQuickMarkdown(out: AuditOutput): string {
  const { findings, standardsLoaded, rulesChecked, warnings } = out;
  const summary = summarizeByStandard(findings);
  const totalCritical = summary.reduce((s, r) => s + r.critical, 0);
  const totalHigh = summary.reduce((s, r) => s + r.high, 0);
  const failCount = summary.filter((r) => r.verdict === "FAIL").length;

  const lines: string[] = [
    "### VCP Release Readiness",
    "",
    `**Standards loaded:** ${standardsLoaded}`,
    `**Rules checked:** ${rulesChecked} critical/high rules (medium skipped)`,
    `**Note:** Quick mode does not validate findings. Run \`/vcp-audit\` for validated results.`,
    "",
  ];

  if (summary.length === 0) {
    lines.push(`**Verdict: READY — No critical or high issues found across ${standardsLoaded} standards.**`);
  } else {
    lines.push("| Standard | Verdict | Blocking Issues |");
    lines.push("|----------|---------|-----------------|");
    for (const s of summary) {
      const issues =
        s.critical > 0 ? `${s.critical} critical finding${s.critical === 1 ? "" : "s"}`
          : s.high > 0 ? `${s.high} high finding${s.high === 1 ? "" : "s"}`
            : "—";
      lines.push(`| ${s.standardId} | ${s.verdict} | ${issues} |`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
    if (failCount > 0) {
      lines.push(`**Verdict: NOT READY — ${totalCritical} critical issue${totalCritical === 1 ? "" : "s"} must be resolved before release.**`);
    } else if (totalHigh > 0) {
      lines.push(`**Verdict: REVIEW — ${totalHigh} high finding${totalHigh === 1 ? "" : "s"} should be evaluated before release.**`);
    } else {
      lines.push(`**Verdict: READY — No critical or high issues found across ${standardsLoaded} standards.**`);
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    for (const w of warnings) lines.push(`> ${w}`);
  }

  return lines.join("\n");
}

// ─── Domain Partition ──────────────────────────────────────────────────────

/**
 * Domain → standard-id mapping mirrors the table in vcp-audit/SKILL.md.
 * When a new standard is added to the manifest, extend this map. Standards
 * that don't match any domain fall through to "architecture" with a warning.
 */
const DOMAIN_MAP: Record<string, string[]> = {
  backend: [
    "core-security", "core-secure-defaults", "core-api-design-security",
    "core-data-flow-security", "core-attack-surface", "web-backend-security",
    "web-backend-structure", "web-backend-data-access", "web-backend-api-design",
    "web-backend-realtime", "web-backend-caching",
  ],
  frontend: [
    "web-frontend-security", "web-frontend-structure",
    "web-frontend-performance", "web-frontend-accessibility",
  ],
  architecture: [
    "core-architecture", "core-code-quality", "core-error-handling",
    "core-testing", "core-root-cause-analysis", "core-concurrency-security",
  ],
  database: [
    "database-encryption", "database-schema-security", "core-dependency-management",
  ],
  compliance: ["compliance-gdpr", "compliance-pci-dss", "compliance-hipaa"],
  mobile: ["mobile-security", "mobile-platform-configuration"],
  desktop: ["desktop-security"],
  cli: ["cli-security-and-quality"],
  devops: [
    "devops-container-security", "devops-cicd-security",
    "devops-iac-security", "devops-kubernetes-security",
  ],
  "agentic-ai": [
    "agentic-ai-agent-security", "agentic-ai-tool-security",
    "agentic-ai-permissions", "agentic-ai-supply-chain", "agentic-ai-communication",
  ],
};

function findDomain(standardId: string): { domain: string; mapped: boolean } {
  for (const [domain, ids] of Object.entries(DOMAIN_MAP)) {
    if (ids.includes(standardId)) return { domain, mapped: true };
  }
  return { domain: "architecture", mapped: false };
}

interface DomainGroup {
  domain: string;
  standards: Array<{ id: string; severity?: string; tags?: string[] }>;
}

export function partitionByDomain(
  applicableStandards: Array<{ id: string; severity?: string; tags?: string[] }>,
): { groups: DomainGroup[]; unmapped: string[] } {
  const map = new Map<string, DomainGroup>();
  const unmapped: string[] = [];

  for (const std of applicableStandards) {
    const { domain, mapped } = findDomain(std.id);
    if (!mapped) unmapped.push(std.id);
    if (!map.has(domain)) map.set(domain, { domain, standards: [] });
    map.get(domain)!.standards.push(std);
  }

  // Stable order: keys of DOMAIN_MAP, then any extras (unlikely)
  const orderedDomains = Object.keys(DOMAIN_MAP);
  const groups: DomainGroup[] = [];
  for (const d of orderedDomains) {
    if (map.has(d)) groups.push(map.get(d)!);
  }
  for (const [d, g] of map.entries()) {
    if (!orderedDomains.includes(d)) groups.push(g);
  }
  return { groups, unmapped };
}

// ─── Concurrency-capped runner ─────────────────────────────────────────────

async function runWithCap<T>(tasks: Array<() => Promise<T>>, cap: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;
  const workerCount = Math.min(cap, tasks.length);
  if (workerCount === 0) return [];

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Scanner Prompt Builder ────────────────────────────────────────────────

function buildScannerPrompt(opts: {
  domain: string;
  projectRoot: string;
  exclude: string[];
  rules: string;
}): string {
  const excludeBlock = opts.exclude.length > 0
    ? opts.exclude.map((g) => `  - \`${g}\``).join("\n")
    : "  (none)";

  return `You are a domain-specific code auditor. Your domain: **${opts.domain}**.
Scan the codebase at ${opts.projectRoot} for violations of the rules below. Report every plausible violation; a downstream validator pass will eliminate false positives, so err on the side of inclusion.

Use Glob to enumerate code files (skip the Exclude patterns below). Use Read to inspect files. Use Grep when looking for specific patterns. Do NOT use Bash to run commands.

Exclude patterns:
${excludeBlock}

For each finding, include the literal code you read as EVIDENCE — findings without evidence cannot be validated.

Output format — one block per finding, no preamble, no summary:

FINDING: {standard-id}/rule-{N} ({severity})
FILE: {relative-path}:{line}
EVIDENCE: {3-5 lines of the actual code, exactly as it appears}
ISSUE: {one-sentence problem description}
FIX: {one-sentence remediation}

If no violations are found in this domain: output exactly the string "NO_FINDINGS" and nothing else.

Rules to check (extracted summaries):

${opts.rules}
`;
}

// ─── Full Mode ─────────────────────────────────────────────────────────────

interface DomainResult {
  domain: string;
  findings: Finding[];
  error: string | null;
  durationMs: number;
}

async function runFullMode(opts: {
  projectRoot: string;
  config: ResolvedConfig;
  preset: ApiPreset;
  model: string;
  concurrencyCap?: number;
  /** Filter applied before domain partition (for compliance mode). */
  standardFilter?: (std: { id: string; tags?: string[] }) => boolean;
  modeLabel?: Mode;
}): Promise<AuditOutput> {
  const modeLabel = opts.modeLabel ?? "full";
  const { applicableStandards, exclude, ignoredRules } = opts.config;

  const filtered = opts.standardFilter
    ? applicableStandards.filter(opts.standardFilter)
    : applicableStandards;

  if (filtered.length === 0) {
    return {
      mode: modeLabel,
      target: opts.projectRoot,
      standardsLoaded: 0,
      rulesChecked: 0,
      findings: [],
      warnings: ["No applicable standards after filter; nothing to scan."],
    };
  }

  // Fetch standards content + extract rules
  const standardsContent = await fetchStandards(filtered);
  const ruleSummaries = extractRuleSummaries(standardsContent);

  // Partition
  const { groups, unmapped } = partitionByDomain(filtered);

  // Build per-domain rule listings + count total rules
  let totalRules = 0;
  const domainPrompts: Array<{ domain: string; prompt: string; ruleCount: number }> = [];
  for (const group of groups) {
    const ruleLines: string[] = [];
    let ruleCount = 0;
    for (const std of group.standards) {
      const scoped = ruleSummaries[std.id];
      if (!scoped) continue;
      for (const rule of scoped.rules) {
        const severity = (rule.severity ?? scoped.severity ?? "medium").toLowerCase();
        ruleLines.push(`${std.id} rule ${rule.number} (${severity}) — ${rule.summary}`);
        ruleCount++;
        totalRules++;
      }
    }
    if (ruleCount === 0) continue;
    domainPrompts.push({
      domain: group.domain,
      ruleCount,
      prompt: buildScannerPrompt({
        domain: group.domain,
        projectRoot: opts.projectRoot,
        exclude,
        rules: ruleLines.join("\n"),
      }),
    });
  }

  // Run scanners in parallel with concurrency cap
  const cap = opts.concurrencyCap ?? 4;
  const timeoutMs = opts.preset.timeout_ms ?? 600_000;
  const tasks = domainPrompts.map(({ domain, prompt }) => async (): Promise<DomainResult> => {
    const started = Date.now();
    const runner = createRunner(opts.preset);
    try {
      const result = await runner.run(prompt, {
        model: opts.model,
        timeoutMs,
        cwd: opts.projectRoot,
        debugEnabled: false,
        presetName: opts.preset.name,
        allowedTools: ["Read", "Glob", "Grep"],
      });
      const durationMs = Date.now() - started;
      if (result.timedOut) return { domain, findings: [], error: "scanner timed out", durationMs };
      if (result.error) return { domain, findings: [], error: result.error, durationMs };
      if (!result.result) return { domain, findings: [], error: "empty scanner output", durationMs };
      const { findings } = parseFindings(result.result);
      return { domain, findings, error: null, durationMs };
    } catch (err) {
      return {
        domain,
        findings: [],
        error: (err as Error).message,
        durationMs: Date.now() - started,
      };
    }
  });

  const results = await runWithCap(tasks, cap);

  // Aggregate findings + collect warnings for failed scanners
  const allFindings: Finding[] = [];
  const warnings: string[] = [];
  if (unmapped.length > 0) {
    warnings.push(
      `Standards not mapped to a domain (defaulted to 'architecture'): ${unmapped.join(", ")}. Update DOMAIN_MAP in audit-runner.ts.`,
    );
  }
  for (const r of results) {
    if (r.error) {
      warnings.push(`Scanner '${r.domain}' did not complete (${r.error}). Domain results may be incomplete.`);
    }
    allFindings.push(...r.findings);
  }

  // Apply ignore list (rule-level + standard-level)
  const ignoreSet = new Set(ignoredRules);
  const kept = allFindings.filter(
    (f) => !ignoreSet.has(`${f.standardId}/rule-${f.rule}`) && !ignoreSet.has(f.standardId),
  );
  const suppressed = allFindings.length - kept.length;
  if (suppressed > 0) warnings.push(`Suppressed ${suppressed} finding(s) by ignore config.`);

  return {
    mode: modeLabel,
    target: opts.projectRoot,
    standardsLoaded: filtered.length,
    rulesChecked: totalRules,
    findings: kept,
    warnings,
  };
}

// ─── Compliance Mode ───────────────────────────────────────────────────────

const FRAMEWORK_TO_STANDARD: Record<Framework, string> = {
  gdpr: "compliance-gdpr",
  "pci-dss": "compliance-pci-dss",
  hipaa: "compliance-hipaa",
};

async function runComplianceMode(opts: {
  projectRoot: string;
  config: ResolvedConfig;
  preset: ApiPreset;
  model: string;
  framework: Framework;
  concurrencyCap?: number;
}): Promise<AuditOutput> {
  const targetStandardId = FRAMEWORK_TO_STANDARD[opts.framework];
  const hasFramework = opts.config.applicableStandards.some((s) => s.id === targetStandardId);
  if (!hasFramework) {
    throw new Error(
      `Compliance framework '${opts.framework}' is not configured in .vcp/config.json. Run /vcp-init to add it.`,
    );
  }

  // Filter: keep the target compliance standard + anything tagged "security"
  const standardFilter = (std: { id: string; tags?: string[] }) =>
    std.id === targetStandardId || (Array.isArray(std.tags) && std.tags.includes("security"));

  return runFullMode({
    projectRoot: opts.projectRoot,
    config: opts.config,
    preset: opts.preset,
    model: opts.model,
    concurrencyCap: opts.concurrencyCap,
    standardFilter,
    modeLabel: "compliance",
  });
}

// ─── Full-mode Renderer ────────────────────────────────────────────────────

export function renderFullMarkdown(out: AuditOutput): string {
  const { findings, standardsLoaded, rulesChecked, warnings, mode, target } = out;
  const summary = summarizeByStandard(findings);

  // Order summary rows by verdict severity then by standard id
  const verdictRank: Record<StandardSummary["verdict"], number> = { FAIL: 0, WARN: 1, PASS: 2 };
  summary.sort((a, b) =>
    verdictRank[a.verdict] - verdictRank[b.verdict] || a.standardId.localeCompare(b.standardId),
  );

  const totalCritical = summary.reduce((s, r) => s + r.critical, 0);
  const totalHigh = summary.reduce((s, r) => s + r.high, 0);
  const totalMedium = summary.reduce((s, r) => s + r.medium, 0);

  const heading = mode === "compliance" ? "### VCP Compliance Audit" : "### VCP Audit";
  const lines: string[] = [
    heading,
    "",
    `**Standards loaded:** ${standardsLoaded} standards, ${rulesChecked} rules checked`,
    `**Target:** ${target}`,
    "",
  ];

  if (summary.length === 0) {
    lines.push("**Result:** No findings across all scanned standards.");
  } else {
    lines.push("#### Standards Summary");
    lines.push("");
    lines.push("| Standard | Status | Critical | High | Medium |");
    lines.push("|----------|--------|----------|------|--------|");
    for (const s of summary) {
      lines.push(`| ${s.standardId} | ${s.verdict} | ${s.critical} | ${s.high} | ${s.medium} |`);
    }
    lines.push("");
    lines.push(
      `**Overall: ${totalCritical} critical, ${totalHigh} high, ${totalMedium} medium findings across ${summary.length} standards.**`,
    );
    lines.push("");

    // Group findings by standard
    const byStandard = new Map<string, Finding[]>();
    for (const f of findings) {
      if (!byStandard.has(f.standardId)) byStandard.set(f.standardId, []);
      byStandard.get(f.standardId)!.push(f);
    }

    lines.push("#### Findings by Standard");
    lines.push("");
    for (const s of summary) {
      const stdFindings = byStandard.get(s.standardId) ?? [];
      if (stdFindings.length === 0) continue;
      lines.push(`##### ${s.standardId}`);
      lines.push("");
      for (const f of stdFindings) {
        lines.push(`- **Rule ${f.rule}** (${f.severity}) — ${f.issue}`);
        lines.push(`  - **File:** ${f.file}${f.line !== null ? `:${f.line}` : ""}`);
        if (f.fix) lines.push(`  - **Fix:** ${f.fix}`);
      }
      lines.push("");
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    for (const w of warnings) lines.push(`> ${w}`);
  }

  return lines.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`[audit-runner] ${(err as Error).message}`);
    process.exit(1);
  }

  const projectRoot = path.resolve(args.path ?? adapterProjectDir());

  let config: ResolvedConfig;
  try {
    config = await resolveConfig(projectRoot);
  } catch (err) {
    console.error(`[audit-runner] ${(err as Error).message}`);
    process.exit(1);
  }

  let preset: ApiPreset;
  let model: string;
  try {
    ({ preset, model } = pickPreset(args.preset, args.model));
  } catch (err) {
    console.error(`[audit-runner] ${(err as Error).message}`);
    process.exit(1);
  }

  let output: AuditOutput;
  try {
    if (args.mode === "quick") {
      output = await runQuickMode({ projectRoot, config, preset, model });
    } else if (args.mode === "full") {
      output = await runFullMode({ projectRoot, config, preset, model });
    } else if (args.mode === "compliance") {
      output = await runComplianceMode({
        projectRoot,
        config,
        preset,
        model,
        framework: args.framework!,
      });
    } else {
      console.error(`[audit-runner] unknown mode '${args.mode}'`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[audit-runner] ${(err as Error).message}`);
    process.exit(2);
  }

  if (args.format === "json") {
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (output.mode === "quick") {
      console.log(renderQuickMarkdown(output));
    } else {
      console.log(renderFullMarkdown(output));
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[audit-runner] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
