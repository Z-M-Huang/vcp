---
name: mcp-doc-sync
description: >
  Sync the git-doc-mcp manifest with current project state. Adds new
  docs not yet indexed, removes stale entries, refreshes descriptions
  and search index, and regenerates tool actions.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
argument-hint: "[--apply | --exclude <indices>]"
---

# MCP Doc Sync

This skill is a slash-command launcher. The authoritative workflow lives in the MCP Doc MCP prompt `mcp_doc_sync` and resource `mcp-doc://prompts/mcp-doc-sync`.

1. Fetch the MCP prompt `mcp_doc_sync` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call MCP Doc MCP tool `get_prompt({ command: "mcp-doc-sync", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call MCP Doc MCP tools or host-native file/shell tools. Use MCP tools for deterministic guidance when available.
4. If the MCP Doc MCP server is unavailable, stop and tell the user to enable the MCP Doc MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
