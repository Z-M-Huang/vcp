#!/usr/bin/env bun
/**
 * MCP Doc scan-runner — deterministic documentation coverage scan.
 *
 * Replaces the LLM-driven scan in mcp-doc-scan/SKILL.md with a deterministic
 * TS implementation. Reads .mcp/manifest.yml, walks the project tree, and
 * categorizes each significant directory:
 *   - documented-indexed   (has doc file AND in manifest)
 *   - documented-not-indexed (has doc file but NOT in manifest)
 *   - undocumented         (significant but no doc file; with priority)
 *   - stale                (manifest entry whose file no longer exists)
 *
 * Usage:
 *   bun scan-runner.ts [--path <subtree>] [--format markdown|json]
 *
 * Exit codes:
 *   0 - success (report on stdout)
 *   1 - validation error (no manifest, bad args)
 */

import path from "path";
import fs from "fs";
import * as YAML from "yaml";

// ─── Types ─────────────────────────────────────────────────────────────────

type Format = "markdown" | "json";
type Priority = "critical" | "high" | "medium" | "low";
type DirStatus =
  | "documented-indexed"
  | "documented-not-indexed"
  | "undocumented"
  | "stale";

interface ScanArgs {
  path?: string;
  format: Format;
  projectRoot: string;
}

interface ManifestResource {
  name: string;
  uri: string;
  description?: string;
}

interface DirectoryEntry {
  path: string;
  status: DirStatus;
  priority?: Priority;
  docFile?: string;
  inManifest: boolean;
}

export interface ScanReport {
  scope: string;
  totals: {
    significantDirs: number;
    documentedIndexed: number;
    documentedNotIndexed: number;
    undocumented: number;
    stale: number;
  };
  entries: DirectoryEntry[];
  nonMarkdownDocs: string[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const BASE_EXCLUDES = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "__pycache__",
  ".pytest_cache", "target", "vendor", ".venv", ".next", ".nuxt",
  ".cache", ".turbo", "tmp", ".output", "out",
]);

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".swift",
  ".rb", ".cs", ".cpp", ".c", ".h", ".hpp",
]);

const MODULE_FILES = new Set([
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile",
]);

const DOC_EXTS = new Set([".md", ".rst", ".txt"]);
const NON_MD_DOC_PATTERNS = /^(openapi|swagger)\.(ya?ml|json)$|\.api\.md$/i;

// ─── CLI ───────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): ScanArgs {
  const args = argv.slice(2);
  const result: Partial<ScanArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case "--path":
        if (!value) throw new Error("--path requires a value");
        result.path = value;
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

  if (!result.format) result.format = "markdown";
  if (!result.projectRoot) result.projectRoot = process.cwd();
  return result as ScanArgs;
}

// ─── Manifest Loading ──────────────────────────────────────────────────────

