---
name: vcp-root-cause-check
description: >
  Analyze a proposed bug fix against VCP root cause analysis standards.
  Determines whether a fix addresses the root cause or just patches a symptom.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash, WebFetch
argument-hint: "[bug description or file path]"
---

# VCP Root Cause Check

This skill is a thin slash-command launcher. The authoritative workflow lives in the VCP MCP prompt `vcp_root_cause_check` and resource `vcp://prompts/vcp-root-cause-check`.

1. Fetch the MCP prompt `vcp_root_cause_check` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call VCP MCP tool `get_prompt({ command: "vcp-root-cause-check", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call VCP MCP tools such as `detect_installation`, `validate_plugin_root`, or `resolve_config`. Use those tools for deterministic work.
4. If the VCP MCP server is unavailable, stop and tell the user to enable the VCP MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
