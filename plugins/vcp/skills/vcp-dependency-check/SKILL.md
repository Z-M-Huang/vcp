---
name: vcp-dependency-check
description: >
  Verify project dependencies against VCP dependency management standards.
  Checks lockfile hygiene, version ranges, package existence, and suspicious packages.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash, WebFetch
argument-hint: ""
---

# VCP Dependency Check

Verify project dependencies against the VCP dependency management standard.

## Step 1: Fetch Standards Manifest

Use WebFetch to fetch:
```
https://raw.githubusercontent.com/Z-M-Huang/vcp/main/standards/manifest.json
```

Parse the JSON response. Extract the `standards_base_url` and `standards` array.

## Step 2: Load Project Context

1. Try to read `.vcp.json` from the project root.
2. **If `.vcp.json` exists:** Use its `frameworks` to determine which package ecosystem(s) to check.
3. **If `.vcp.json` does not exist:** Auto-detect by looking for manifest files (package.json, requirements.txt, pyproject.toml, pom.xml, build.gradle, Gemfile, go.mod, Cargo.toml).
4. Tell the user if no `.vcp.json` found: "No .vcp.json found. Run `/vcp-init` to configure VCP for this project."
5. Extract the `ignore` array (default: `[]`). Entries matching a standard ID (e.g., `"core-dependency-management"`) suppress all findings from that standard. Entries in `"standard-id/rule-N"` format suppress that specific rule.

## Step 3: Fetch Applicable Standard

From the manifest, select only the entry with `id` equal to `core-dependency-management`.

Use WebFetch to fetch its content from:
```
{standards_base_url}{entry.path}
```

Extract the **Rules** section.

## Step 4: Check Dependencies

### 4a: Find Lockfiles and Manifests

Look for these files in the project root:

| Ecosystem | Manifest | Lockfile |
|-----------|----------|----------|
| npm | `package.json` | `package-lock.json` |
| yarn | `package.json` | `yarn.lock` |
| pnpm | `package.json` | `pnpm-lock.yaml` |
| pip | `requirements.txt` | (no standard lockfile) |
| pipenv | `Pipfile` | `Pipfile.lock` |
| poetry | `pyproject.toml` | `poetry.lock` |
| bundler | `Gemfile` | `Gemfile.lock` |
| go | `go.mod` | `go.sum` |
| cargo | `Cargo.toml` | `Cargo.lock` |

### 4b: Check Lockfile Committed

Use `git ls-files` to verify the lockfile is tracked in version control. Flag if missing.

### 4c: Check Version Ranges

Read the manifest file and flag wide version ranges:
- `"*"` — accepts any version
- `">="` without upper bound — no ceiling
- `""` (empty) — unconstrained
- For npm: prefer `^` (minor updates) over `>=` or `*`

### 4d: Verify Packages Exist on Registry

For each dependency, verify it exists on the official registry:
- **npm:** `npm view {package} version` (via Bash)
- **pip:** `pip index versions {package}` (via Bash)
- **other ecosystems:** use the equivalent registry check command

Flag any package that:
- Does not exist on the registry (possible slopsquatting / hallucinated name)
- Has under 1,000 weekly downloads
- Was published within the last 30 days with no prior version history
- Has a name within edit distance 2 of a top-1000 package in the same registry (typosquatting)

### 4e: Check for Behavioral Analysis Indicators

Per the dependency management standard rule 13, note if the project uses:
- Socket.dev
- OpenSSF Scorecard
- npm provenance verification

If none are configured, recommend adding at least one.

## Step 5: Report Findings

Before outputting findings, remove any that match an entry in the `ignore` list. If a finding's standard ID is in the list, suppress it entirely. If `"standard-id/rule-N"` is in the list, suppress only that rule from that standard. After filtering, if any findings were suppressed, append a line: `**Suppressed:** X finding(s) by ignore config.`

Use this format:

```
### VCP Dependency Check

**Ecosystem:** npm (package.json)
**Standard:** core-dependency-management (13 rules)

#### Lockfile Status
- package-lock.json: committed

#### Wide Version Ranges
- `lodash: "*"` — should be pinned to `^4.17.21`
- `express: ">=4"` — should use `^4.18.0`

#### Unverified Packages
- `my-cool-lib` — not found on npm registry (possible hallucinated package name)

#### Suspicious Packages
- `colros` — very similar to popular package `colors` (possible typosquatting)

#### Supply Chain Tools
- No behavioral analysis tools detected. Consider adding Socket.dev or OpenSSF Scorecard.

**Summary:** X issues found.
```

If no issues: **"All dependencies verified. Lockfile committed, no wide ranges, all packages exist on registry."**
