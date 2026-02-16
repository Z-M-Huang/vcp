/**
 * Tests for the VCP Context Core shared module.
 *
 * Unit tests cover pure logic (resolveApplicableStandards, extractRuleSummaries,
 * formatContext). Integration tests spawn the security-context.ts hook and
 * verify stdout output format.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  resolveApplicableStandards,
  extractRuleSummaries,
  parseIgnoreList,
  formatContext,
  flattenV2Manifest,
  FALLBACK_MESSAGE,
  type Manifest,
  type ManifestV2Root,
  type ScopeManifestFile,
  type StandardEntry,
  type VcpConfig,
  type ScopedRules,
} from "./vcp-context-core";

// --- Test fixtures ---

const BASE_MANIFEST: Manifest = {
  version: "1.0",
  repository: "https://github.com/Z-M-Huang/vcp",
  standards_base_url:
    "https://raw.githubusercontent.com/Z-M-Huang/vcp/main/standards/",
  scopes: ["core", "web-frontend", "web-backend", "database", "compliance"],
  standards: [
    {
      id: "core-security",
      path: "core-security.md",
      scope: "core",
      severity: "critical",
      tags: ["security"],
      applies: "always",
    },
    {
      id: "core-architecture",
      path: "core-architecture.md",
      scope: "core",
      severity: "high",
      tags: ["architecture"],
      applies: "always",
    },
    {
      id: "web-backend-security",
      path: "web-backend-security.md",
      scope: "web-backend",
      severity: "critical",
      tags: ["security"],
      applies: "web-backend",
    },
    {
      id: "web-frontend-security",
      path: "web-frontend-security.md",
      scope: "web-frontend",
      severity: "critical",
      tags: ["security"],
      applies: "web-frontend",
    },
    {
      id: "compliance-gdpr",
      path: "compliance-gdpr.md",
      scope: "compliance",
      severity: "critical",
      tags: ["compliance", "gdpr"],
      applies: "compliance:gdpr",
    },
    {
      id: "database-encryption",
      path: "database-encryption.md",
      scope: "database",
      severity: "critical",
      tags: ["database", "encryption"],
      applies: "database",
    },
  ],
};

const SAMPLE_MARKDOWN = `---
id: core-security
title: Security
scope: core
severity: critical
tags: [security]
---

## Principle

Security is important.

## Rules

### Input and Output

1. **Validate all input at system boundaries.** Every value must be checked.

2. **Encode output for its destination context.** Data must be encoded.

### Secrets

3. **Never hardcode secrets.** Use environment variables.

## Patterns

Some patterns here.
`;

const ARCHITECTURE_MARKDOWN = `---
id: core-architecture
title: Architecture
scope: core
severity: high
tags: [architecture]
---

## Principle

Good architecture matters.

## Rules

### Single Responsibility

1. **One module, one job.** Keep things focused.

2. **Separate what changes for different reasons.** Different concerns, different modules.

## Patterns

Architecture patterns here.
`;

const NO_RULES_MARKDOWN = `---
id: test-standard
title: No Rules
scope: core
severity: medium
tags: [test]
---

## Principle

This standard has no rules section.
`;

// --- Helpers ---

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vcp-ctx-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// parseIgnoreList
// ---------------------------------------------------------------------------
describe("parseIgnoreList", () => {
  test("separates standard IDs, rule refs, and CWEs", () => {
    const result = parseIgnoreList([
      "core-architecture",
      "core-security/rule-3",
      "CWE-798",
    ]);
    expect(result.standards.has("core-architecture")).toBe(true);
    expect(result.rules.has("core-security/rule-3")).toBe(true);
    expect(result.cwes.has("CWE-798")).toBe(true);
  });

  test("empty array returns empty sets", () => {
    const result = parseIgnoreList([]);
    expect(result.standards.size).toBe(0);
    expect(result.rules.size).toBe(0);
    expect(result.cwes.size).toBe(0);
  });

  test("multiple entries of same type", () => {
    const result = parseIgnoreList(["CWE-798", "CWE-89", "CWE-502"]);
    expect(result.cwes.size).toBe(3);
    expect(result.standards.size).toBe(0);
    expect(result.rules.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveApplicableStandards
// ---------------------------------------------------------------------------
describe("resolveApplicableStandards", () => {
  test("no config — returns only 'always' standards", () => {
    const result = resolveApplicableStandards(BASE_MANIFEST, null);
    expect(result.every((s) => s.applies === "always")).toBe(true);
    expect(result.length).toBe(2);
    expect(result.map((s) => s.id)).toEqual([
      "core-security",
      "core-architecture",
    ]);
  });

  test("config with web-backend scope — includes always + web-backend", () => {
    const config: VcpConfig = {
      version: "1.0",
      scopes: { "web-backend": true },
      compliance: [],
    };
    const result = resolveApplicableStandards(BASE_MANIFEST, config);
    const ids = result.map((s) => s.id);
    expect(ids).toContain("core-security");
    expect(ids).toContain("core-architecture");
    expect(ids).toContain("web-backend-security");
    expect(ids).not.toContain("web-frontend-security");
    expect(ids).not.toContain("compliance-gdpr");
    expect(ids).not.toContain("database-encryption");
  });

  test("config with compliance:gdpr — includes always + compliance:gdpr", () => {
    const config: VcpConfig = {
      version: "1.0",
      scopes: {},
      compliance: ["gdpr"],
    };
    const result = resolveApplicableStandards(BASE_MANIFEST, config);
    const ids = result.map((s) => s.id);
    expect(ids).toContain("core-security");
    expect(ids).toContain("compliance-gdpr");
    expect(ids).not.toContain("web-backend-security");
  });

  test("config with all scopes and compliance — includes everything", () => {
    const config: VcpConfig = {
      version: "1.0",
      scopes: {
        "web-frontend": true,
        "web-backend": true,
        database: true,
      },
      compliance: ["gdpr"],
    };
    const result = resolveApplicableStandards(BASE_MANIFEST, config);
    expect(result.length).toBe(BASE_MANIFEST.standards.length);
  });

  test("disabled scope is excluded", () => {
    const config: VcpConfig = {
      version: "1.0",
      scopes: { "web-backend": false, "web-frontend": true },
      compliance: [],
    };
    const result = resolveApplicableStandards(BASE_MANIFEST, config);
    const ids = result.map((s) => s.id);
    expect(ids).toContain("web-frontend-security");
    expect(ids).not.toContain("web-backend-security");
  });

  test("ignore removes entire standard by ID", () => {
    const config: VcpConfig = {
      version: "1.0",
      scopes: {},
      compliance: [],
      ignore: ["core-architecture"],
    };
    const result = resolveApplicableStandards(BASE_MANIFEST, config);
    const ids = result.map((s) => s.id);
    expect(ids).toContain("core-security");
    expect(ids).not.toContain("core-architecture");
  });

  test("ignore removes multiple standards", () => {
    const config: VcpConfig = {
      version: "1.0",
      scopes: { "web-backend": true },
      compliance: [],
      ignore: ["core-architecture", "web-backend-security"],
    };
    const result = resolveApplicableStandards(BASE_MANIFEST, config);
    const ids = result.map((s) => s.id);
    expect(ids).toContain("core-security");
    expect(ids).not.toContain("core-architecture");
    expect(ids).not.toContain("web-backend-security");
  });

  test("rule-level and CWE ignores do not affect standard filtering", () => {
    const config: VcpConfig = {
      version: "1.0",
      scopes: {},
      compliance: [],
      ignore: ["core-security/rule-3", "CWE-798"],
    };
    const result = resolveApplicableStandards(BASE_MANIFEST, config);
    const ids = result.map((s) => s.id);
    // Both core standards should still be present
    expect(ids).toContain("core-security");
    expect(ids).toContain("core-architecture");
  });
});

// ---------------------------------------------------------------------------
// extractRuleSummaries
// ---------------------------------------------------------------------------
describe("extractRuleSummaries", () => {
  test("extracts bold rule titles from markdown", () => {
    const standards = new Map([["core-security", SAMPLE_MARKDOWN]]);
    const entries: StandardEntry[] = [
      {
        id: "core-security",
        path: "core-security.md",
        scope: "core",
        severity: "critical",
        tags: ["security"],
        applies: "always",
      },
    ];
    const result = extractRuleSummaries(standards, entries);
    expect(result.core).toBeDefined();
    expect(result.core.length).toBe(1);
    expect(result.core[0].title).toBe("Security");
    expect(result.core[0].severity).toBe("critical");
    expect(result.core[0].rules).toEqual([
      "Validate all input at system boundaries.",
      "Encode output for its destination context.",
      "Never hardcode secrets.",
    ]);
  });

  test("groups multiple standards by scope", () => {
    const standards = new Map([
      ["core-security", SAMPLE_MARKDOWN],
      ["core-architecture", ARCHITECTURE_MARKDOWN],
    ]);
    const entries: StandardEntry[] = [
      {
        id: "core-security",
        path: "core-security.md",
        scope: "core",
        severity: "critical",
        tags: ["security"],
        applies: "always",
      },
      {
        id: "core-architecture",
        path: "core-architecture.md",
        scope: "core",
        severity: "high",
        tags: ["architecture"],
        applies: "always",
      },
    ];
    const result = extractRuleSummaries(standards, entries);
    expect(result.core.length).toBe(2);
    expect(result.core[0].title).toBe("Security");
    expect(result.core[1].title).toBe("Architecture");
  });

  test("skips standards without Rules section", () => {
    const standards = new Map([["test-standard", NO_RULES_MARKDOWN]]);
    const entries: StandardEntry[] = [
      {
        id: "test-standard",
        path: "test.md",
        scope: "core",
        severity: "medium",
        tags: ["test"],
        applies: "always",
      },
    ];
    const result = extractRuleSummaries(standards, entries);
    expect(Object.keys(result).length).toBe(0);
  });

  test("skips entries not in standards map", () => {
    const standards = new Map<string, string>();
    const entries: StandardEntry[] = [
      {
        id: "missing",
        path: "missing.md",
        scope: "core",
        severity: "high",
        tags: [],
        applies: "always",
      },
    ];
    const result = extractRuleSummaries(standards, entries);
    expect(Object.keys(result).length).toBe(0);
  });

  test("rule-level ignore removes specific rule by number", () => {
    const standards = new Map([["core-security", SAMPLE_MARKDOWN]]);
    const entries: StandardEntry[] = [
      {
        id: "core-security",
        path: "core-security.md",
        scope: "core",
        severity: "critical",
        tags: ["security"],
        applies: "always",
      },
    ];
    const config: VcpConfig = {
      version: "1.0",
      scopes: {},
      compliance: [],
      ignore: ["core-security/rule-2"],
    };
    const result = extractRuleSummaries(standards, entries, config);
    expect(result.core[0].rules).toEqual([
      "Validate all input at system boundaries.",
      // Rule 2 ("Encode output...") should be filtered out
      "Never hardcode secrets.",
    ]);
  });

  test("multiple rule-level ignores on same standard", () => {
    const standards = new Map([["core-security", SAMPLE_MARKDOWN]]);
    const entries: StandardEntry[] = [
      {
        id: "core-security",
        path: "core-security.md",
        scope: "core",
        severity: "critical",
        tags: ["security"],
        applies: "always",
      },
    ];
    const config: VcpConfig = {
      version: "1.0",
      scopes: {},
      compliance: [],
      ignore: ["core-security/rule-1", "core-security/rule-3"],
    };
    const result = extractRuleSummaries(standards, entries, config);
    expect(result.core[0].rules).toEqual([
      "Encode output for its destination context.",
    ]);
  });

  test("ignoring all rules removes the standard from output", () => {
    const standards = new Map([["core-architecture", ARCHITECTURE_MARKDOWN]]);
    const entries: StandardEntry[] = [
      {
        id: "core-architecture",
        path: "core-architecture.md",
        scope: "core",
        severity: "high",
        tags: ["architecture"],
        applies: "always",
      },
    ];
    const config: VcpConfig = {
      version: "1.0",
      scopes: {},
      compliance: [],
      ignore: ["core-architecture/rule-1", "core-architecture/rule-2"],
    };
    const result = extractRuleSummaries(standards, entries, config);
    // All rules ignored → standard should not appear
    expect(Object.keys(result).length).toBe(0);
  });

  test("no config means no rule filtering", () => {
    const standards = new Map([["core-security", SAMPLE_MARKDOWN]]);
    const entries: StandardEntry[] = [
      {
        id: "core-security",
        path: "core-security.md",
        scope: "core",
        severity: "critical",
        tags: ["security"],
        applies: "always",
      },
    ];
    const result = extractRuleSummaries(standards, entries, null);
    expect(result.core[0].rules.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// formatContext
// ---------------------------------------------------------------------------
describe("formatContext", () => {
  test("output starts with VCP Standards Context heading", () => {
    const rules: ScopedRules = {
      core: [{ title: "Security", severity: "critical", rules: ["Rule A."] }],
    };
    const output = formatContext(rules);
    expect(output.startsWith("## VCP Standards Context")).toBe(true);
  });

  test("core scope grouped under Core Rules heading", () => {
    const rules: ScopedRules = {
      core: [{ title: "Security", severity: "critical", rules: ["Rule A."] }],
    };
    const output = formatContext(rules);
    expect(output).toContain("### Core Rules");
    expect(output).toContain("**Security** (critical): Rule A.");
  });

  test("non-core scope under appropriate heading", () => {
    const rules: ScopedRules = {
      core: [{ title: "Security", severity: "critical", rules: ["Core rule."] }],
      "web-backend": [
        {
          title: "Backend Security",
          severity: "critical",
          rules: ["Backend rule."],
        },
      ],
    };
    const output = formatContext(rules);
    expect(output).toContain("### Core Rules");
    expect(output).toContain("### Web Backend Rules");
  });

  test("ends with cross-reference to /vcp-audit", () => {
    const rules: ScopedRules = {
      core: [{ title: "Security", severity: "critical", rules: ["Rule."] }],
    };
    const output = formatContext(rules);
    expect(output).toContain("> Run /vcp-audit for deep analysis.");
  });

  test("truncates lowest-severity standards when over budget", () => {
    // Create many low-severity rules to exceed the ~700-token core budget
    const longRules = Array.from(
      { length: 50 },
      (_, i) => `This is a deliberately verbose rule number ${i + 1} that takes up space in the token budget.`,
    );
    const rules: ScopedRules = {
      core: [
        { title: "Security", severity: "critical", rules: ["Critical rule."] },
        { title: "Low Priority", severity: "low", rules: longRules },
      ],
    };
    const output = formatContext(rules);
    // Critical standard should survive truncation
    expect(output).toContain("**Security** (critical)");
    // Low-severity standard should be truncated if budget is exceeded
    const charBudget = 700 * 4;
    expect(output.length).toBeLessThanOrEqual(charBudget + 200); // Allow small margin for edge cases
  });

  test("core rules appear before non-core rules", () => {
    const rules: ScopedRules = {
      "web-backend": [
        { title: "Backend", severity: "critical", rules: ["Backend rule."] },
      ],
      core: [{ title: "Security", severity: "critical", rules: ["Core rule."] }],
    };
    const output = formatContext(rules);
    const coreIdx = output.indexOf("### Core Rules");
    const backendIdx = output.indexOf("### Web Backend Rules");
    expect(coreIdx).toBeLessThan(backendIdx);
  });
});

// ---------------------------------------------------------------------------
// flattenV2Manifest
// ---------------------------------------------------------------------------
describe("flattenV2Manifest", () => {
  const V2_ROOT: ManifestV2Root = {
    version: "2.0",
    repository: "https://github.com/Z-M-Huang/vcp",
    standards_base_url:
      "https://raw.githubusercontent.com/Z-M-Huang/vcp/main/standards/",
    scopes: {
      core: { manifest: "scopes/core.json", applies: "always" },
      "web-backend": {
        manifest: "scopes/web-backend.json",
        applies: "web-backend",
      },
      mobile: { manifest: "scopes/mobile.json", applies: "mobile" },
      "compliance-gdpr": {
        manifest: "scopes/compliance-gdpr.json",
        applies: "compliance:gdpr",
      },
    },
  };

  const CORE_SCOPE: ScopeManifestFile = {
    scope: "core",
    standards: [
      {
        id: "core-security",
        path: "core-security.md",
        severity: "critical",
        tags: ["security"],
      },
      {
        id: "core-architecture",
        path: "core-architecture.md",
        severity: "high",
        tags: ["architecture"],
      },
    ],
  };

  const BACKEND_SCOPE: ScopeManifestFile = {
    scope: "web-backend",
    standards: [
      {
        id: "web-backend-security",
        path: "web-backend-security.md",
        severity: "critical",
        tags: ["security"],
      },
    ],
  };

  const MOBILE_SCOPE: ScopeManifestFile = {
    scope: "mobile",
    standards: [
      {
        id: "mobile-security",
        path: "mobile-security.md",
        severity: "critical",
        tags: ["security", "mobile"],
      },
    ],
  };

  const GDPR_SCOPE: ScopeManifestFile = {
    scope: "compliance",
    standards: [
      {
        id: "compliance-gdpr",
        path: "compliance-gdpr.md",
        severity: "critical",
        tags: ["compliance", "gdpr"],
      },
    ],
  };

  test("flattens multiple scope manifests into unified Manifest shape", () => {
    const result = flattenV2Manifest(V2_ROOT, [
      { scopeKey: "core", applies: "always", sm: CORE_SCOPE },
      { scopeKey: "web-backend", applies: "web-backend", sm: BACKEND_SCOPE },
    ]);

    expect(result.version).toBe("2.0");
    expect(result.repository).toBe("https://github.com/Z-M-Huang/vcp");
    expect(result.scopes).toEqual(["core", "web-backend"]);
    expect(result.standards.length).toBe(3);
  });

  test("preserves applies field from root manifest, not scope manifest", () => {
    const result = flattenV2Manifest(V2_ROOT, [
      {
        scopeKey: "compliance-gdpr",
        applies: "compliance:gdpr",
        sm: GDPR_SCOPE,
      },
    ]);

    expect(result.standards[0].applies).toBe("compliance:gdpr");
    expect(result.standards[0].scope).toBe("compliance");
  });

  test("uses scope from scope manifest file for the scope field", () => {
    const result = flattenV2Manifest(V2_ROOT, [
      { scopeKey: "core", applies: "always", sm: CORE_SCOPE },
    ]);

    expect(result.standards[0].scope).toBe("core");
    expect(result.standards[1].scope).toBe("core");
  });

  test("all standard entry fields are populated", () => {
    const result = flattenV2Manifest(V2_ROOT, [
      { scopeKey: "mobile", applies: "mobile", sm: MOBILE_SCOPE },
    ]);

    const entry = result.standards[0];
    expect(entry.id).toBe("mobile-security");
    expect(entry.path).toBe("mobile-security.md");
    expect(entry.scope).toBe("mobile");
    expect(entry.severity).toBe("critical");
    expect(entry.tags).toEqual(["security", "mobile"]);
    expect(entry.applies).toBe("mobile");
  });

  test("empty scope manifests array produces empty standards", () => {
    const result = flattenV2Manifest(V2_ROOT, []);

    expect(result.version).toBe("2.0");
    expect(result.scopes).toEqual([]);
    expect(result.standards).toEqual([]);
  });

  test("flattened result works with resolveApplicableStandards", () => {
    const manifest = flattenV2Manifest(V2_ROOT, [
      { scopeKey: "core", applies: "always", sm: CORE_SCOPE },
      { scopeKey: "web-backend", applies: "web-backend", sm: BACKEND_SCOPE },
      { scopeKey: "mobile", applies: "mobile", sm: MOBILE_SCOPE },
      {
        scopeKey: "compliance-gdpr",
        applies: "compliance:gdpr",
        sm: GDPR_SCOPE,
      },
    ]);

    // Config enables web-backend but not mobile
    const config: VcpConfig = {
      version: "1.0",
      scopes: { "web-backend": true, mobile: false },
      compliance: ["gdpr"],
    };

    const result = resolveApplicableStandards(manifest, config);
    const ids = result.map((s) => s.id);

    expect(ids).toContain("core-security");
    expect(ids).toContain("core-architecture");
    expect(ids).toContain("web-backend-security");
    expect(ids).toContain("compliance-gdpr");
    expect(ids).not.toContain("mobile-security");
  });
});

// ---------------------------------------------------------------------------
// Integration: security-context.ts hook
// ---------------------------------------------------------------------------
describe("integration: security-context.ts", () => {
  const HOOK_PATH = join(
    import.meta.dir,
    "..",
    "hooks",
    "security-context.ts",
  );

  test("outputs context and exits 0", async () => {
    await withTmpDir(async (dir) => {
      const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(exitCode).toBe(0);
      // Should output either formatted context or fallback message
      expect(
        stdout.includes("VCP Standards Context") ||
          stdout.includes("VCP active"),
      ).toBe(true);
    });
  }, 20000);

  test("exits 0 with no project config", async () => {
    await withTmpDir(async (dir) => {
      // Empty dir — no .vcp.json. Hook should still exit 0 and produce output.
      const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    });
  }, 20000);

  test("never exits non-zero (informational only)", async () => {
    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "/nonexistent" },
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  }, 20000);
});

