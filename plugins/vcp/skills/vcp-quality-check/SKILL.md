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

## Step 1: Fetch Standards Manifest

Use WebFetch to fetch:
```
https://raw.githubusercontent.com/Z-M-Huang/vcp/main/standards/manifest.json
```

Parse the JSON response. Extract the `standards_base_url` and `standards` array.

## Step 2: Load Project Context

1. Try to read `.vcp.json` from the project root.
2. **If `.vcp.json` exists:** Use its `scopes`, `compliance`, `frameworks`, `exclude`, and `severity` settings.
3. **If `.vcp.json` does not exist:** Fall back to auto-detection:
   - `core`: always active
   - `web-frontend`: active if package.json contains react/vue/angular/svelte/next, or project has .tsx/.jsx/.vue/.svelte files
   - `web-backend`: active if package.json contains express/fastify/koa/nestjs/hono, or Python deps contain django/flask/fastapi, or pom.xml/build.gradle contains spring-boot, or Gemfile contains rails
   - `database`: active if prisma/schema.prisma, alembic.ini, knexfile.*, ormconfig.* exist, or migrations/ directory exists, or .sql files exist
   - `compliance`: **not active** without `.vcp.json`
   - Tell the user: "No .vcp.json found. Run `/vcp-init` to configure VCP for this project."
4. Build exclude list: always exclude `node_modules/**`, `.git/**`, plus any patterns from `.vcp.json` `exclude` field.
5. Note the severity threshold (default: `"medium"`).
6. Extract the `ignore` array (default: `[]`). Entries matching a standard ID (e.g., `"core-architecture"`) suppress all findings from that standard. Entries in `"standard-id/rule-N"` format (e.g., `"core-security/rule-3"`) suppress that specific rule.

## Step 3: Fetch Applicable Standards

From the manifest `standards` array, select entries where:
- `applies` is `"always"` (core standards), OR
- `applies` matches an active scope from Step 2

**Filter for this skill:** Keep only standards where:
- `id` is `core-code-quality`, OR
- `id` is `core-architecture`, OR
- `id` ends with `-structure` (scope-specific structure standards like `web-frontend-structure`, `web-backend-structure`)

For each selected standard, use WebFetch to fetch its content from:
```
{standards_base_url}{entry.path}
```

Extract the **Rules** section from each fetched standard.

## Step 4: Scan Target Code

**Target path:** `$ARGUMENTS` if provided. If not provided, ask the user which path to scan.

1. Use Glob to find code files in the target path (exclude patterns from Step 2).
2. Use Read and Grep to examine the code files.
3. Check for these specific issues using the loaded standard rules:
   - **SRP violations** — files or functions doing too many unrelated things
   - **Code duplication** — similar logic repeated in multiple places
   - **Dead code** — unused functions, unreachable branches, commented-out code
   - **Naming inconsistency** — mixed conventions (camelCase vs snake_case in same file)
   - **Layer boundary violations** — direct database calls from route handlers, business logic in UI components
4. For each violation, note the standard, rule number, file:line, issue, and fix.

## Step 5: Report Findings

Output findings grouped by severity (high first, then medium). Only include findings at or above the severity threshold from Step 2.

Before outputting findings, remove any that match an entry in the `ignore` list. If a finding's standard ID is in the list, suppress it entirely. If `"standard-id/rule-N"` is in the list, suppress only that rule from that standard. After filtering, if any findings were suppressed, append a line: `**Suppressed:** X finding(s) by ignore config.`

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
