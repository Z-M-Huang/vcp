---
name: dev-buddy-ralph
description: Drive a Ralph run end-to-end through the dev-buddy MCP server.
user-invocable: true
allowed-tools: Read, Bash
argument-hint: "<feature description>"
---

# Dev Buddy Ralph

This skill is a slash-command launcher. The authoritative workflow lives in the Dev Buddy MCP prompt `dev_buddy_ralph` and resource `dev-buddy://prompts/dev-buddy-ralph`.

1. Fetch the MCP prompt `dev_buddy_ralph` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call Dev Buddy MCP tool `get_prompt({ command: "dev-buddy-ralph", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call Dev Buddy MCP tools such as `ralph_start`, `ralph_next`, `get_run_state`, `get_stage_definition`, `list_presets`. Use those tools for deterministic work.
4. If the Dev Buddy MCP server is unavailable, stop and tell the user to enable the Dev Buddy MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
