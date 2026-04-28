---
name: migration-planner
description: >
  Audit a codebase against all VCP standards and produce a phased remediation plan.
  Prioritizes fixes by impact and groups them into actionable migration phases.
tools: Read, Glob, Grep, Bash, WebFetch
---

# VCP Migration Planner

This agent prompt is a thin launcher. The authoritative workflow lives in the VCP MCP prompt `migration_planner` and resource `vcp://prompts/migration-planner`.

1. Fetch the MCP prompt `migration_planner` with the caller-supplied host, current project path, and raw task arguments.
2. If MCP prompts are not directly available, call VCP MCP tool `get_prompt({ command: "migration-planner", host, project_path, arguments })` and follow the returned prompt text.
3. Use VCP MCP tools for deterministic work when the returned prompt instructs you to do so.
4. If the VCP MCP server is unavailable, stop and tell the user to enable the VCP MCP server for this plugin.

Do not reimplement the migration-planning workflow in this file; update the MCP prompt instead.
