---
name: mcp-doc-init
description: >
  Initialize documentation manifest for git-doc-mcp. Scans the project for
  documentation files (*.md, READMEs, ADRs, etc.), creates .mcp/manifest.yml
  with resource entries and search tools, and configures .mcp.json for the
  git-doc-mcp MCP server. Run this once when setting up project documentation.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
argument-hint: "[--scope all|core|<path>]"
---

# MCP Doc Initialization

This skill is a slash-command launcher. The authoritative workflow lives in the MCP Doc MCP prompt `mcp_doc_init` and resource `mcp-doc://prompts/mcp-doc-init`.

1. Fetch the MCP prompt `mcp_doc_init` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call MCP Doc MCP tool `get_prompt({ command: "mcp-doc-init", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call MCP Doc MCP tools or host-native file/shell tools. Use MCP tools for deterministic guidance when available.
4. If the MCP Doc MCP server is unavailable, stop and tell the user to enable the MCP Doc MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
