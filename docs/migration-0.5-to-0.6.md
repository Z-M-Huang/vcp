# Migrating from VCP v0.5.x to v0.6.0

v0.6.0 is a breaking refactor. The user-facing capabilities are unchanged on Claude Code; the major shifts are (1) cross-host support for OpenAI Codex CLI, (2) consolidated `lib/*` workspace packages, (3) dev-buddy ships an MCP server, and (4) AGENTS.md is now generated alongside CLAUDE.md.

This guide names every break, why it changed, and what you need to do.

## TL;DR

```bash
# In your VCP install (whether ~/.claude/plugins/vcp or wherever)
git pull
bun install

# Run /vcp-init in each project that uses VCP — refreshes pluginRoot
# in .vcp/config.json and creates ~/.vcp/config.json defaults if needed.
# (No-op on projects already at v0.5.x — same config schema.)
```

## What changed in v0.6.0

### 1. Cross-host support: Claude Code AND Codex CLI

Every plugin now ships with both `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`. Codex CLI v0.124.0+ reads either form, so no extra steps to install on Codex. See `docs/codex-install.md` for the dual-install walkthrough.

Implications:
- Skills that previously used Claude-only tools (`AskUserQuestion`, `Task`/`TaskCreate`/`TeamCreate`, `SendMessage`) have either been rewritten to script-driven flows or have explicit Codex fallback prose with CLI flags.
- The runtime adapter (`@vcp-lib/runtime-adapter`) replaces the inline `process.env.CLAUDE_PROJECT_DIR || process.cwd()` pattern that was scattered across hooks. Codex has no `CODEX_PROJECT_DIR` equivalent (per Phase 0 probe 3), so the adapter falls back to `process.cwd()` when unset.

### 2. Workspace packages

The repo is now a Bun workspace (`workspaces: ["lib/*", "plugins/*"]`). New shared libraries:

| Package | What moved into it | Replaces (v0.5.x location) |
|---|---|---|
| `@vcp-lib/logging` | dev-buddy's logger (fsync, payload cap, rotation) | `plugins/dev-buddy/scripts/vcp-logger.ts` AND `plugins/vcp/lib/vcp-logger.ts` (the latter was a stub; the former wins) |
| `@vcp-lib/runtime-adapter` | host-neutral path resolution | inline env fallbacks in vcp hooks |
| `@vcp-lib/config` | `./global`, `./project`, `./types` exports | `plugins/vcp/lib/global-config.ts`, `resolve-config.ts` |
| `@vcp-lib/context-core` | standards manifest fetch + rule extraction | `plugins/vcp/lib/vcp-context-core.ts` |
| `@vcp-lib/llm-runner` | `./presets`, `./types`, `./cli` exports | `plugins/dev-buddy/scripts/api-task-runner.ts`, `preset-utils.ts`, `types/presets.ts` |
| `@vcp-lib/prompt-assets` | role + stage prompt loader | `plugins/dev-buddy/scripts/system-prompts.ts`, `types/stage-definitions.ts` |

The plugins still expose all the same scripts at the same paths — those files are now thin shims that re-export from the lib. Skills, scripts, and tests that imported from the old paths continue to work without changes.

If you cloned the repo before v0.6.0, run `bun install` to wire up the new workspace packages. If you installed via the marketplace, the install path is unchanged.

### 3. dev-buddy now ships an MCP server

`plugins/dev-buddy/mcp-server/` is a new MCP server registered by `mcpServers.dev-buddy` in the plugin manifest. Both Claude Code and Codex CLI auto-start it when the plugin is loaded.

Tools exposed (see `dev-buddy-ralph/SKILL.md`):
- `ralph_start(project_path, goal)` → creates a run, returns `run_id`.
- `ralph_next(project_path, run_id)` → advances exactly one step.
- `ralph_list(project_path)` → enumerates runs.
- `ralph_health(project_path?)` → server diagnostics + lease holders.
- `get_run_state`, `get_stage_definition`, `list_presets` → Codex-friendly mirrors of the same-name MCP resources.

