---
name: vcp-audit
description: >
  Run a comprehensive audit against all applicable VCP standards.
  Supports full audit, compliance-specific audit, and quick release readiness check.
user-invocable: true
allowed-tools: Read, Glob, Bash
argument-hint: "[path] | compliance [gdpr|pci-dss|hipaa] | quick"
---

# VCP Audit

This skill is a thin slash-command launcher. The authoritative workflow lives in the VCP MCP prompt `vcp_audit` and resource `vcp://prompts/vcp-audit`.

1. Fetch the MCP prompt `vcp_audit` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call VCP MCP tool `get_prompt({ command: "vcp-audit", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call VCP MCP tools such as `detect_installation`, `validate_plugin_root`, or `resolve_config`. Use those tools for deterministic work.
4. If the VCP MCP server is unavailable, stop and tell the user to enable the VCP MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
