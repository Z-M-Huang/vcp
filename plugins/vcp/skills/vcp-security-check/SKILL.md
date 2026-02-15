---
name: vcp-security-check
description: >
  Scan code for security vulnerabilities against VCP security standards.
  Run this when reviewing code for security issues or before commits.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash, WebFetch
argument-hint: "[path]"
---

# VCP Security Check

Scan target code against VCP security standards and report findings.

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

From the `applicableStandards` array in the resolved config, keep only entries where:
- `tags` array includes `"security"`, OR
- `scope` is `"compliance"` (all compliance standards are relevant to security)

For each selected standard, use WebFetch to fetch its content from:
```
{standardsBaseUrl}{entry.path}
```

Extract the **Rules** section from each fetched standard.

## Step 4: Scan Target Code

**Target path:** `$ARGUMENTS` if provided. If not provided, ask the user which path to scan.

1. Use Glob to find code files in the target path (exclude patterns from `exclude` in the resolved config).
2. Use Read and Grep to examine the code files.
3. For each rule from each loaded standard, check if the code violates the rule.
4. For each violation found, note:
   - Which standard and rule number
   - The file path and line number
   - What the issue is
   - How to fix it

## Step 5: Report Findings

Output findings grouped by severity (critical first, then high, then medium). Only include findings at or above the `severity` threshold from the resolved config.

Before outputting findings, remove any that match an entry in the `ignoredRules` array from the resolved config. If `"standard-id/rule-N"` is in the list, suppress that specific rule's findings. (Standard-level ignores are already applied by the config resolution script.) After filtering, if any findings were suppressed, append a line: `**Suppressed:** X finding(s) by ignore config.` If any suppressed findings came from security-scoped standards (tag `"security"`) or compliance standards, also add: `**WARNING: Critical security findings suppressed by ignore config. Review .vcp.json ignore list.**`

Use this format:

```
### VCP Security Check

**Scopes:** core, web-backend
**Standards loaded:** N standards, M rules checked

#### Critical

- **[core-security] Rule 3** — SQL string concatenation
  - **File:** src/db/queries.py:42
  - **Issue:** User input concatenated into SQL query via f-string
  - **Fix:** Use parameterized query: `cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))`

#### High

...

#### Medium

...

**Summary:** X critical, Y high, Z medium findings.
```

If no findings: **"No security issues found against N rules from M standards."**
