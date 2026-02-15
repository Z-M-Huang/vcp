---
name: vcp-audit
description: >
  Run a comprehensive audit against all applicable VCP standards.
  Supports full audit, compliance-specific audit, and quick release readiness check.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash, WebFetch
argument-hint: "[path] | compliance [gdpr|pci-dss|hipaa] | quick"
---

# VCP Audit

Comprehensive codebase audit against VCP standards. Supports three modes based on arguments.

## Modes

- `/vcp-audit` or `/vcp-audit [path]` — **Full audit** against all applicable standards
- `/vcp-audit compliance [gdpr|pci-dss|hipaa]` — **Compliance audit** with regulation citations
- `/vcp-audit quick` — **Release readiness** check (critical rules only, READY/NOT READY verdict)

## Step 1: Resolve Config

1. Read `.vcp.json` from the project root. Extract the `pluginRoot` field.
2. **If `.vcp.json` does not exist or `pluginRoot` is missing:** Stop and tell the user: "No VCP configuration found. Run `/vcp-init` to configure VCP for this project."
3. **Validate `pluginRoot`:** The path must be absolute, contain `/.claude/` (or `\.claude\` on Windows) as a path segment, and contain only safe path characters (letters, digits, `/`, `\`, `-`, `_`, `.`, `:`, and spaces). Reject any path with shell metacharacters (`;`, `&`, `|`, `$`, `` ` ``, `(`, `)`, `{`, `}`, `<`, `>`, `!`, `~`, `#`, `*`, `?`, `[`, `]`, `'`, `"`). If validation fails, stop and tell the user: "Invalid pluginRoot — must be within ~/.claude/ and contain no shell metacharacters. Run `/vcp-init` to fix." Also verify the file `<pluginRoot>/lib/vcp-context-core.ts` exists using Glob. If it does not exist, stop and tell the user: "pluginRoot points to an invalid VCP installation. Run `/vcp-init` to fix."
4. Run the config resolution script via Bash:
   ```bash
   bun "<pluginRoot>/lib/resolve-config.ts" "<project-root>"
   ```
5. Parse the JSON output. It contains: `standardsBaseUrl`, `applicableStandards`, `ignoredRules`, `severity`, `exclude`.

## Step 2: Fetch Applicable Standards

**Determine mode from `$ARGUMENTS`:**

- If `$ARGUMENTS` starts with `compliance` → **Compliance mode**. Extract the framework name after `compliance` (e.g., `gdpr`, `pci-dss`, `hipaa`). If no framework specified, ask the user which compliance framework to audit.
- If `$ARGUMENTS` is `quick` → **Quick mode**
- Otherwise → **Full mode** (`$ARGUMENTS` is treated as an optional path)

### Full Mode

**No tag filter** — load ALL entries from `applicableStandards`.

### Compliance Mode

Map the framework argument to standard id:
- `gdpr` → `compliance-gdpr`
- `pci-dss` → `compliance-pci-dss`
- `hipaa` → `compliance-hipaa`

Keep entries where:
- `id` matches the mapped compliance standard, OR
- `tags` array includes `"security"` (security standards are cross-referenced with compliance)

If the mapped compliance standard is not in `applicableStandards`, stop and tell the user: "Compliance framework '[name]' is not configured in .vcp.json. Run `/vcp-init` to add it."

### Quick Mode

**No tag filter** — load ALL entries from `applicableStandards`.

---

For each selected standard, use WebFetch to fetch its content from:
```
{standardsBaseUrl}{entry.path}
```

Extract the **Rules** section from each fetched standard.

## Step 4: Scan Target Code

### Full Mode

**Target path:** `$ARGUMENTS` if provided and not a mode keyword. Default: project root.

1. Use Glob to find code files in the target path (exclude patterns from `exclude` in the resolved config).
2. Work scope-by-scope: core standards first, then scope-specific standards, then compliance standards.
3. For each standard:
   a. Identify files relevant to that standard's domain.
   b. Read representative files (prioritize entry points, route handlers, data access, configuration).
   c. Check each rule from the standard against the code.
