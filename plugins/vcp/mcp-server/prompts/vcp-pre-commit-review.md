# VCP Pre-Commit Review

Review all staged or changed files against applicable VCP standards and produce a commit verdict.

## Changed Files

!`{ git diff --cached --name-only --diff-filter=d; git diff --name-only --diff-filter=d; git ls-files --others --exclude-standard; } | sort -u`

## Step 1: Resolve Config

1. Resolve the project root to an absolute path.
2. Call `resolve_config({ project_path: "<project-root>" })`.
3. If the tool reports missing or invalid config, stop and tell the user: "No VCP configuration found. Run `/vcp-init` to configure VCP for this project."
4. Use the structured result. It contains: `applicableStandards`, `ignoredRules`, `severity`, `exclude`.

## Step 2: Fetch Applicable Standards

**No tag filter for this skill** — load ALL entries from `applicableStandards`.

For each standard, use WebFetch to fetch its content from:
```
{entry.url}
```

Extract the **Rules** section from each fetched standard.

## Step 4: Review Changed Files

Only review the files listed in the "Changed Files" section above. Skip files that match `exclude` patterns from the resolved config.

For each changed file:
1. Read the file content.
2. Check it against ALL rules from ALL loaded standards that are relevant to that file type.
3. Note any violations with standard ID, rule number, and line number.

## Step 5: Produce Verdict

Output findings grouped per file, then by severity. Only include findings at or above the `severity` threshold from the resolved config.

Before outputting findings, remove any that match an entry in the `ignoredRules` array from the resolved config. If `"standard-id/rule-N"` is in the list, suppress that specific rule's findings. (Standard-level ignores are already applied by the config resolution script.) After filtering, if any findings were suppressed, append a line: `**Suppressed:** X finding(s) by ignore config.` If any suppressed findings came from security-scoped standards (tag `"security"`) or compliance standards, also add: `**WARNING: Critical security findings suppressed by ignore config. Review .vcp/config.json ignore list.**`

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
