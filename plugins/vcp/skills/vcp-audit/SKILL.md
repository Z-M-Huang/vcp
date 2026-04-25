---
name: vcp-audit
description: >
  Run a comprehensive audit against all applicable VCP standards.
  Supports full audit, compliance-specific audit, and quick release readiness check.
user-invocable: true
allowed-tools: Read, Glob, Bash
argument-hint: "[path] | compliance [gdpr|pci-dss|hipaa] | quick"
---

# VCP Audit

Audit the codebase against all applicable VCP standards. Three modes:

- `/vcp-audit` or `/vcp-audit [path]` — **Full audit** with parallel per-domain scanners and 7-step validator pipeline.
- `/vcp-audit compliance [gdpr|pci-dss|hipaa]` — **Compliance audit** filtered to one regulatory framework + security standards, validator runs.
- `/vcp-audit quick` — **Release readiness** check, critical + high rules only, validator skipped for speed.

All three modes are driven by a single TypeScript orchestrator
(`scripts/audit-runner.ts`) that spawns parallel `@vcp-lib/llm-runner`
calls per domain. The behavior is identical on Claude Code and Codex
CLI — no host-specific orchestration tools required.

## Step 1: Resolve pluginRoot

1. Read `.vcp/config.json` from the project root. Extract the `pluginRoot` field.
2. **If `.vcp/config.json` does not exist or `pluginRoot` is missing:** stop and tell the user: `"No VCP configuration found. Run /vcp-init to configure VCP for this project."`
3. **Validate `pluginRoot`:** the path must be absolute, contain `/.claude/` (or `\.claude\` on Windows) as a path segment, and contain only safe characters (letters, digits, `/`, `\`, `-`, `_`, `.`, `:`, spaces). Reject any path with shell metacharacters (`;`, `&`, `|`, `$`, `` ` ``, `(`, `)`, `{`, `}`, `<`, `>`, `!`, `~`, `#`, `*`, `?`, `[`, `]`, `'`, `"`).
4. Use Glob to verify that `<pluginRoot>/scripts/audit-runner.ts` exists. If it does not, stop with `"pluginRoot points to an invalid VCP installation. Run /vcp-init to fix."`

## Step 2: Parse arguments

Inspect `$ARGUMENTS`:

| Pattern | Mode flags |
|---|---|
| `quick` | `--mode quick` |
| `compliance gdpr` (or `pci-dss`, `hipaa`) | `--mode compliance --framework <name>` |
| `compliance` (no framework) | Ask the user which framework before continuing. |
| anything else (path or empty) | `--mode full` (and `--path <value>` if `$ARGUMENTS` is non-empty) |

If the user passed an explicit path (any mode), append `--path "<path>"` to the flags.

## Step 3: Invoke

Run the script via Bash:

```bash
bun "<pluginRoot>/scripts/audit-runner.ts" <mode-flags>
```

The script emits Markdown to stdout by default — print it to the user verbatim. Pass `--format json` if a downstream tool needs the structured payload.

## Step 4: Handle errors

The script's exit code tells you what happened:

- `0` — success. Stdout is the rendered audit report. Stderr is empty.
- `1` — validation error (bad arguments, missing `.vcp/config.json`, no API preset configured, invalid model). The stderr message names the problem; relay it to the user.
- `2` — scan error (LLM call failed, network failure, validator output unparseable). Relay the stderr message; suggest re-running.

## Notes for the user

- `audit-runner.ts` uses an **API preset** from `~/.vcp/ai-presets.json`. Subscription and CLI presets are not supported by the script (subprocess constraints). Run `/vcp-config` to add an API preset if none is configured.
- Override the preset selection with `--preset <name>` and `--model <id>`.
- Domain scanners and the validator both honor a default concurrency cap of 4 LLM calls in flight; this prevents quota explosion on projects with many findings.
- Quick mode does NOT validate findings. Re-run the audit in `full` mode for confirmed results before relying on findings for release decisions.