export function loadManifestResources(projectRoot: string): {
  exists: boolean;
  resources: ManifestResource[];
} {
  const manifestPath = path.join(projectRoot, ".mcp", "manifest.yml");
  if (!fs.existsSync(manifestPath)) return { exists: false, resources: [] };

  const raw = fs.readFileSync(manifestPath, "utf-8");
  let parsed: any;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`.mcp/manifest.yml is not valid YAML: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    return { exists: true, resources: [] };
  }

  const resources: ManifestResource[] = [];
  if (Array.isArray(parsed.resources)) {
    for (const r of parsed.resources) {
      if (r && typeof r.name === "string" && typeof r.uri === "string") {
        resources.push({
          name: r.name,
          uri: r.uri,
          description: typeof r.description === "string" ? r.description : undefined,
        });
      }
    }
  }
  return { exists: true, resources };
}

/**
 * Manifest URIs are relative to .mcp/, so `../src/api/README.md` becomes
 * `src/api/README.md` from the project root.
 */
export function resolveManifestUri(uri: string): string {
  // path.normalize collapses `../` and `./` into a clean relative path.
  const fromMcp = path.posix.normalize(uri);
  // The manifest dir is .mcp/, so apply that prefix when computing the
  // project-relative path. e.g. `../src/x.md` -> `src/x.md`.
  return path.posix.normalize(path.posix.join(".mcp", fromMcp));
}

// ─── Filesystem walk ───────────────────────────────────────────────────────

interface WalkResult {
  docFiles: Set<string>;        // project-relative paths
  significantDirs: Set<string>; // project-relative dir paths (incl. ".")
  nonMarkdownDocs: string[];    // project-relative paths
}

export function walkProject(projectRoot: string, subtree?: string): WalkResult {
  const docFiles = new Set<string>();
  const significantDirs = new Set<string>();
  const nonMarkdownDocs: string[] = [];

  const startDir = subtree
    ? path.resolve(projectRoot, subtree)
    : projectRoot;

  if (!fs.existsSync(startDir) || !fs.statSync(startDir).isDirectory()) {
    return { docFiles, significantDirs, nonMarkdownDocs };
  }

  const visit = (absDir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    let hasSourceCode = false;
    let hasModuleFile = false;

    for (const entry of entries) {
      const fullPath = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        if (BASE_EXCLUDES.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        visit(fullPath);
        continue;
      }

      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTS.has(ext)) hasSourceCode = true;
        if (MODULE_FILES.has(entry.name)) hasModuleFile = true;
        if (NON_MD_DOC_PATTERNS.test(entry.name)) {
          nonMarkdownDocs.push(path.relative(projectRoot, fullPath));
        }
        if (DOC_EXTS.has(ext)) {
          docFiles.add(path.relative(projectRoot, fullPath));
        }
      }
    }

    if (hasSourceCode || hasModuleFile) {
      const rel = path.relative(projectRoot, absDir);
      significantDirs.add(rel === "" ? "." : rel);
    }
  };

  visit(startDir);
  return { docFiles, significantDirs, nonMarkdownDocs };
}

// ─── Priority assignment ──────────────────────────────────────────────────

export function assignPriority(dirPath: string, fileCount: number): Priority {
  const segments = dirPath.split(/[\/\\]/).filter(Boolean);
  const last = (segments[segments.length - 1] ?? dirPath).toLowerCase();

  // Critical: top-level source roots and api/route directories
  if (/^(src|app|lib|core)$/.test(last)) return "critical";
  if (/(api|routes?)$/.test(last)) return "critical";

  // High: services / utils / auth / models / shared
  if (/(services?|utils?|auth|models?|shared)$/.test(last)) return "high";

  // Medium: config / middleware / helpers / internal
  if (/(config|middleware|helpers?|internal)$/.test(last)) return "medium";

  // Low: tests / scripts / tools / examples / fixtures
  if (/^(tests?|__tests__|scripts?|tools?|examples?|fixtures?)$/.test(last)) return "low";

  // Default by file count: more files = more important
  if (fileCount > 10) return "high";
  if (fileCount > 5) return "medium";
  return "low";
}

function countFilesInDir(projectRoot: string, dirRel: string): number {
  const abs = path.join(projectRoot, dirRel);
  try {
    return fs.readdirSync(abs).filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return SOURCE_EXTS.has(ext);
    }).length;
  } catch {
    return 0;
  }
}

// ─── Categorization ───────────────────────────────────────────────────────

export function categorize(opts: {
  projectRoot: string;
  docFiles: Set<string>;
  significantDirs: Set<string>;
  manifestResourcePaths: Set<string>;
  nonMarkdownDocs: string[];
  scope: string;
}): ScanReport {
  const entries: DirectoryEntry[] = [];

  // 1. For each significant directory, look for a doc file inside it.
  for (const dir of opts.significantDirs) {
    const docCandidates = [...opts.docFiles].filter((d) => path.dirname(d) === dir || (dir === "." && !d.includes("/")));
    const primaryDoc = docCandidates.find((d) => /readme\.md$/i.test(d)) ?? docCandidates[0];
    const inManifest = primaryDoc ? opts.manifestResourcePaths.has(primaryDoc) : false;

    if (primaryDoc && inManifest) {
      entries.push({ path: dir, status: "documented-indexed", docFile: primaryDoc, inManifest: true });
    } else if (primaryDoc && !inManifest) {
      entries.push({ path: dir, status: "documented-not-indexed", docFile: primaryDoc, inManifest: false });
    } else {
      const fileCount = countFilesInDir(opts.projectRoot, dir);
      entries.push({
        path: dir,
        status: "undocumented",
        priority: assignPriority(dir, fileCount),
        inManifest: false,
      });
    }
  }

  // 2. Manifest entries whose files no longer exist -> stale
  for (const resourcePath of opts.manifestResourcePaths) {
    const abs = path.join(opts.projectRoot, resourcePath);
    if (!fs.existsSync(abs)) {
      entries.push({
        path: path.dirname(resourcePath) || ".",
        status: "stale",
        docFile: resourcePath,
        inManifest: true,
      });
    }
  }

  // Sort: stale first; then undocumented by priority; then documented-not-indexed; then documented-indexed
  const verdictRank: Record<DirStatus, number> = {
    "stale": 0,
    "undocumented": 1,
    "documented-not-indexed": 2,
    "documented-indexed": 3,
  };
  const priorityRank: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  entries.sort((a, b) => {
    const v = verdictRank[a.status] - verdictRank[b.status];
    if (v !== 0) return v;
    if (a.priority && b.priority) return priorityRank[a.priority] - priorityRank[b.priority];
    return a.path.localeCompare(b.path);
  });

  return {
    scope: opts.scope,
    totals: {
      significantDirs: opts.significantDirs.size,
      documentedIndexed: entries.filter((e) => e.status === "documented-indexed").length,
      documentedNotIndexed: entries.filter((e) => e.status === "documented-not-indexed").length,
      undocumented: entries.filter((e) => e.status === "undocumented").length,
      stale: entries.filter((e) => e.status === "stale").length,
    },
    entries,
    nonMarkdownDocs: opts.nonMarkdownDocs,
  };
}

// ─── Render ───────────────────────────────────────────────────────────────

export function renderMarkdown(report: ScanReport): string {
  const lines: string[] = [];
  lines.push("Documentation Coverage Report");
  lines.push("==============================");
  lines.push(`Scope: ${report.scope}`);
  lines.push("");
  lines.push(`Total significant directories: ${report.totals.significantDirs}`);
  lines.push(`Documented & indexed:          ${report.totals.documentedIndexed}`);
  lines.push(`Documented, not indexed:       ${report.totals.documentedNotIndexed}`);
  lines.push(`Undocumented:                  ${report.totals.undocumented}`);
  lines.push(`Stale manifest entries:        ${report.totals.stale}`);
  lines.push("");

  if (report.entries.length > 0) {
    lines.push("| Directory | Status | Priority | Doc File | In Manifest |");
    lines.push("|-----------|--------|----------|----------|-------------|");
    for (const e of report.entries) {
      const status = {
        "documented-indexed": "Documented & indexed",
        "documented-not-indexed": "Documented, not indexed",
        "undocumented": "Undocumented",
        "stale": "Stale",
      }[e.status];
      const docCell = e.docFile ?? "—";
      const manifestCell = e.status === "stale" ? "Yes (stale)" : e.inManifest ? "Yes" : e.status === "documented-not-indexed" ? "No" : "—";
      lines.push(`| ${e.path} | ${status} | ${e.priority ?? "—"} | ${docCell} | ${manifestCell} |`);
    }
    lines.push("");
  }

  if (report.nonMarkdownDocs.length > 0) {
    lines.push("Non-markdown documentation detected (not indexed):");
    for (const f of report.nonMarkdownDocs) lines.push(`  - ${f}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: ScanArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`[scan-runner] ${(err as Error).message}`);
    process.exit(1);
  }

  const { exists, resources } = loadManifestResources(args.projectRoot);
  if (!exists) {
    console.error(
      "[scan-runner] No manifest found at .mcp/manifest.yml. Run /mcp-doc-init to initialize the documentation manifest first.",
    );
    process.exit(1);
  }

  const manifestResourcePaths = new Set(resources.map((r) => resolveManifestUri(r.uri)));
  const { docFiles, significantDirs, nonMarkdownDocs } = walkProject(args.projectRoot, args.path);

  const scope = args.path ? args.path : "entire project";
  const report = categorize({
    projectRoot: args.projectRoot,
    docFiles,
    significantDirs,
    manifestResourcePaths,
    nonMarkdownDocs,
    scope,
  });

  if (args.format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[scan-runner] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
