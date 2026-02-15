---
name: vcp-quality-check
description: >
  Check code quality against VCP architecture and code quality standards.
  Run this to find SRP violations, duplication, dead code, and naming issues.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash, WebFetch
argument-hint: "[path]"
---

# VCP Quality Check

Scan target code against VCP code quality and architecture standards.

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
- `id` is `core-code-quality`, OR
- `id` is `core-architecture`, OR
- `id` ends with `-structure` (scope-specific structure standards like `web-frontend-structure`, `web-backend-structure`)

For each selected standard, use WebFetch to fetch its content from:
```
{standardsBaseUrl}{entry.path}
```

Extract the **Rules** section from each fetched standard.

## Step 4: Scan Target Code

**Target path:** `$ARGUMENTS` if provided. If not provided, ask the user which path to scan.

1. Use Glob to find code files in the target path (exclude patterns from `exclude` in the resolved config).
2. Use Read and Grep to examine the code files.
3. Check for these specific issues using the loaded standard rules:
   - **SRP violations** — files or functions doing too many unrelated things
   - **Code duplication** — similar logic repeated in multiple places
   - **Dead code** — unused functions, unreachable branches, commented-out code
   - **Naming inconsistency** — mixed conventions (camelCase vs snake_case in same file)
   - **Layer boundary violations** — direct database calls from route handlers, business logic in UI components
4. For each violation, note the standard, rule number, file:line, issue, and fix.

## Step 5: Report Findings

Output findings grouped by severity (high first, then medium). Only include findings at or above the `severity` threshold from the resolved config.

Before outputting findings, remove any that match an entry in the `ignoredRules` array from the resolved config. If `"standard-id/rule-N"` is in the list, suppress that specific rule's findings. (Standard-level ignores are already applied by the config resolution script.) After filtering, if any findings were suppressed, append a line: `**Suppressed:** X finding(s) by ignore config.`

Use this format:

```
### VCP Quality Check

**Scopes:** core, web-frontend
**Standards loaded:** N standards, M rules checked

#### High

- **[core-architecture] Rule 2** — Layer boundary violation
  - **File:** src/routes/users.ts:25
  - **Issue:** Direct database query in route handler bypasses service layer
  - **Fix:** Move query to a service function and call it from the route

#### Medium

...

**Summary:** X high, Y medium findings.
```

If no findings: **"No quality issues found against N rules from M standards."**
