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

interface ParsedArgs {
  mode: Mode;
  framework?: Framework;
  path?: string;
  preset?: string;
  model?: string;
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
      default:
        if (flag.startsWith("--")) throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (!result.mode) throw new Error("--mode is required");
  if (result.mode === "compliance" && !result.framework) {
    throw new Error("--framework is required when --mode=compliance");
  }
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
    } else {
      console.error(
        `[audit-runner] mode '${args.mode}' is not yet implemented in this build. Use --mode quick.`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`[audit-runner] ${(err as Error).message}`);
    process.exit(2);
  }

  console.log(JSON.stringify(output, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[audit-runner] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
