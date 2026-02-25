---
id: agentic-ai-tool-security
title: Tool Security
scope: agentic-ai
severity: critical
tags: [security, agentic-ai, mcp, tool-use, tool-vetting, allowlist, owasp-asi, asi02]
references:
  - title: "OWASP Agentic AI Security Initiative — Top 10 (Dec 2025)"
    url: https://genai.owasp.org/2025/12/09/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security/
  - title: "ASI02 — Tool Misuse & Exploitation"
    url: https://genai.owasp.org/resource/tool-misuse-and-exploitation/
  - title: "MCP Security Notifications (Invariant Labs)"
    url: https://invariantlabs.ai/mcp-security-notification
---

## Principle

Tools extend an agent's capabilities — and its attack surface. Every tool an agent can invoke is a potential vector for data exfiltration, privilege escalation, or unintended side effects. Tool access must be deny-by-default, each tool must be vetted before enablement, and all invocations must be validated and audited.

## Rules

### Tool Access Control

1. **Deny tool access by default.** Agents should have no tool access unless explicitly granted. Maintain a tool allowlist per agent or per task. Never grant blanket access to all available tools. (ASI02)

2. **Vet MCP servers and plugins before enabling.** Review each MCP server's requested permissions, data access patterns, and source reputation before adding it to an agent's configuration. Treat MCP server enablement as a security decision, not a convenience decision. (ASI02)

3. **Scope tool access to the task.** An agent performing code review needs read access to source files — not write access to the filesystem, not network access to external APIs, not access to credential stores. Grant the minimum tool set required for the specific task. (ASI02)

### Tool Call Validation

4. **Validate tool arguments against a schema.** Every tool call's arguments must be validated against the tool's declared input schema before execution. Reject calls with unexpected fields, wrong types, or out-of-range values. Never pass unvalidated agent-generated arguments directly to tool implementations. (ASI02, CWE-20)

5. **Sanitize file paths and URLs in tool arguments.** Tool arguments containing file paths must be validated against allowed directories (no path traversal). URLs must be validated against allowed domains (no SSRF). Never allow agents to construct arbitrary filesystem paths or URLs for tool calls. (ASI02, CWE-22, CWE-918)

6. **Rate-limit tool invocations.** Implement per-agent, per-tool rate limits to prevent abuse patterns — rapid file enumeration, mass API calls, or resource exhaustion. A compromised or misdirected agent should not be able to execute unbounded tool calls. (ASI02)

### Tool Installation and Updates

7. **No automatic tool installation from untrusted sources.** Agents must not install, enable, or update MCP servers, plugins, or tool packages without explicit human approval. Tool installation is a privileged operation that changes the agent's capability surface. (ASI02)

8. **Pin tool and MCP server versions.** Use specific versions for MCP servers and tool packages, not floating tags. Verify checksums or signatures when available. A supply chain attack on a tool package affects every agent that uses it. (ASI02)

### Audit and Monitoring

9. **Log all tool invocations.** Every tool call must produce an audit log entry containing: timestamp, agent identity, tool name, arguments (with secrets redacted), result status, and duration. This log enables post-incident analysis and abuse detection. (ASI02)

10. **Alert on anomalous tool usage patterns.** Monitor for tools being called with unusual frequency, at unusual times, with unusual arguments, or in unusual sequences. Anomalous tool usage may indicate agent compromise or goal hijacking. (ASI02)

## Patterns

### Do This

```json
// Tool allowlist configuration — deny by default
{
  "agent": "code-reviewer",
  "tools": {
    "allowed": ["read_file", "grep", "glob"],
    "denied": ["*"]
  }
}
```

```python
# Validate tool arguments before execution
def execute_tool(tool_name: str, args: dict) -> Any:
    schema = tool_registry.get_schema(tool_name)
    if not schema:
        raise ToolNotFoundError(f"Unknown tool: {tool_name}")

    # Validate against declared schema
    validate(args, schema)

    # Cross-platform path traversal check for file tools
    if "path" in args:
        resolved = os.path.realpath(args["path"])
        # Use os.path.commonpath for safe boundary check (works on Windows + Unix)
        try:
            os.path.commonpath([resolved, ALLOWED_BASE_DIR])
            # Verify resolved is actually inside ALLOWED_BASE_DIR
            relative = os.path.relpath(resolved, ALLOWED_BASE_DIR)
            if relative.startswith(".."):
                raise SecurityError(f"Path traversal blocked: {args['path']}")
        except ValueError:
            # On Windows, different drives have no common path
            raise SecurityError(f"Path outside allowed drive: {args['path']}")

    return tool_registry.invoke(tool_name, args)
```

```python
# Audit logging for tool invocations
def log_tool_call(agent_id: str, tool: str, args: dict, result_status: str):
    sanitized_args = redact_secrets(args)
    audit_logger.info({
        "event": "tool_invocation",
        "agent": agent_id,
        "tool": tool,
        "args": sanitized_args,
        "status": result_status,
        "timestamp": datetime.utcnow().isoformat(),
    })
```

### Not This

```python
# VULNERABLE: Agent has access to all tools
agent = Agent(tools=all_available_tools)  # No access control

# VULNERABLE: Unvalidated tool arguments
result = tool.invoke(agent_provided_args)  # No schema validation, no path check

# VULNERABLE: Auto-installing MCP servers
if not mcp_server_installed(name):
    install_mcp_server(name)  # No human approval, no vetting
```

**Why it's wrong:** Blanket tool access means a hijacked agent can exfiltrate data, modify files, or call external APIs. Unvalidated arguments enable path traversal and SSRF. Auto-installing MCP servers lets an attacker expand the agent's attack surface remotely.

## Exceptions

- Trusted internal orchestrators may grant broader tool access to sub-agents within a controlled environment, provided the orchestrator validates all tool calls before delegation.
- Development environments may relax rate limits for testing, but production must enforce them.
- Tools with no side effects (pure read, no external calls) may use simplified validation, but schema validation is still required.

## Cross-References

- [Agent Security](agentic-ai-agent-security) — Goal integrity and prompt injection defense
- [Agent Permissions](agentic-ai-permissions) — Credential scoping for tool-using agents
- [Supply Chain Security](agentic-ai-supply-chain) — Verifying tool and MCP server integrity
- [Security](core-security) — Input validation fundamentals apply to tool arguments
- [Dependency Management](core-dependency-management) — Package-level supply chain (tools extend this to agent tools)
