# Installing VCP on OpenAI Codex CLI

VCP v0.6.0+ supports both Claude Code and OpenAI Codex CLI v0.124.0+. Both hosts read the same plugin manifests; this doc walks through the Codex-side install.

## Prerequisites

- **Codex CLI v0.124.0 or newer.** The plugin/MCP support in earlier versions is incomplete.
- **Bun runtime.** Every script and the dev-buddy MCP server runs on Bun. Install via `curl -fsSL https://bun.sh/install | bash` or your platform's package manager.
- **An API preset** in `~/.vcp/ai-presets.json` if you want to use vcp-audit or any LLM-driven flow. Subscription/CLI presets work for Claude UX but can't drive scripts from Codex.

## Install

```bash
# 1. Clone or pull VCP
git clone https://github.com/Z-M-Huang/vcp ~/.codex/plugins/vcp
cd ~/.codex/plugins/vcp
bun install

# 2. Codex picks up plugins from $CODEX_HOME/plugins (default: ~/.codex/plugins).
#    Each plugin's .codex-plugin/plugin.json is auto-discovered.
codex

# 3. Inside Codex: confirm the skills are loaded
$skills          # shows vcp-audit, dev-buddy-ralph, mcp-doc-init, …
/mcp             # shows the dev-buddy MCP server as connected
```

If the dev-buddy MCP server doesn't auto-register (Phase 0.5 vertical slice proved auto-registration works, but environments vary), paste the manual config:

```bash
# Print a ready-to-use snippet
bun ~/.codex/plugins/vcp/plugins/dev-buddy/scripts/print-codex-config.ts >> ~/.codex/config.toml
```

(That script doesn't ship in v0.6.0 yet — see "Deferred items" below. Until it lands, copy the `mcpServers.dev-buddy` block from `plugins/dev-buddy/.codex-plugin/plugin.json` and convert to the TOML form Codex expects:

```toml
[mcp_servers.dev-buddy]
command = "bun"
args = ["/absolute/path/to/plugins/dev-buddy/mcp-server/src/server.ts"]
```

Replace the absolute path with your actual install dir.)

## Verify

```
$ralph-list      # invokes the dev-buddy-ralph skill which calls ralph_list
```

If you see "No Ralph runs found", the MCP server is up and the skill is reaching it. Run `$ralph-health` for diagnostics.

## Differences from Claude Code

Per Phase 0 probe outcomes documented in `docs/phase-0-report.md`:

| Surface | Claude Code | Codex CLI |
|---|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` (also reads `.claude-plugin/`) |
| SKILL.md frontmatter | `name`, `description`, `user-invocable`, `allowed-tools`, `argument-hint` all honored | `name`, `description`, `metadata.short-description` honored; the others silently ignored |
| Hooks | PreToolUse / PostToolUse / Stop / SessionStart all fire; matcher syntax: omitted/`*`/empty=all, plain names=exact, otherwise regex | Same as Claude (probe-confirmed) |
| `exit 2` blocking | Both PreToolUse and PostToolUse | PreToolUse blocks with stderr reason; PostToolUse does NOT (advisory only) |
| `AskUserQuestion` | Available | Does not exist; skills with interactive prompts fall back to CLI flags or print-and-stop patterns |
| Task / TaskCreate / Team* | Available | Do not exist; Ralph orchestration runs via the dev-buddy MCP server instead |
| MCP tools | Auto-injected into LLM context | Auto-injected as well |
| MCP resources | Auto-injected into LLM context | NOT auto-injected; reach via the paired `get_*`/`list_*` tools |
| MCP prompts (slash commands) | Available via `/prompts` | Not surfaced; tool handlers inline prompt content where needed |
| MCP elicitations | Not a concept | Available with `mcp_elicitations: true` in `~/.codex/config.toml` |

## Skill invocation syntax

| Action | Claude Code | Codex CLI |
|---|---|---|
| Run a skill | `/vcp-audit quick` | `$vcp-audit quick` |
| Restart MCP server | `/mcp restart dev-buddy` | `Restart codex` (no per-server restart command in v0.124.0) |
| List skills | (UI) | `$skills` |
| List MCP tools | `/mcp` | `/mcp` |

## Deferred items in v0.6.0

These are real gaps you may run into; tracked in `docs/migration-0.5-to-0.6.md`:

- **`print-codex-config.ts`** — the manual-install convenience script is not yet shipped. Use the manual TOML snippet above.
- **`migration-planner.toml`** — Codex sub-agent for the migration planner is not shipped. Use Claude's `migration-planner.md` for now.
- **dev-buddy MCP step handlers are skeletons** — `ralph_next` advances state correctly but doesn't call an LLM yet. Real Ralph work via MCP awaits the step LLM ports. Use the per-stage skills on Claude (`/dev-buddy-discover`, …) for production Ralph today.
- **mcp-doc `generate-runner.ts` and `sync-runner.ts`** are not implemented. Those skills still work via prose-driven flows.

## Reporting issues

If something works on Claude but not Codex (or vice versa), file an issue with: Codex CLI version (`codex --version`), Bun version (`bun --version`), the failing skill name, and the exact command you ran. Include `~/.codex/logs/` if available.
