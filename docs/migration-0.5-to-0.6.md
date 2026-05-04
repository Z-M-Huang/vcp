# Migrating from VCP v0.5.x to v0.6.0

v0.6.0 is a host-alignment and runtime refactor. Claude Code behavior remains compatible for the existing workflows, while the repo now also ships Codex CLI plugin manifests, plugin-local MCP server configs, shared workspace libraries, and a cross-host Dev Buddy MCP skeleton.

## Upgrade

```bash
# In your VCP checkout or plugin install
git pull
bun install

# In each project that uses VCP
/vcp-init      # Claude Code
# or
$vcp-init      # Codex CLI
```

`/vcp-init` / `$vcp-init` refreshes `pluginRoot`, creates `~/.vcp/config.json` when missing, and preserves existing project settings.

## What Changed

### 1. Claude Code and Codex CLI Manifests

Each plugin now ships both host manifests:

```text
plugins/<name>/.claude-plugin/plugin.json
plugins/<name>/.codex-plugin/plugin.json
plugins/<name>/.mcp.json
```

Claude Code installs from the marketplace (`/plugin install vcp@vcp`). Codex installs by cloning the repo under `~/.codex/plugins/vcp`; Codex discovers `.codex-plugin/plugin.json`, which points MCP registration at `.mcp.json`.

### 2. Shared Workspace Packages

The repo is now a Bun workspace:

```json
{ "workspaces": ["lib/*", "plugins/*"] }
```

| Package | Purpose | Replaces |
|---|---|---|
| `@vcp-lib/logging` | Shared diagnostic logger with rotation and payload caps | ad hoc plugin loggers |
| `@vcp-lib/runtime-adapter` | Host-neutral project-root resolution | inline `CLAUDE_PROJECT_DIR || cwd` fallbacks |
| `@vcp-lib/config` | Global/project config parsing and merging | VCP config helpers in `plugins/vcp/lib` |
| `@vcp-lib/context-core` | Standards manifest fetch, rule extraction, context formatting | VCP context helpers |
| `@vcp-lib/llm-runner` | Preset types, preset I/O, API/CLI runner utilities | Dev Buddy preset and runner helpers |
| `@vcp-lib/prompt-assets` | Stage definitions and system-prompt loading | Dev Buddy prompt loaders |

Legacy import paths are kept as shims where downstream scripts still reference them.

### 3. VCP MCP Server

The VCP plugin now exposes workflow prompts, resources, and deterministic tools through `plugins/vcp/mcp-server/`.

Important tools:
- `get_prompt` and `list_prompts`
- `detect_installation`
- `validate_plugin_root`
- `resolve_config`

The `SKILL.md` files are intentionally thin launchers. Host-specific behavior belongs in MCP prompts/tools rather than duplicated slash-command prose.

### 4. Dev Buddy v5 Runtime

Dev Buddy is now 11 skills, 8 stage definition files, 7 role prompts, and 0 hooks.

The v5 config lives at `~/.vcp/dev-buddy.json` and auto-migrates from v2/v3/v4. The active Ralph pipeline contains six stages:

```text
discovery -> ralph-requirements -> decomposition -> ralph-build -> ralph-code-review -> ralph-uat
```

Additional stage definitions:
- `plan-lint` validates decomposed unit tests and backpressure commands before build attempts are consumed.
- `unit-review` is optional and disabled by default; when configured it runs per-unit semantic review after mechanical pass.

The build loop is now split by responsibility:
- `stage-runner.ts` dispatches configured executors and synthesizes outputs.
- `build-loop-runner.ts` owns subprocess I/O, backpressure, contract verification, and JSON event streaming.
- `ralph/build-actions.ts` owns build-stage state transitions through `composeBuildDispatch`, `recordAttemptResultAction`, and `recordReviewResultAction`.
- `ralph/unit-state.ts` owns low-level persisted JSON writes.

Dynamic per-unit state is persisted under:

```text
<project>/.vcp/plan/.state/ralph-{slug}/
├── plan.json
├── units/unit-N.json
└── progress/stage-progress-*.json
```

`unit-N.md` files are immutable after decompose. Mechanical failure context and review feedback survive process restarts through `unit-N.json`.

### 5. Dev Buddy MCP Skeleton

The Dev Buddy MCP server exposes cross-host Ralph tools:

- `ralph_start(project_path, goal)`
- `ralph_next(project_path, run_id)`
- `ralph_list(project_path)`
- `ralph_health(project_path?)`
- `get_run_state`, `get_stage_definition`, `list_presets`

The MCP run state lives under:

```text
<project>/.vcp/ralph/<run-id>/
├── state.json
├── lease.json
├── events.jsonl
└── subprocess-stderr/
```

In v0.6.0 the six MCP step handlers (`discover`, `requirements`, `decompose`, `build`, `code-review`, `uat`) are skeletons. They exercise state, locking, lease, prompt/resource/tool registration, and host reachability, but do not yet perform LLM-driven work. For production Ralph feature work, use the legacy Claude stage-skill path (`/dev-buddy-ralph` and stage skills) until the MCP LLM ports land.

### 6. AGENTS.md

`AGENTS.md` sits beside `CLAUDE.md` for Codex CLI. Keep both files in sync when changing repo guidance.

## Removed or Renamed Surfaces

- Dev Buddy hooks remain removed. `plugins/dev-buddy/hooks/hooks.json` is intentionally empty.
- Retired Dev Buddy hook files should not appear in forward-facing docs except migration history.
- Old v3 feature and bugfix pipeline keys are migrated to `pipelines.ralph`.
- The old task-artifact directory is retired for Ralph. Current legacy stage-skill state uses `.vcp/plan/`; MCP skeleton runs use `.vcp/ralph/`.

## Current Limitations

- Dev Buddy MCP step handlers are skeletons in v0.6.0.
- `migration-planner.toml` is not shipped; the migration planner remains available through the Claude Code agent file.
- `vcp-audit` script execution requires API presets. Subscription presets cannot be driven from the TypeScript subprocess path.
- MCP resources may not be auto-injected in Codex. Use paired tools such as `get_prompt`, `get_run_state`, `get_stage_definition`, and `list_presets`.
- mcp-doc `generate` and `sync` workflows are still prose/tool-guided rather than fully script-driven.

## Rollback

```bash
git checkout v0.5.10
bun install
```

Project `.vcp/config.json` and global `~/.vcp/config.json` remain readable by v0.5.x. New Dev Buddy MCP skeleton state under `.vcp/ralph/` is ignored by the legacy stage-skill workflow.
