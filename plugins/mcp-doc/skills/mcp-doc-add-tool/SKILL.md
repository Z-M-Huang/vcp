---
name: mcp-doc-add-tool
description: >
  Create a custom MCP tool for the documentation manifest. Guides the user
  through defining the tool's purpose, generating an action script with
  embedded data, computing the hash, and adding it to the manifest.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
argument-hint: "[--name <id>] [--purpose <text>] [--apply]"
---

# MCP Doc Add Tool

This skill is a slash-command launcher. The authoritative workflow lives in the MCP Doc MCP prompt `mcp_doc_add_tool` and resource `mcp-doc://prompts/mcp-doc-add-tool`.

1. Fetch the MCP prompt `mcp_doc_add_tool` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call MCP Doc MCP tool `get_prompt({ command: "mcp-doc-add-tool", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call MCP Doc MCP tools or host-native file/shell tools. Use MCP tools for deterministic guidance when available.
4. If the MCP Doc MCP server is unavailable, stop and tell the user to enable the MCP Doc MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
