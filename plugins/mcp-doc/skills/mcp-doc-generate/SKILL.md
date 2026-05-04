---
name: mcp-doc-generate
description: >
  Generate AI-written documentation for a specific directory or all
  undocumented directories. Creates structured READMEs optimized for
  both human and AI consumption, and updates the manifest.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
argument-hint: "<path> | all [--apply | --select <indices> | --skip]"
---

# MCP Doc Generate

This skill is a slash-command launcher. The authoritative workflow lives in the MCP Doc MCP prompt `mcp_doc_generate` and resource `mcp-doc://prompts/mcp-doc-generate`.

1. Fetch the MCP prompt `mcp_doc_generate` with the caller-supplied host, current project path, and raw command arguments.
2. If MCP prompts are not directly available, call MCP Doc MCP tool `get_prompt({ command: "mcp-doc-generate", host, project_path, arguments })` and follow the returned prompt text.
3. The returned prompt may instruct you to call MCP Doc MCP tools or host-native file/shell tools. Use MCP tools for deterministic guidance when available.
4. If the MCP Doc MCP server is unavailable, stop and tell the user to enable the MCP Doc MCP server for this plugin.

Do not reimplement the workflow in this file; update the MCP prompt instead.
