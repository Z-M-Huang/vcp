---
name: vcp-context
description: >
  Inject VCP security and architecture standards into context.
  Run this at session start or after context compaction so the AI
  internalizes rules while writing code.
user-invocable: true
allowed-tools: Read, Glob, Bash
argument-hint: ""
---

# VCP Context

This skill is a thin slash-command launcher. The authoritative workflow lives in the VCP MCP prompt `vcp_context` and resource `vcp://prompts/vcp-context`.

1. Fetch the MCP prompt `vcp_context` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call VCP MCP tool `get_prompt({ command: "vcp-context", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call VCP MCP tools such as `detect_installation`, `validate_plugin_root`, or `resolve_config`. Use those tools for deterministic work.
4. If the VCP MCP server is unavailable, stop and tell the user to enable the VCP MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
