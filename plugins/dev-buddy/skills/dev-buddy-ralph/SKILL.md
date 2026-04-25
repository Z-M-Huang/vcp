---
name: dev-buddy-ralph
description: Drive a Ralph run end-to-end through the dev-buddy MCP server. Works on Claude Code and Codex CLI.
user-invocable: true
allowed-tools: Read, Bash
argument-hint: "<feature description>"
---

# Dev Buddy Ralph

Drives the Ralph workflow (discover → requirements → decompose → build → code-review → uat) via the dev-buddy MCP server. Replaces the v0.5.x agentic orchestration that depended on Claude-only Task/Team primitives.

## Usage

```
/dev-buddy-ralph <feature description>
```

## Step 1: Resolve project path

Run `pwd` to get the absolute project path. The MCP server requires an
absolute path so that `<project_path>/.vcp/ralph/<run_id>/` is unambiguous.

## Step 2: Start the run

Call the dev-buddy MCP tool `ralph_start`:

- `project_path`: the absolute path from Step 1.
- `goal`: `$ARGUMENTS` (the feature description).

The response includes `run_id`. Save it for the rest of the workflow.

If `mcp__dev_buddy__ralph_start` is not available as a callable tool, the dev-buddy MCP server is not running. On Claude Code: invoke `/mcp restart dev-buddy` and retry. On Codex CLI: confirm `mcpServers.dev-buddy` is registered (paste the server config from `plugins/dev-buddy/.codex-plugin/plugin.json` into `~/.codex/config.toml` if needed).

## Step 3: Advance one step at a time

Call `ralph_next(project_path, run_id)` in a loop. After each call:

1. Print the step name and the `summary` field to the user.
2. If the response shows `status: failed`, stop and surface the `reason`.
3. If `status: complete` or `next_step: null`, stop — the run is done.
4. Otherwise, call `ralph_next` again with the same `run_id`.

Keep the loop tight; let `ralph_next` do the work. Do not insert manual orchestration between steps — the server handles step ordering, lease acquisition, state commits, and lease release.

## Step 4: Inspect at any point

- `ralph_list(project_path)` — lists every run in the project, newest first.
- `get_run_state(project_path, run_id)` — full state.json for one run.
- `ralph_health(project_path)` — server uptime + active-run summary + lease holders.

## v0.6.0 note

The dev-buddy MCP server's six step handlers are SKELETONS in this build. They thread state correctly through the dispatcher (lease acquired, state.step advances on each call, status flips to `complete` after `uat`) but they do NOT yet make LLM calls. Each step's `summary` includes `LLM port pending` until the corresponding follow-up commit lands.

If you need the legacy v0.5.x Ralph workflow with real LLM agents in the loop, run the per-stage skills (`/dev-buddy-discover`, `/dev-buddy-requirements`, `/dev-buddy-decompose`, `/dev-buddy-build`, `/dev-buddy-code-review`, `/dev-buddy-uat`) directly. Those skills still spawn Claude subagents via `Task` and only work on Claude Code; they will be retired in the same follow-up that lands the MCP step LLM ports.
