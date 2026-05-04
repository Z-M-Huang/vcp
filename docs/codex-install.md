# Installing VCP on OpenAI Codex CLI

VCP v0.6.0 supports OpenAI Codex CLI v0.124.0+ alongside Claude Code. Each plugin has a `.codex-plugin/plugin.json` manifest and a plugin-local `.mcp.json` so Codex can discover skills and start the MCP servers.

## Prerequisites

- **Codex CLI v0.124.0 or newer.** Earlier plugin/MCP support is incomplete.
- **Bun runtime.** VCP hooks, workflow scripts, and plugin MCP servers run through Bun.
- **API presets** in `~/.vcp/ai-presets.json` for script-driven LLM flows such as `vcp-audit` and Dev Buddy API executors.

## Install

```bash
# Clone into Codex's plugin directory
git clone https://github.com/Z-M-Huang/vcp ~/.codex/plugins/vcp
cd ~/.codex/plugins/vcp
bun install

# Start Codex from the project you want to work on
cd /path/to/your/project
codex
```

Codex discovers plugins from `$CODEX_HOME/plugins` (`~/.codex/plugins` by default). The repo layout is:

```text
~/.codex/plugins/vcp/
├── plugins/vcp/.codex-plugin/plugin.json
├── plugins/vcp/.mcp.json
├── plugins/dev-buddy/.codex-plugin/plugin.json
├── plugins/dev-buddy/.mcp.json
├── plugins/mcp-doc/.codex-plugin/plugin.json
└── plugins/mcp-doc/.mcp.json
```

The `.codex-plugin/plugin.json` files point `mcpServers` at `.mcp.json`. Those files start plugin-local binaries such as `./mcp-server/bin/vcp-mcp`, `./mcp-server/bin/dev-buddy-mcp`, and `./mcp-server/bin/mcp-doc-mcp`.

## Verify

Inside Codex:

```text
$skills
/mcp
$vcp-init
```

If the MCP servers do not appear in `/mcp`, add the server entries manually to `~/.codex/config.toml` using absolute paths:

```toml
[mcp_servers.vcp]
command = "/home/you/.codex/plugins/vcp/plugins/vcp/mcp-server/bin/vcp-mcp"
args = []

[mcp_servers.dev-buddy]
command = "/home/you/.codex/plugins/vcp/plugins/dev-buddy/mcp-server/bin/dev-buddy-mcp"
args = []

[mcp_servers.mcp-doc]
command = "/home/you/.codex/plugins/vcp/plugins/mcp-doc/mcp-server/bin/mcp-doc-mcp"
args = []
```

Restart Codex after editing the config.

## Command Syntax

| Action | Claude Code | Codex CLI |
|---|---|---|
| Run a VCP skill | `/vcp-audit quick` | `$vcp-audit quick` |
| Run Dev Buddy | `/dev-buddy-ralph Add auth` | `$dev-buddy-ralph Add auth` |
| Run MCP Doc | `/mcp-doc-init` | `$mcp-doc-init` |
| List skills | Host UI | `$skills` |
| Inspect MCP servers | `/mcp` | `/mcp` |

## Host Differences

| Surface | Claude Code | Codex CLI |
|---|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| MCP registration | Manifest `mcpServers` block | `.codex-plugin/plugin.json` -> `.mcp.json` |
| SKILL frontmatter | Honors `user-invocable`, `allowed-tools`, `argument-hint` | Uses name/description; Claude-specific UI metadata is ignored |
| Hooks | PreToolUse, PostToolUse, SessionStart, Stop | Same hook files are shipped, but host behavior can differ; treat PostToolUse as advisory |
| Blocking | `security-gate.ts` exits 2 on PreToolUse findings | Same PreToolUse block path |
| Interactive prompts | Claude-native `AskUserQuestion` | Skills use flags, printed next steps, or MCP tools instead |
| Task/team tools | Claude-specific | Not available; use MCP tools and persisted state |
| MCP resources | Often surfaced to the model | Not guaranteed; use paired tools such as `get_prompt`, `get_run_state`, `get_stage_definition`, and `list_presets` |
| MCP prompts | Surfaced by capable hosts | If not surfaced, call `get_prompt` |

## Current Limitations

- Dev Buddy's cross-host MCP Ralph path is a state-machine skeleton in v0.6.0. `ralph_start`, `ralph_next`, `ralph_list`, and `ralph_health` work and persist state under `<project>/.vcp/ralph/<run-id>/`, but the six step handlers do not yet run LLM work. Use the legacy Claude stage-skill Ralph path for production feature builds until the MCP step ports land.
- `migration-planner.toml` is not shipped. The migration planner remains available through the Claude Code agent file.
- `vcp-audit` script execution requires API presets; subscription-only presets cannot be invoked from a TypeScript subprocess.
- MCP resources may not be injected automatically in Codex. Use the paired tools exposed by each plugin MCP server.

## Troubleshooting

- `No skill found`: confirm the repo is under `~/.codex/plugins/vcp`, then restart Codex.
- MCP server missing: run `/mcp`, then add the manual `~/.codex/config.toml` entries above if needed.
- Bun errors: run `bun install` at `~/.codex/plugins/vcp`.
- Project config missing: run `$vcp-init` from the target project root.