4. For each violation found, note: standard id, rule number, file:line, issue description, and fix suggestion.

### Compliance Mode

1. Use Glob to find all code files (exclude patterns from `exclude`).
2. For each rule in the compliance standard:
   a. Identify files relevant to the regulation requirement.
   b. Check compliance. Cross-reference with security standards for technical requirements (e.g., GDPR encryption requirement → check against core-security encryption rules).
3. For each finding, note: standard id, rule number, regulation reference (e.g., "GDPR Art. 32"), file:line, and status.

### Quick Mode

1. Use Glob to find code files in the project (exclude patterns from `exclude`).
2. For each standard, check ONLY rules with **critical** severity implications. Skip medium-severity rules for speed. Focus on:
   - Security vulnerabilities (injection, hardcoded secrets, missing auth)
   - Critical architecture violations (missing input validation at boundaries)
   - Critical compliance gaps (unencrypted PII, missing audit logging)
3. For each violation found, note: standard id, rule number, file:line, and brief description.

## Step 5: Report Findings

Before outputting findings, remove any that match an entry in the `ignoredRules` array from the resolved config. If `"standard-id/rule-N"` is in the list, suppress that specific rule's findings. (Standard-level ignores are already applied by the config resolution script.) After filtering, if any findings were suppressed, append a line: `**Suppressed:** X finding(s) by ignore config.` If any suppressed findings came from security-scoped standards (tag `"security"`) or compliance standards, also add: `**WARNING: Critical security findings suppressed by ignore config. Review .vcp.json ignore list.**`

### Full Mode Output

```
### VCP Audit

**Scopes:** core, web-backend, ...
**Standards loaded:** N standards, M rules checked
**Target:** [path or "project root"]

#### Standards Summary

| Standard | Status | Critical | High | Medium |
|----------|--------|----------|------|--------|
| core-security | FAIL | 2 | 1 | 0 |
| core-architecture | PASS | 0 | 0 | 0 |
| web-backend-security | WARN | 0 | 3 | 1 |
| ... | ... | ... | ... | ... |

**Overall: X critical, Y high, Z medium findings across N standards.**

#### Findings by Standard

##### core-security

- **Rule 3** (critical) — SQL string concatenation
  - **File:** src/db/queries.py:42
  - **Issue:** User input concatenated into SQL query
  - **Fix:** Use parameterized queries

...
```

Status per standard: **FAIL** = has critical findings, **WARN** = has high findings but no critical, **PASS** = no findings at or above the severity threshold.

### Compliance Mode Output

```
### VCP Compliance Audit — GDPR

**Standards loaded:** compliance-gdpr + N security standards
**Rules checked:** M rules

| Rule | Status | Regulation Ref | Finding |
|------|--------|----------------|---------|
| Rule 1 | FAIL | GDPR Art. 5(1)(f) | PII stored without encryption in users table |
| Rule 2 | PASS | GDPR Art. 17 | Data deletion endpoint exists |
| Rule 3 | WARN | GDPR Art. 32 | Encryption at rest configured but key rotation not found |
| ... | ... | ... | ... |

**Summary:** X FAIL, Y WARN, Z PASS out of M rules.
```

### Quick Mode Output

```
### VCP Release Readiness

**Standards loaded:** N standards
**Rules checked:** M critical rules (non-critical skipped)

| Standard | Verdict | Blocking Issues |
|----------|---------|-----------------|
| core-security | FAIL | 2 critical findings |
| core-architecture | PASS | — |
| web-backend-security | WARN | 1 high finding |
| ... | ... | ... |

---

**Verdict: NOT READY — 2 critical issues must be resolved before release.**
```

Verdict logic:
- **FAIL** = critical findings exist in that standard
- **WARN** = high findings exist but no critical
- **PASS** = no findings at or above the severity threshold
- Overall **READY** = no FAIL standards. Overall **NOT READY** = one or more FAIL standards.

If no findings across all standards: **"READY — No critical or high issues found across N standards."**
