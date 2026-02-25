---
id: agentic-ai-agent-security
title: Agent Security
scope: agentic-ai
severity: critical
tags: [security, agentic-ai, prompt-injection, code-execution, memory-poisoning, trust, owasp-asi, asi01, asi05, asi06, asi09]
references:
  - title: "OWASP Agentic AI Security Initiative — Top 10 (Dec 2025)"
    url: https://genai.owasp.org/2025/12/09/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security/
  - title: "ASI01 — Agent Goal Hijack"
    url: https://genai.owasp.org/resource/agent-goal-hijacking/
  - title: "ASI05 — Unexpected Code Execution"
    url: https://genai.owasp.org/resource/unexpected-agent-code-execution/
  - title: "ASI06 — Memory & Context Poisoning"
    url: https://genai.owasp.org/resource/memory-and-context-poisoning/
  - title: "ASI09 — Human-Agent Trust Exploitation"
    url: https://genai.owasp.org/resource/human-agent-trust-exploitation/
---

## Principle

AI agents act on behalf of users with real credentials and real consequences. Every piece of data an agent receives — tool output, file content, MCP responses, RAG results — is a potential prompt injection vector. Agent output must be treated as untrusted by consuming code, and humans must retain meaningful oversight over agent actions.

## Rules

### Goal Integrity (ASI01)

1. **Enforce instruction/data boundaries.** Agent system prompts must clearly delimit instructions from user-supplied data. Use structural delimiters (XML tags, JSON schema boundaries) — never rely on natural language alone to separate trusted instructions from untrusted input. (ASI01)

2. **Validate tool output before acting on it.** Data returned by tools, MCP servers, file reads, and API calls may contain injected instructions. Parse tool output as data, not as new instructions. Never pass raw tool output directly into system prompts or decision logic without sanitization. (ASI01)

3. **Reject embedded instruction patterns in data.** When processing files, web content, or database records, strip or escape patterns that resemble agent instructions (e.g., "ignore previous instructions", "you are now", system prompt overrides). Log detected injection attempts. (ASI01)

### Code Execution Safety (ASI05)

4. **Never execute agent-generated code without sandboxing.** Code produced by an AI agent must run in a sandboxed environment with restricted filesystem, network, and process access. Never pass agent-generated code to `eval()`, `exec()`, `Function()`, or shell execution in the host process. (ASI05, CWE-94)

5. **Validate generated code before execution.** Apply static analysis or allowlist-based checks to agent-generated code before execution. Block code that accesses sensitive APIs (filesystem write, network requests, process spawning) unless explicitly authorized for the task. (ASI05)

6. **Scope code execution to the task.** Agent-generated code should only access resources required for the current task. Do not grant blanket filesystem or network access. Use temporary directories, scoped tokens, and read-only mounts where possible. (ASI05)

### Memory and Context Integrity (ASI06)

7. **Validate data before ingesting into memory stores.** RAG databases, vector stores, and persistent agent memory are high-value injection targets. Validate and sanitize all content before ingestion. Never ingest raw user-provided or web-scraped content into memory without validation. (ASI06)

8. **Isolate memory per context.** Agent memory (conversation history, RAG context, persistent state) should be scoped per user, per session, or per task. Cross-contamination between contexts enables privilege escalation and data leakage. (ASI06)

9. **Detect and reject memory poisoning.** Monitor memory stores for anomalous content patterns — sudden topic shifts, instruction-like content in data fields, unusually large entries. Implement integrity checks on memory that persists across sessions. (ASI06)

### Human Oversight (ASI09)

10. **Disclose agent involvement in decisions.** When agent recommendations influence user-facing decisions (code changes, configuration, security settings), clearly indicate that the recommendation came from an AI agent. Users must know when they are acting on agent output. (ASI09)

11. **Require human approval for high-impact actions.** Actions that are destructive, irreversible, or affect shared systems (deploy, delete, publish, send) must require explicit human confirmation. Agents should not auto-execute high-impact actions without a human in the loop. (ASI09)

12. **Do not present agent confidence as certainty.** Agent output may be wrong. Code that consumes agent recommendations must not treat them as authoritative without human review or independent validation. (ASI09)

## Patterns

### Do This

```python
# Structural delimiter between instructions and user data
system_prompt = f"""<instructions>
You are a code review assistant. Analyze the code below for security issues.
</instructions>

<user-data>
{user_code}
</user-data>"""

# Validate tool output as data, not instructions
tool_result = mcp_client.call_tool("read_file", {"path": file_path})
parsed = json.loads(tool_result)  # Parse as structured data
# Use parsed fields — never inject raw tool_result into prompts
```

```javascript
// Sandboxed execution of agent-generated code
// Use containers or subprocess isolation — not in-process sandboxes
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDir = mkdtempSync(join(tmpdir(), 'agent-sandbox-'));
const scriptPath = join(tmpDir, 'task.js');
writeFileSync(scriptPath, agentGeneratedCode);

// Run in a subprocess with restricted permissions (cross-platform)
// Node >= 20: --permission flag restricts fs/child_process/worker access
const result = execFileSync(process.execPath, ['--permission',
  `--allow-fs-read=${tmpDir}`, scriptPath], {
  timeout: 5000,
  cwd: tmpDir,
  env: { PATH: process.env.PATH },  // Minimal env — no secrets leakage
});
```

```python
# Validate before RAG ingestion
def ingest_document(content: str, source: str) -> bool:
    # Check for instruction-like patterns in data
    injection_patterns = [
        r"ignore\s+(previous|above)\s+instructions",
        r"you\s+are\s+now",
        r"system:\s*",
    ]
    for pattern in injection_patterns:
        if re.search(pattern, content, re.IGNORECASE):
            logger.warning(f"Potential injection in {source}, skipping ingestion")
            return False
    vector_store.add(content, metadata={"source": source})
    return True
```

### Not This

```python
# VULNERABLE: Raw tool output injected into prompt
tool_result = mcp_client.call_tool("read_file", {"path": path})
prompt = f"Analyze this result: {tool_result}"  # tool_result may contain injections

# VULNERABLE: Agent-generated code executed in host process
code = agent.generate_code(task)
exec(code)  # Full access to host filesystem, network, secrets

# VULNERABLE: Unvalidated RAG ingestion
vector_store.add(web_scraped_content)  # May contain poisoned instructions
```

**Why it's wrong:** Raw tool output can contain injected instructions that hijack the agent's goal. Unsandboxed code execution gives agent-generated code full host access. Unvalidated RAG ingestion allows attackers to plant instructions that influence future agent behavior.

## Exceptions

- Development and testing environments may relax sandboxing for debugging, but production deployments must enforce full isolation.
- Trusted internal tools with validated output schemas may skip raw output sanitization, but the schema validation itself serves as the boundary.
- Agent-to-agent communication within a trusted orchestrator may use less strict delimiters if the orchestrator enforces message integrity (see [agentic-ai-communication](agentic-ai-communication)).

## Cross-References

- [Security](core-security) — Foundational input validation and output encoding
- [Data Flow Security](core-data-flow-security) — Source-to-sink tracing applies to agent data flows
- [Agent Permissions](agentic-ai-permissions) — Least privilege for agent credential and resource access
- [Tool Security](agentic-ai-tool-security) — Vetting and controlling tool access
- [Agent Communication](agentic-ai-communication) — Securing inter-agent messages
