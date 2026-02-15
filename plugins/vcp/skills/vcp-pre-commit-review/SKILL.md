---
name: vcp-pre-commit-review
description: >
  Review staged/changed files against all applicable VCP standards before committing.
  Produces a PASS/BLOCK verdict. Run this before every commit.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash, WebFetch
argument-hint: ""
---

# VCP Pre-Commit Review

Review all staged or changed files against applicable VCP standards and produce a commit verdict.

## Changed Files

!`{ git diff --cached --name-only --diff-filter=d; git diff --name-only --diff-filter=d; git ls-files --others --exclude-standard; } | sort -u`

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
- `applies` matches an active scope from Step 2, OR
- `applies` matches `"compliance:X"` where X is in the active `compliance` array

**No tag filter for this skill** — load ALL applicable standards.

For each selected standard, use WebFetch to fetch its content from:
```
{standards_base_url}{entry.path}
```

Extract the **Rules** section from each fetched standard.

## Step 4: Review Changed Files

Only review the files listed in the "Changed Files" section above. Skip files that match exclude patterns from Step 2.

For each changed file:
1. Read the file content.
2. Check it against ALL rules from ALL loaded standards that are relevant to that file type.
3. Note any violations with standard ID, rule number, and line number.

## Step 5: Produce Verdict

Output findings grouped per file, then by severity. Only include findings at or above the severity threshold.

Before outputting findings, remove any that match an entry in the `ignore` list. If a finding's standard ID is in the list, suppress it entirely. If `"standard-id/rule-N"` is in the list, suppress only that rule from that standard. After filtering, if any findings were suppressed, append a line: `**Suppressed:** X finding(s) by ignore config.` If any suppressed findings came from security-scoped standards (tag `"security"`) or compliance standards, also add: `**WARNING: Critical security findings suppressed by ignore config. Review .vcp.json ignore list.**`

Use this format:

```
### VCP Pre-Commit Review

**Scopes:** core, web-backend
**Standards loaded:** N standards, M rules checked
**Files reviewed:** X files

#### src/routes/users.ts
- **[core-security] Rule 3** — SQL string concatenation at line 42
- **[web-backend-security] Rule 7** — Missing authorization check at line 15

#### src/utils/helpers.ts
- No issues found.

---

**Verdict: BLOCK — 2 issues must be fixed**
```

Or if clean:

```
### VCP Pre-Commit Review

**Files reviewed:** X files
**Standards loaded:** N standards

All files pass. No issues found.

**Verdict: PASS — safe to commit**
```

The verdict is:
- **PASS** — zero findings at or above the severity threshold
- **BLOCK** — one or more findings at or above the severity threshold. List all blocking issues.
