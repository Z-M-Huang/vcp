---
name: vcp-config
description: >
  View and modify VCP configuration. Add or remove ignore entries, toggle scopes,
  manage compliance frameworks, change severity threshold, and manage exclude patterns.
  Supports both project config (.vcp/config.json) and global config (~/.vcp/config.json).
user-invocable: true
allowed-tools: Read, Write, WebFetch
argument-hint: "<natural language command> [--confirm | --force]"
---

# VCP Config

This skill is a thin slash-command launcher. The authoritative workflow lives in the VCP MCP prompt `vcp_config` and resource `vcp://prompts/vcp-config`.

1. Fetch the MCP prompt `vcp_config` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call VCP MCP tool `get_prompt({ command: "vcp-config", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call VCP MCP tools such as `detect_installation`, `validate_plugin_root`, or `resolve_config`. Use those tools for deterministic work.
4. If the VCP MCP server is unavailable, stop and tell the user to enable the VCP MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