The MCP server's six step handlers (discover, requirements, decompose, build, code-review, uat) are SKELETONS in v0.6.0 — they thread state through the dispatcher correctly but do not yet make LLM calls. The legacy v0.5.x agentic Ralph workflow with per-stage skills (`/dev-buddy-discover`, `/dev-buddy-requirements`, …) still works on Claude Code; those skills will be retired in the same follow-up commits that land the MCP step LLM ports.

If `mcp__dev_buddy__ralph_start` shows up as "tool not found" in Claude:
1. `/mcp restart dev-buddy` and retry.
2. Confirm `bun install` ran inside the plugin tree (the MCP server depends on `@modelcontextprotocol/sdk`).

If Codex doesn't auto-register the server:
1. Check `~/.codex/config.toml` for `[mcp_servers.dev-buddy]`. If absent, paste the equivalent of `plugins/dev-buddy/.codex-plugin/plugin.json`'s `mcpServers.dev-buddy` block.
2. Restart Codex.

### 4. vcp-audit is now script-first

`plugins/vcp/scripts/audit-runner.ts` orchestrates the audit. The skill (`vcp-audit/SKILL.md`) is now a thin driver that parses arguments and invokes the script. Behavior on Claude Code is unchanged from a user's perspective; on Codex CLI the audit now works at all (it didn't before because the v0.5.x SKILL.md depended on `Team*`/`Task*`/`SendMessage`).

Constraint: the script supports **API presets only**. Subscription presets (which use Claude's Task tool under the hood) cannot be invoked from a TypeScript subprocess. If your only configured preset is `anthropic-subscription`, run `/vcp-config` to add an API preset (e.g. via Anthropic API, OpenAI API, or any OpenAI-compatible gateway).

### 5. AGENTS.md

A new `AGENTS.md` sits next to `CLAUDE.md`. Codex CLI auto-ingests it; Claude Code still uses `CLAUDE.md`. Today they have identical content. There is no symlink (Phase 0 probe 6 confirmed Codex auto-ingests a regular file, and symlinks break on Windows). Keep both in sync manually for now — `cp CLAUDE.md AGENTS.md` does the job. A future commit will add a pre-commit hook that auto-syncs.

### 6. Removed / renamed surface

- `plugins/dev-buddy/scripts/vcp-logger.ts` → moved to `@vcp-lib/logging` (the file at the old path is now a re-export shim).
- `plugins/vcp/lib/vcp-logger.ts` → deleted (was a stub; dev-buddy's implementation wins).
- `plugins/dev-buddy/scripts/__tests__/vcp-logger.test.ts` → moved to `lib/logging/__tests__/`.
- `plugins/vcp/lib/{global-config,vcp-context-core}.test.ts` → moved to `lib/{config,context-core}/__tests__/`.
- vcp hook tests (`hooks/security-context.test.ts`, …) → moved to `plugins/vcp/__tests__/`.

If you have downstream tooling that imports from the old test paths, update those references.

## Deprecations and deferred work

These are real limitations of v0.6.0 that you may run into:

1. **Dev-buddy MCP step handlers are skeletons.** Real LLM-driven Ralph runs through the MCP server are pending. Use the per-stage skills on Claude for production Ralph today.
2. **`migration-planner.toml`** is not shipped. Phase 0 confirmed Codex's `.codex/agents/*.toml` discovery works, but the exact TOML schema wasn't captured. Migration-planner remains Claude-only via `migration-planner.md`.
3. **mcp-doc `generate-runner.ts` and `sync-runner.ts`** are not implemented. The skills work via prose-driven flows on both hosts; only `scan-runner.ts` is script-first today.
4. **MCP prompts and elicitations** are not registered in v0.6.0. There are no prompts to expose because the step handlers don't yet call LLMs.
5. **AGENTS.md auto-sync** is manual via `cp` until a pre-commit hook lands.
6. **vcp-audit subscription preset support** — the script only drives API presets. Subscription presets must be invoked from inside Claude via `Task` (legacy path).

## Rolling back

If v0.6.0 breaks something for you and you need v0.5.x:

```bash
git checkout v0.5.10  # or whatever your prior tag was
bun install
```

The `~/.vcp/` config and `.vcp/config.json` files are forward-compatible — v0.5.x reads them without issue. State written by the new MCP server (`<project>/.vcp/ralph/<run-id>/`) is also compatible since the schema version field exists; v0.5.x's per-stage skills don't read it.
