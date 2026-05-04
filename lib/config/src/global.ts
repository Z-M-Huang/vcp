/**
 * VCP Global Config — Machine-level configuration at ~/.vcp/config.json.
 *
 * Stores the standards repository URL, plugin root path, and optional
 * defaults that are shared across all projects on this machine.
 *
 * Created by /vcp-init, read by all VCP hooks and skills.
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { VcpConfig } from "./types";

// --- Types ---

export interface VcpGlobalConfig {
  standards_url: string;
  pluginRoot: string;
  debug?: boolean;
  defaults?: {
    severity?: string;
    scopes?: Record<string, boolean>;
    compliance?: string[];
    ignore?: string[];
  };
}

// --- Constants ---

export const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/Z-M-Huang/vcp/main/standards/manifest.json";

// --- Functions ---

export function globalConfigPath(): string {
  return join(homedir(), ".vcp", "config.json");
}

export async function loadGlobalConfig(): Promise<VcpGlobalConfig | null> {
  try {
    const raw = await readFile(globalConfigPath(), "utf-8");
    return JSON.parse(raw) as VcpGlobalConfig;
  } catch {
    return null;
  }
}

/**
 * Ensure a global config exists. If missing and enough info is available
 * from the project config, auto-create it with safe defaults.
 *
 * Security: Always uses DEFAULT_MANIFEST_URL — never promotes project
 * config's standards_url to global, because project config is untrusted
 * (any repo can contain a .vcp/config.json pointing to an attacker-controlled URL).
 * pluginRoot is taken from the project config since it's needed for
 * skill execution and is validated by callers before use.
 *
 * Returns the existing config, the newly created config, or null if
 * there isn't enough information to create one or if the write fails.
 */
export async function ensureGlobalConfig(
  projectConfig: VcpConfig | null,
): Promise<VcpGlobalConfig | null> {
  const existing = await loadGlobalConfig();
  if (existing) return existing;

  // Can't auto-create without enough info
  if (!projectConfig?.pluginRoot) return null;

  const config: VcpGlobalConfig = {
    standards_url: DEFAULT_MANIFEST_URL,
    pluginRoot: projectConfig.pluginRoot,
    debug: false,
  };
  try {
    await saveGlobalConfig(config);
  } catch {
    // Write failed (read-only HOME, permissions, etc.) — degrade gracefully
    return null;
  }
  return config;
}

export async function saveGlobalConfig(
  config: VcpGlobalConfig,
): Promise<void> {
  const configPath = globalConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Validate that a standards URL is safe to fetch.
 * Rejects non-HTTPS, localhost, private/link-local IPs, IPv6 ULA,
 * IPv4-mapped IPv6 loopback/private, trailing-dot localhost, and
 * cloud metadata endpoints.
 */
export function validateStandardsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return "standards_url must use HTTPS.";
    }
    // Normalize: lowercase and strip trailing dots (localhost. → localhost)
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");

    // Bracketed IPv6 addresses
    if (host.startsWith("[") && host.endsWith("]")) {
      return validateIpv6Host(host.slice(1, -1));
    }

    // Plain hostnames and IPv4
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0"
    ) {
      return "standards_url must not point to localhost.";
    }
    if (
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^192\.168\./.test(host)
    ) {
      return "standards_url must not point to a private network address.";
    }
    if (/^169\.254\./.test(host)) {
      return "standards_url must not point to a link-local address.";
    }
    if (host === "metadata.google.internal") {
      return "standards_url must not point to a cloud metadata endpoint.";
    }
    return null; // valid
  } catch {
    return "standards_url is not a valid URL.";
  }
}

// --- Internal helpers (not exported) ---

/** Validate an unbracketed IPv6 address extracted from a URL hostname. */
function validateIpv6Host(ipv6: string): string | null {
  // Loopback
  if (ipv6 === "::1") {
    return "standards_url must not point to localhost.";
  }
  // Link-local (fe80::/10)
  if (ipv6.startsWith("fe80")) {
    return "standards_url must not point to a link-local address.";
  }
  // Unique Local Address (fc00::/7 — fc00:: through fdff::)
  if (/^f[cd]/.test(ipv6)) {
    return "standards_url must not point to a private network address.";
  }
  // IPv4-mapped IPv6 (::ffff:XXXX:XXXX) — bun normalizes to hex form
  if (ipv6.startsWith("::ffff:")) {
    const octets = extractMappedIpv4Octets(ipv6.slice(7));
    if (octets) return validateIpv4Octets(...octets);
  }
  return null;
}

/** Parse hex-form mapped IPv4 (e.g. "7f00:1" → [127, 0, 0, 1]). */
function extractMappedIpv4Octets(
  hex: string,
): [number, number, number, number] | null {
  const parts = hex.split(":");
  if (parts.length !== 2) return null;
  const hi = parseInt(parts[0], 16);
  const lo = parseInt(parts[1], 16);
  if (isNaN(hi) || isNaN(lo)) return null;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

/** Check IPv4 octets against loopback, private, and link-local ranges. */
function validateIpv4Octets(
  a: number,
  b: number,
  c: number,
  d: number,
): string | null {
  // Loopback (127.0.0.0/8) and 0.0.0.0
  if (a === 127 || (a === 0 && b === 0 && c === 0 && d === 0)) {
    return "standards_url must not point to localhost.";
  }
  // Private ranges (10/8, 172.16/12, 192.168/16)
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  ) {
    return "standards_url must not point to a private network address.";
  }
  // Link-local (169.254/16)
  if (a === 169 && b === 254) {
    return "standards_url must not point to a link-local address.";
  }
  return null;
}

export function resolveStandardsUrl(
  globalConfig: VcpGlobalConfig | null,
  projectConfig: VcpConfig | null,
): string | null {
  const url = projectConfig?.standards_url ?? globalConfig?.standards_url ?? null;
  if (!url) return null;
  const error = validateStandardsUrl(url);
  if (error) return null; // invalid URL treated as not set
  return url;
}

export function resolvePluginRoot(
  globalConfig: VcpGlobalConfig | null,
  projectConfig: VcpConfig | null,
): string | null {
  if (projectConfig?.pluginRoot) return projectConfig.pluginRoot;
  if (globalConfig?.pluginRoot) return globalConfig.pluginRoot;
  return null;
}

export function mergeIgnoreArrays(
  globalIgnore: string[],
  projectIgnore: string[],
): string[] {
  return [...new Set([...globalIgnore, ...projectIgnore])];
}

export function applyGlobalDefaults(
  globalConfig: VcpGlobalConfig | null,
  projectConfig: VcpConfig,
): VcpConfig {
  if (!globalConfig?.defaults) return { ...projectConfig };

  const defaults = globalConfig.defaults;
  return {
    ...projectConfig,
    severity: projectConfig.severity ?? defaults.severity,
    scopes: projectConfig.scopes,
    compliance: projectConfig.compliance,
    ignore: mergeIgnoreArrays(
      defaults.ignore ?? [],
      projectConfig.ignore ?? [],
    ),
  };
}
