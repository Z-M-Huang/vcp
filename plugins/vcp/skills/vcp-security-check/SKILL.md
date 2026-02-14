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
   - `compliance`: **not active** without `.vcp.json` (compliance requires explicit declaration)
   - Tell the user: "No .vcp.json found. Run `/vcp-init` to configure VCP for this project."
4. Build exclude list: always exclude `node_modules/**`, `.git/**`, plus any patterns from `.vcp.json` `exclude` field.
5. Note the severity threshold (default: `"medium"`).

## Step 3: Fetch Applicable Standards

From the manifest `standards` array, select entries where:
- `applies` is `"always"` (core standards), OR
- `applies` matches an active scope from Step 2, OR
- `applies` matches `"compliance:X"` where X is in the active `compliance` array

**Filter for this skill:** Keep only standards where `tags` array includes `"security"`. Also keep ALL compliance-scoped standards regardless of tags.

For each selected standard, use WebFetch to fetch its content from:
```
{standards_base_url}{entry.path}
```

Extract the **Rules** section from each fetched standard.

## Step 4: Scan Target Code

**Target path:** `$ARGUMENTS` if provided. If not provided, ask the user which path to scan.

1. Use Glob to find code files in the target path (exclude patterns from Step 2).
2. Use Read and Grep to examine the code files.
3. For each rule from each loaded standard, check if the code violates the rule.
4. For each violation found, note:
   - Which standard and rule number
   - The file path and line number
   - What the issue is
   - How to fix it

## Step 5: Report Findings

Output findings grouped by severity (critical first, then high, then medium). Only include findings at or above the severity threshold from Step 2.

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
