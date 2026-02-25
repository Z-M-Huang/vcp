---
id: agentic-ai-supply-chain
title: Agentic Supply Chain
scope: agentic-ai
severity: critical
tags: [security, agentic-ai, supply-chain, mcp, plugins, model-provenance, tool-registry, owasp-asi, asi04]
references:
  - title: "OWASP Agentic AI Security Initiative — Top 10 (Dec 2025)"
    url: https://genai.owasp.org/2025/12/09/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security/
  - title: "ASI04 — Agentic Supply Chain Vulnerabilities"
    url: https://genai.owasp.org/resource/agentic-supply-chain-vulnerabilities/
  - title: "OpenClaw MCP Directory — 1,184 malicious plugins found (2025)"
    url: https://invariantlabs.ai/mcp-security-notification
---

## Principle

Agent supply chains extend beyond traditional package dependencies to include MCP servers, tool plugins, model providers, agent personas, and tool descriptors. Each is an attack vector: a compromised MCP server can exfiltrate data through tool calls, a tampered tool descriptor can trick an agent into unsafe actions, and a poisoned model can systematically introduce vulnerabilities. This standard covers agent-specific supply chain risks; package-level supply chain is covered by [Dependency Management](core-dependency-management).

## Rules

### MCP Server and Plugin Integrity

1. **Verify MCP server identity and integrity.** Before enabling an MCP server, verify its source repository, author identity, and code integrity. Use checksums or signatures when the registry provides them. Do not enable MCP servers solely based on a name or description match. (ASI04)

2. **Audit MCP server permissions and capabilities.** Review what tools an MCP server exposes, what data it accesses, what network calls it makes, and what side effects its tools have. An MCP server requesting filesystem write + network access for a "code formatting" task is a red flag. (ASI04)

3. **Monitor MCP server updates for capability changes.** When an MCP server updates, review the diff for new tools, expanded permissions, or changed behavior. A previously safe server may introduce malicious capabilities in an update. Pin versions and review changelogs before upgrading. (ASI04)

### Tool Descriptor Integrity

4. **Validate tool descriptors against observed behavior.** A tool's declared schema (parameters, return types, side effects) should match its actual behavior. Detect discrepancies between what a tool claims to do and what it actually does — tool rug pulls (changing behavior after initial trust). (ASI04)

5. **Do not trust tool descriptions for security decisions.** A tool describing itself as "read-only" or "safe" is a claim, not a guarantee. Verify through code review, sandboxed testing, or behavioral monitoring. Tool descriptions are attacker-controlled metadata. (ASI04)

### Model Provenance

6. **Verify model provider identity.** When using external model providers (via API or self-hosted), verify the provider's identity and the model's provenance. A man-in-the-middle between your agent and the model API can inject arbitrary responses. Use TLS with certificate validation. (ASI04)

7. **Detect model behavior drift.** Monitor model responses for systematic changes that may indicate model tampering, fine-tuning attacks, or provider compromise. Sudden changes in code generation patterns, security recommendation quality, or response style warrant investigation. (ASI04)

### Agent Persona Verification

8. **Verify agent identity in multi-agent systems.** In systems where multiple agents collaborate, each agent must authenticate its identity. An attacker injecting a fake agent into a multi-agent system can intercept tasks, exfiltrate data, or provide poisoned analysis. (ASI04)

9. **Do not trust agent-declared capabilities.** An agent claiming to be a "security expert" or "code reviewer" is making an unverified claim. The orchestrator should assign roles based on known configuration, not agent self-declaration. (ASI04)

## Patterns

### Do This

```json
// Pin MCP server versions with integrity checks
{
  "mcpServers": {
    "file-reader": {
      "package": "@org/file-reader-mcp",
      "version": "1.2.3",
      "integrity": "sha256-abc123..."
    }
  }
}
```

```python
# Audit MCP server capabilities before enabling
def vet_mcp_server(server_config: dict) -> bool:
    tools = server_config.get("tools", [])
    for tool in tools:
        # Flag tools with dangerous capabilities
        if tool.get("side_effects", False) and tool.get("network_access", False):
            logger.warning(
                f"MCP server {server_config['name']} tool {tool['name']} "
                f"has side effects AND network access — manual review required"
            )
            return False
    return True
```

```python
# Verify model provider TLS and identity
import httpx

client = httpx.Client(
    base_url=model_provider_url,
    verify=True,  # Enforce TLS certificate validation
    timeout=30.0,
)
# Never set verify=False for model provider connections
```

### Not This

```python
# VULNERABLE: Installing MCP server by name without verification
install_mcp_server("cool-code-formatter")  # No source check, no integrity

# VULNERABLE: Trusting tool description for security
if tool.description.contains("read-only"):
    allow_without_sandbox(tool)  # Description is attacker-controlled

# VULNERABLE: No TLS verification for model provider
client = httpx.Client(base_url=provider_url, verify=False)  # MITM risk
```

**Why it's wrong:** Installing by name alone is vulnerable to typosquatting and namespace hijacking (1,184 malicious MCP plugins found in the OpenClaw directory). Trusting tool descriptions for security decisions lets attackers bypass controls by lying in metadata. Disabling TLS verification allows man-in-the-middle attacks on model API connections.

## Exceptions

- Internal MCP servers developed and maintained by the same team may use simplified vetting, but must still be pinned to specific versions and audited on update.
- Model providers accessed through a trusted API gateway (e.g., corporate proxy with its own TLS termination) may delegate TLS verification to the gateway.
- Development and testing may use self-signed certificates for local model servers, but production must enforce proper TLS.

## Cross-References

- [Dependency Management](core-dependency-management) — Package-level supply chain (npm, pip, cargo). This standard extends supply chain to agent-specific artifacts.
- [Tool Security](agentic-ai-tool-security) — Tool access control and invocation auditing
- [Agent Security](agentic-ai-agent-security) — Prompt injection through compromised tool output
- [Agent Communication](agentic-ai-communication) — Verifying agent identity in multi-agent systems
- [Security](core-security) — Transport encryption fundamentals (rule 9)
