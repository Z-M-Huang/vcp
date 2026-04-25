# Phase 0 Report: Codex CLI v0.124.0 Empirical Capability Map

**Status:** Authoritative — answers derived from Codex v0.124.0's own Rust source (queried via `codex exec`).
**Date probed:** 2026-04-24
**Codex version:** 0.124.0
**Claude Code version:** 2.1.118

## Source of truth

Rather than building a 16-plugin-variant probe matrix, we asked Codex v0.124.0 itself. Because `codex exec` runs with filesystem access, Codex searched its own source tree (`/tmp/tmp.*/codex/codex-rs/`) and reported what the code actually does. The findings match the behavior we observed when smoke-testing a minimal probe plugin afterward.

This approach saved weeks of iterative black-box probing. The raw response is preserved below.

## Findings

| Probe | Capability | Status | Impact on plan |
|---|---|---|---|
| 1 | `.codex-plugin/plugin.json` manifest loading | **YES** — Codex reads both `.codex-plugin/plugin.json` AND `.claude-plugin/plugin.json` | Dual-manifest strategy works. Ship both. |
| 2 | SKILL.md discovery | **YES** | Shared SKILL.md files across hosts. |
| 2b | SKILL.md frontmatter compatibility | **PARTIAL** — Codex honors only `name`, `description`, `metadata.short-description`. Claude-specific fields (`user-invocable`, `allowed-tools`, `argument-hint`) are ignored. | Skill files keep the Claude fields; Codex silently ignores them. No `.codex.md` siblings needed. |
| 3 | Host env vars | **NONE** — `CODEX_PLUGIN_ROOT` and `CODEX_PROJECT_DIR` do NOT exist. | Runtime-adapter resolves plugin root from the running file's own path (e.g., `import.meta.url`); project dir falls back to `process.cwd()`. |
| 4 | PreToolUse hook | **YES** | Ship `hooks.json` as-is for both hosts. |
| 4b | PostToolUse hook | **YES** | Same. |
| 4c | Stop hook | **YES** | Same. |
| 4d | SessionStart hook | **YES** | Same. |
| 4e | Hook matcher syntax | **Compatible** — omitted/`*`/empty matches all; plain tool names or `\|` alternatives = exact; otherwise regex; `mcp__server__tool` supported | Existing `matcher: "Write\|Edit\|MultiEdit"` patterns work unchanged. |
| 5 | exit-2 blocking | **PreToolUse: YES** with stderr reason; **PostToolUse: NO** | security-gate (PreToolUse) blocks identically on both hosts. Advisory hooks on PostToolUse are logs-only everywhere (unchanged). |
| 6 | AGENTS.md auto-ingest | **YES** | Generate AGENTS.md from CLAUDE.md via pre-commit hook. Documented manual-load still offered as fallback. |
| 7 | `.codex/agents/*.toml` sub-agents | **YES** | Ship `migration-planner.toml` alongside `migration-planner.md`. |
| 8 | Session continuity | Codex sessions are cold per invocation (same as Claude skills); state-machine resume via `--resume <token>` is the correct design. | State-machine persisted prompts remain the primary UX. |
| 9 | Marketplace schema | **YES** — `.agents/plugins/marketplace.json` OR `.claude-plugin/marketplace.json` | Ship the existing `.claude-plugin/marketplace.json`; Codex reads it. |
| 10 | Plugin-declared MCP server lifecycle | **YES** — `mcpServers` in plugin manifest auto-starts | dev-buddy MCP server installs automatically on both hosts. `print-codex-config.ts` becomes documentation-only fallback. |
| 11 | MCP tool call | **YES** | Primary interface. |
| 12 | MCP resource read | **NOT auto-injected on Codex** (explicit read only). Claude auto-injects. | Tool-resource duality is mandatory — every resource has a paired `get_*` tool. |
| 13 | MCP prompt registration as slash commands | **Claude: YES. Codex: NO** (`/prompts` does not surface them) | Prompts register for Claude UX. On Codex, tool handlers inline prompt content from `@vcp-lib/prompt-assets`. |
| 14 | MCP elicitation (mid-tool user Q&A) | **YES** on Codex | Optional convenience for Codex interactive branches. State-machine remains primary for durability. |
| 15 | Hooks observe MCP tool calls | **YES** | security-gate can inspect dev-buddy MCP tool arguments on both hosts. |
| 16 | MCP server lifecycle / crash recovery | **Auto-start by host** confirmed. Crash-recovery semantics untested at host level — handled by plan's atomic state writes + lazy load. | No plan change. |

