/**
 * VCP Context Core Types — manifest and rule schemas used by the
 * standards extraction pipeline.
 *
 * VcpConfig itself lives in @vcp-lib/config because it is shared with
 * global-config; everything else (manifest shapes, parsed rules) is
 * context-core's concern only.
 */

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

export interface StandardRules {
  title: string;
  severity: string;
  rules: string[];
}

export interface ScopedRules {
  [scope: string]: StandardRules[];
}
