---
name: vcp-init
description: >
  Initialize VCP configuration for this project. Creates global config (~/.vcp/config.json)
  if it doesn't exist, then creates project config (.vcp/config.json). Detects frameworks, scopes,
  and discovers the plugin path.
  Run this once when setting up VCP for a new project.
user-invocable: true
allowed-tools: Read, Write, Glob, Grep, Bash, WebFetch
argument-hint: "[--standards-url <url|default>] [--confirm]"
---

# VCP Init

This skill is a thin slash-command launcher. The authoritative workflow lives in the VCP MCP prompt `vcp_init` and resource `vcp://prompts/vcp-init`.

1. Fetch the MCP prompt `vcp_init` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call VCP MCP tool `get_prompt({ command: "vcp-init", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call VCP MCP tools such as `detect_installation`, `validate_plugin_root`, or `resolve_config`. Use those tools for deterministic work.
4. If the VCP MCP server is unavailable, stop and tell the user to enable the VCP MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