## Net effect on the plan

**Almost every "If NO" fallback branch can be dropped.** The plan was written defensively; the reality is much simpler:

| Plan construct | Previous assumption | Revised given probe results |
|---|---|---|
| `.codex-plugin/plugin.json?` conditional flag | Only if probe 1 = YES | **Unconditional** — ship for every plugin. |
| `hooks.codex.json?` | Only if probes 4+5 YES | **Not needed** — ship single `hooks.json` for both hosts. |
| `migration-planner.toml?` | Only if probe 7 YES | **Unconditional** — ship alongside the `.md`. |
| `AGENTS.md?` | Only if probe 6 YES | **Unconditional** — ship, generated from CLAUDE.md. |
| `.codex-plugin/marketplace.json?` | Only if probe 9 YES | **Use existing `.claude-plugin/marketplace.json`**; Codex reads it. |
| `${PLUGIN_ROOT_ENV_VAR}` template substitution | Fictional mechanism | **Still fictional.** Runtime-adapter resolves plugin root from `import.meta.url` or `new URL(".", import.meta.url)`. No env var. |
| `print-codex-config.ts` | Primary install path for Codex | **Fallback only** — plugin-declared MCP auto-installs. Keep the script for users who prefer manual config or install outside plugin marketplace. |
| Per-host skill dirs | If probe 2 NO | **Not needed** — single shared SKILL.md works. |
| SKILL.md `user-invocable`, `allowed-tools`, `argument-hint` | Assumed Codex honored them | **Codex ignores; Claude uses**. No behavior change — Codex treats every SKILL.md as invocable; `allowed-tools` is Claude-only; `argument-hint` is Claude-only UI. |

## Remaining unknowns (verify in Phase 0.5)

- Exact MCP tool result size limit on Codex (for risk 26) — verified in 0.5 vertical slice.
- Server crash/recovery UX end-to-end on each host — verified in 0.5.
- stdio framing robustness under real subprocess fanout — verified in 0.5.
- `proper-lockfile` cross-platform behavior — verified in 0.5 on the dev machine.

## Raw response from Codex v0.124.0 (preserved for audit)

```json
{
  "plugin_manifest_path": ".codex-plugin/plugin.json or .claude-plugin/plugin.json",
  "skill_md_discovery": "YES",
  "skill_frontmatter_fields": "name, description, metadata.short-description",
  "hook_pre_tool_use": "YES",
  "hook_post_tool_use": "YES",
  "hook_stop": "YES",
  "hook_session_start": "YES",
  "hook_exit2_block": "PreToolUse: YES with stderr reason; PostToolUse: NO",
  "hook_matcher_syntax": "omitted/*/empty = all; plain tool names and | alternatives = exact; otherwise regex; MCP names like mcp__server__tool",
  "agents_toml": "YES",
  "agents_md_auto_ingest": "YES",
  "mcp_tools": "YES",
  "mcp_resources_auto_inject": "NO",
  "mcp_prompts_slash_commands": "NO",
  "mcp_elicitations": "YES",
  "hook_observes_mcp": "YES",
  "plugin_mcp_server_lifecycle": "YES",
  "env_var_plugin_root": "NONE",
  "env_var_project_dir": "NONE",
  "marketplace_schema": ".agents/plugins/marketplace.json or .claude-plugin/marketplace.json"
}
```

Probed via `codex exec --dangerously-bypass-approvals-and-sandbox` on 2026-04-24 using Codex v0.124.0 on Linux (WSL2, kernel 6.6.87.2).
