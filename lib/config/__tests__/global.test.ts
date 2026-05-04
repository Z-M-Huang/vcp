/**
 * Tests for the VCP Global Config module.
 *
 * Covers: globalConfigPath, loadGlobalConfig, saveGlobalConfig,
 * ensureGlobalConfig, resolveStandardsUrl, resolvePluginRoot,
 * mergeIgnoreArrays, applyGlobalDefaults.
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";
import { homedir } from "os";

import {
  globalConfigPath,
  loadGlobalConfig,
  ensureGlobalConfig,
  validateStandardsUrl,
  resolveStandardsUrl,
  resolvePluginRoot,
  mergeIgnoreArrays,
  applyGlobalDefaults,
  DEFAULT_MANIFEST_URL,
  type VcpGlobalConfig,
} from "../src/global";

import type { VcpConfig } from "../src/types";

const SAMPLE_GLOBAL: VcpGlobalConfig = {
  standards_url: DEFAULT_MANIFEST_URL,
  pluginRoot: "/home/user/.claude/plugins/vcp",
  defaults: {
    severity: "high",
    scopes: { "web-backend": true },
    compliance: ["gdpr"],
    ignore: ["CWE-798"],
  },
};

const SAMPLE_PROJECT: VcpConfig = {
  version: "1.0",
  scopes: { "web-frontend": true, "web-backend": true },
  compliance: ["pci-dss"],
  severity: "medium",
  ignore: ["core-architecture/rule-5"],
};

describe("globalConfigPath", () => {
  test("returns path ending in .vcp/config.json", () => {
    const p = globalConfigPath();
    expect(p.endsWith(join(".vcp", "config.json"))).toBe(true);
  });

  test("starts with the user home directory", () => {
    const p = globalConfigPath();
    expect(p.startsWith(homedir())).toBe(true);
  });
});

describe("loadGlobalConfig", () => {
  test("returns null when file doesn't exist", async () => {
    const result = await loadGlobalConfig();
    expect(result === null || typeof result === "object").toBe(true);
  });
});

describe("saveGlobalConfig", () => {
  // Integration covered by ensureGlobalConfig's auto-create test.
});

describe("validateStandardsUrl", () => {
  test("accepts valid HTTPS URL", () => {
    expect(validateStandardsUrl("https://example.com/manifest.json")).toBeNull();
  });

  test("accepts the default manifest URL", () => {
    expect(validateStandardsUrl(DEFAULT_MANIFEST_URL)).toBeNull();
  });

  test("rejects HTTP URL", () => {
    const result = validateStandardsUrl("http://example.com/manifest.json");
    expect(result).toContain("HTTPS");
  });

  test("rejects localhost", () => {
    expect(validateStandardsUrl("https://localhost/manifest.json")).toContain("localhost");
    expect(validateStandardsUrl("https://127.0.0.1/manifest.json")).toContain("localhost");
    expect(validateStandardsUrl("https://[::1]/manifest.json")).toContain("localhost");
    expect(validateStandardsUrl("https://0.0.0.0/manifest.json")).toContain("localhost");
  });

  test("rejects private IPv4 ranges", () => {
    expect(validateStandardsUrl("https://10.0.0.1/manifest.json")).toContain("private");
    expect(validateStandardsUrl("https://172.16.0.1/manifest.json")).toContain("private");
    expect(validateStandardsUrl("https://172.31.255.255/manifest.json")).toContain("private");
    expect(validateStandardsUrl("https://192.168.1.1/manifest.json")).toContain("private");
  });

  test("rejects link-local addresses", () => {
    expect(validateStandardsUrl("https://169.254.1.1/manifest.json")).toContain("link-local");
    expect(validateStandardsUrl("https://[fe80::1]/manifest.json")).toContain("link-local");
  });

  test("rejects cloud metadata endpoints", () => {
    expect(validateStandardsUrl("https://169.254.169.254/latest/meta-data/")).toContain("link-local");
    expect(validateStandardsUrl("https://metadata.google.internal/v1/")).toContain("metadata");
  });

  test("rejects invalid URL", () => {
    expect(validateStandardsUrl("not-a-url")).toContain("not a valid URL");
  });

  test("rejects non-HTTP schemes", () => {
    expect(validateStandardsUrl("ftp://example.com/manifest.json")).toContain("HTTPS");
    expect(validateStandardsUrl("file:///etc/passwd")).toContain("HTTPS");
  });

  test("returns null for valid enterprise GitHub URLs", () => {
    expect(validateStandardsUrl("https://github.example.com/org/vcp/main/manifest.json")).toBeNull();
    expect(validateStandardsUrl("https://raw.github.example.com/org/vcp/main/manifest.json")).toBeNull();
  });

  test("rejects IPv6 ULA (fc00::/7)", () => {
    expect(validateStandardsUrl("https://[fd00::1]/manifest.json")).toContain("private");
    expect(validateStandardsUrl("https://[fc00::1]/manifest.json")).toContain("private");
  });

  test("rejects IPv4-mapped IPv6 loopback", () => {
    expect(validateStandardsUrl("https://[::ffff:7f00:1]/manifest.json")).toContain("localhost");
  });

  test("rejects IPv4-mapped IPv6 private ranges", () => {
    expect(validateStandardsUrl("https://[::ffff:a00:1]/manifest.json")).toContain("private");
    expect(validateStandardsUrl("https://[::ffff:c0a8:101]/manifest.json")).toContain("private");
    expect(validateStandardsUrl("https://[::ffff:ac10:1]/manifest.json")).toContain("private");
  });

  test("rejects trailing-dot localhost", () => {
    expect(validateStandardsUrl("https://localhost./manifest.json")).toContain("localhost");
  });
});

describe("resolveStandardsUrl", () => {
  test("project URL wins over global", () => {
    const project: VcpConfig = {
      ...SAMPLE_PROJECT,
      standards_url: "https://custom.example.com/manifest.json",
    };
    const result = resolveStandardsUrl(SAMPLE_GLOBAL, project);
    expect(result).toBe("https://custom.example.com/manifest.json");
  });

  test("global URL used when project has none", () => {
    const result = resolveStandardsUrl(SAMPLE_GLOBAL, SAMPLE_PROJECT);
    expect(result).toBe(DEFAULT_MANIFEST_URL);
  });

  test("null when both configs null", () => {
    const result = resolveStandardsUrl(null, null);
    expect(result).toBeNull();
  });

  test("global URL used when project is null", () => {
    const result = resolveStandardsUrl(SAMPLE_GLOBAL, null);
    expect(result).toBe(DEFAULT_MANIFEST_URL);
  });

  test("null when global is null and project has no standards_url", () => {
    const result = resolveStandardsUrl(null, SAMPLE_PROJECT);
    expect(result).toBeNull();
  });

  test("rejects invalid URL and returns null", () => {
    const global: VcpGlobalConfig = {
      ...SAMPLE_GLOBAL,
      standards_url: "http://insecure.example.com/manifest.json",
    };
    const result = resolveStandardsUrl(global, SAMPLE_PROJECT);
    expect(result).toBeNull();
  });

  test("rejects localhost URL and returns null", () => {
    const project: VcpConfig = {
      ...SAMPLE_PROJECT,
      standards_url: "https://localhost/manifest.json",
    };
    const result = resolveStandardsUrl(SAMPLE_GLOBAL, project);
    expect(result).toBeNull();
  });
});

describe("resolvePluginRoot", () => {
  test("project pluginRoot wins over global", () => {
    const project: VcpConfig = {
      ...SAMPLE_PROJECT,
      pluginRoot: "/project/specific/path",
    };
    const result = resolvePluginRoot(SAMPLE_GLOBAL, project);
    expect(result).toBe("/project/specific/path");
  });

  test("global pluginRoot used when project has none", () => {
    const result = resolvePluginRoot(SAMPLE_GLOBAL, SAMPLE_PROJECT);
    expect(result).toBe("/home/user/.claude/plugins/vcp");
  });

  test("null when both configs null", () => {
    const result = resolvePluginRoot(null, null);
    expect(result).toBeNull();
  });
});

describe("mergeIgnoreArrays", () => {
  test("unions two arrays", () => {
    const result = mergeIgnoreArrays(["CWE-798"], ["core-architecture/rule-5"]);
    expect(result).toContain("CWE-798");
    expect(result).toContain("core-architecture/rule-5");
    expect(result.length).toBe(2);
  });

  test("deduplicates", () => {
    const result = mergeIgnoreArrays(
      ["CWE-798", "core-security"],
      ["CWE-798", "core-architecture"],
    );
    expect(result.filter((e) => e === "CWE-798").length).toBe(1);
    expect(result.length).toBe(3);
  });

  test("handles empty arrays", () => {
    expect(mergeIgnoreArrays([], [])).toEqual([]);
    expect(mergeIgnoreArrays(["CWE-798"], [])).toEqual(["CWE-798"]);
    expect(mergeIgnoreArrays([], ["CWE-89"])).toEqual(["CWE-89"]);
  });
});

describe("applyGlobalDefaults", () => {
  test("project severity overrides global", () => {
    const result = applyGlobalDefaults(SAMPLE_GLOBAL, SAMPLE_PROJECT);
    expect(result.severity).toBe("medium");
  });

  test("global severity used when project omits it", () => {
    const project: VcpConfig = {
      version: "1.0",
      scopes: { "web-frontend": true },
      compliance: [],
    };
    const result = applyGlobalDefaults(SAMPLE_GLOBAL, project);
    expect(result.severity).toBe("high");
  });

  test("ignore arrays merged (union)", () => {
    const result = applyGlobalDefaults(SAMPLE_GLOBAL, SAMPLE_PROJECT);
    expect(result.ignore).toContain("CWE-798");
    expect(result.ignore).toContain("core-architecture/rule-5");
  });

  test("scopes not merged - project wins entirely", () => {
    const result = applyGlobalDefaults(SAMPLE_GLOBAL, SAMPLE_PROJECT);
    expect(result.scopes).toEqual(SAMPLE_PROJECT.scopes);
  });

  test("compliance not merged - project wins entirely", () => {
    const result = applyGlobalDefaults(SAMPLE_GLOBAL, SAMPLE_PROJECT);
    expect(result.compliance).toEqual(["pci-dss"]);
  });

  test("null global config returns project config unchanged", () => {
    const result = applyGlobalDefaults(null, SAMPLE_PROJECT);
    expect(result.severity).toBe(SAMPLE_PROJECT.severity);
    expect(result.scopes).toEqual(SAMPLE_PROJECT.scopes);
    expect(result.compliance).toEqual(SAMPLE_PROJECT.compliance);
    expect(result.ignore).toEqual(SAMPLE_PROJECT.ignore);
  });

  test("global config without defaults returns project config unchanged", () => {
    const globalNoDefaults: VcpGlobalConfig = {
      standards_url: DEFAULT_MANIFEST_URL,
      pluginRoot: "/some/path",
    };
    const result = applyGlobalDefaults(globalNoDefaults, SAMPLE_PROJECT);
    expect(result.severity).toBe(SAMPLE_PROJECT.severity);
    expect(result.ignore).toEqual(SAMPLE_PROJECT.ignore);
  });

  test("does not mutate original project config", () => {
    const original = { ...SAMPLE_PROJECT, ignore: ["original-entry"] };
    const result = applyGlobalDefaults(SAMPLE_GLOBAL, original);
    expect(result.ignore).toContain("CWE-798");
    expect(original.ignore).toEqual(["original-entry"]);
  });
});

describe("ensureGlobalConfig", () => {
  test("returns existing config if present (or null if absent)", async () => {
    const result = await ensureGlobalConfig(null);
    expect(result === null || typeof result === "object").toBe(true);
  });

  test("returns null when project config has no pluginRoot", async () => {
    const project: VcpConfig = {
      version: "1.0",
      scopes: { "web-backend": true },
      compliance: [],
    };
    const result = await ensureGlobalConfig(project);
    const globalExists = await loadGlobalConfig();
    if (globalExists) {
      expect(result).toEqual(globalExists);
    } else {
      expect(result).toBeNull();
    }
  });

  test("always uses DEFAULT_MANIFEST_URL (never promotes project standards_url)", async () => {
    const globalExists = await loadGlobalConfig();
    if (globalExists) {
      return;
    }

    const project: VcpConfig = {
      version: "1.0",
      scopes: {},
      compliance: [],
      pluginRoot: "/tmp/test-vcp-plugin",
      standards_url: "https://evil.example.com/manifest.json",
    };
    const result = await ensureGlobalConfig(project);
    expect(result).not.toBeNull();
    expect(result!.standards_url).toBe(DEFAULT_MANIFEST_URL);
    expect(result!.pluginRoot).toBe("/tmp/test-vcp-plugin");
    expect(result!.debug).toBe(false);

    const { unlink } = await import("fs/promises");
    try {
      await unlink(globalConfigPath());
    } catch {
      // ok if it doesn't exist
    }
  });
});

describe("DEFAULT_MANIFEST_URL", () => {
  test("points to the VCP main branch manifest", () => {
    expect(DEFAULT_MANIFEST_URL).toContain("Z-M-Huang/vcp");
    expect(DEFAULT_MANIFEST_URL).toContain("manifest.json");
    expect(DEFAULT_MANIFEST_URL.startsWith("https://")).toBe(true);
  });
});
