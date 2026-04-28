# VCP Audit

Audit the codebase against all applicable VCP standards. Three modes:

- `/vcp-audit` or `/vcp-audit [path]` — **Full audit** with parallel per-domain scanners and 7-step validator pipeline.
- `/vcp-audit compliance [gdpr|pci-dss|hipaa]` — **Compliance audit** filtered to one regulatory framework + security standards, validator runs.
- `/vcp-audit quick` — **Release readiness** check, critical + high rules only, validator skipped for speed.

All three modes are driven by a single TypeScript orchestrator
(`scripts/audit-runner.ts`) that spawns parallel `@vcp-lib/llm-runner`
calls per domain. The behavior is identical for all callers because
the MCP tools resolve installation and config details.

## Step 1: Resolve Config and Runtime

1. Resolve the project root to an absolute path.
2. Call `resolve_config({ project_path: "<project-root>" })`. If it reports missing or invalid config, stop and tell the user: `"No VCP configuration found. Run /vcp-init to configure VCP for this project."`
3. Call `detect_installation({ host })`. If the tool reports an invalid installation, stop and relay its error. Use the returned `pluginRoot` as the runtime root for bundled scripts in this workflow.

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
