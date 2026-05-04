---
name: vcp-coverage-gaps
description: >
  Identify untested code by mapping source files to test files.
  Finds functions without tests and tests missing edge case coverage.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash, WebFetch
argument-hint: "[path]"
---

# VCP Coverage Gaps

This skill is a thin slash-command launcher. The authoritative workflow lives in the VCP MCP prompt `vcp_coverage_gaps` and resource `vcp://prompts/vcp-coverage-gaps`.

1. Fetch the MCP prompt `vcp_coverage_gaps` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call VCP MCP tool `get_prompt({ command: "vcp-coverage-gaps", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call VCP MCP tools such as `detect_installation`, `validate_plugin_root`, or `resolve_config`. Use those tools for deterministic work.
4. If the VCP MCP server is unavailable, stop and tell the user to enable the VCP MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
