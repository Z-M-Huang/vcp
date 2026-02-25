---
id: agentic-ai-permissions
title: Agent Permissions
scope: agentic-ai
severity: critical
tags: [security, agentic-ai, permissions, least-privilege, credentials, isolation, owasp-asi, asi03, asi10]
references:
  - title: "OWASP Agentic AI Security Initiative — Top 10 (Dec 2025)"
    url: https://genai.owasp.org/2025/12/09/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security/
  - title: "ASI03 — Identity & Privilege Abuse"
    url: https://genai.owasp.org/resource/identity-and-privilege-abuse/
  - title: "ASI10 — Rogue Agents"
    url: https://genai.owasp.org/resource/rogue-agents/
---

## Principle

An agent should have exactly the permissions needed for its current task — no more, no less, and no longer than necessary. Agents inherit their user's identity but should not inherit their full privilege set. Rogue agents — whether compromised, misconfigured, or misaligned — must be detectable and containable through structural boundaries, not just behavioral expectations.

## Rules

### Least Privilege (ASI03)

1. **Grant agents the minimum permissions for the task.** An agent performing code review needs read access to source files, not admin access to the repository. An agent generating reports needs read access to data, not write access to production databases. Define permissions per task, not per agent. (ASI03)

2. **Do not inherit the user's full credential set.** Agents should receive task-scoped credentials, not the user's ambient credentials. If the user has admin access but the agent task is code review, the agent should receive read-only credentials. (ASI03, CWE-250)

3. **Use session-scoped tokens.** Agent credentials should expire when the task completes. Use short-lived tokens, session-scoped API keys, or temporary credentials (e.g., AWS STS) that auto-expire. Never give agents long-lived credentials. (ASI03, CWE-613)

4. **Enforce filesystem boundaries.** Agents should only access files within the project directory and explicitly allowed paths. Use containers, or allowlist-based path validation to prevent agents from accessing sensitive host directories — Unix: `~/.ssh`, `~/.aws`, `/etc/passwd`; Windows: `%USERPROFILE%\.ssh`, `%APPDATA%`, `C:\Windows\System32`. Path checks must be cross-platform: use `os.path.relpath()` or `path.relative()` instead of string prefix comparison, which fails on Windows due to case-insensitive paths and drive letters. (ASI03, CWE-22)

5. **Enforce network boundaries.** Agents should only access allowed network endpoints. Block or allowlist outbound network access to prevent data exfiltration to attacker-controlled servers. Internal-only agents should have no external network access. (ASI03)

### Rogue Agent Detection (ASI10)

6. **Monitor agent behavior against expected patterns.** Define behavioral baselines per agent type (expected tools, expected file access patterns, expected execution duration). Alert when an agent deviates — accessing unexpected files, calling unexpected tools, or running longer than expected. (ASI10)

7. **Detect persistent agents acting outside scope.** Agents should not persist beyond their task. Monitor for agents that remain active after task completion, spawn unexpected sub-processes, or establish persistent network connections. Implement automatic cleanup with hard timeouts. (ASI10)

8. **Implement kill switches.** Every agent must be terminable by the orchestrator or human operator at any time. Agents that cannot be stopped are rogue by definition. Design agent lifecycles with graceful shutdown and forced termination as built-in capabilities. (ASI10)

9. **Log all privilege escalation attempts.** Any attempt by an agent to access resources outside its granted permissions must be logged and alerted. This includes file access denials, authentication failures, and attempts to invoke restricted tools. (ASI10, CWE-269)

10. **Isolate agent execution environments.** Agents operating on different tasks or with different trust levels should run in separate execution environments (separate processes, containers, or sandboxes). One compromised agent should not be able to access another agent's credentials or data. (ASI10)

## Patterns

### Do This

```python
# Task-scoped credentials — not the user's full credential set
agent_creds = create_scoped_token(
    base_identity=user_identity,
    permissions=["repo:read", "issues:read"],  # Minimum for code review
    expires_in=timedelta(hours=1),
)
agent = Agent(credentials=agent_creds)
```

```javascript
// Cross-platform filesystem boundary enforcement
const ALLOWED_DIRS = [projectDir, path.join(projectDir, 'node_modules')];

function validateAgentPath(requestedPath) {
  const resolved = path.resolve(requestedPath);
  // Use path.relative() — works on Windows (case-insensitive) and Unix
  const isAllowed = ALLOWED_DIRS.some(dir => {
    const rel = path.relative(dir, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!isAllowed) {
    auditLog.warn({ event: 'path_denied', path: resolved, agent: agentId });
    throw new SecurityError(`Access denied: ${requestedPath}`);
  }
  return resolved;
}
```

```python
# Hard timeout with forced termination
async def run_agent_with_timeout(agent, task, timeout_seconds=300):
    try:
        result = await asyncio.wait_for(agent.execute(task), timeout=timeout_seconds)
        return result
    except asyncio.TimeoutError:
        logger.warning(f"Agent {agent.id} timed out after {timeout_seconds}s, terminating")
        await agent.force_terminate()
        raise AgentTimeoutError(f"Agent exceeded {timeout_seconds}s limit")
```

### Not This

```python
# VULNERABLE: Agent inherits user's full credentials
agent = Agent(credentials=user.credentials)  # Agent gets admin access

# VULNERABLE: No filesystem boundary
file_content = open(agent_requested_path).read()  # Agent can read ~/.ssh/id_rsa or %USERPROFILE%\.ssh\id_rsa

# VULNERABLE: No timeout, no kill switch
agent.run_forever(task)  # Cannot be stopped if it goes rogue
```

**Why it's wrong:** Inherited full credentials mean a hijacked agent has admin access to everything the user can touch. No filesystem boundaries allow data exfiltration of SSH keys and credentials. No timeout means a rogue agent can persist indefinitely.

## Exceptions

- Orchestrator agents may hold broader permissions than task agents, provided those permissions are scoped to orchestration actions (spawning sub-agents, routing tasks) and not to data access.
- Development environments may use relaxed filesystem boundaries for convenience, but production and CI/CD must enforce strict boundaries.
- Agents running inside already-sandboxed environments (e.g., Docker containers with restricted mounts) may rely on the container's isolation rather than implementing application-level path validation.

## Cross-References

- [Agent Security](agentic-ai-agent-security) — Goal integrity and human oversight requirements
- [Tool Security](agentic-ai-tool-security) — Tool-level access control complements permission boundaries
- [Security](core-security) — Authorization fundamentals (deny by default, rule 7)
- [Secure Defaults](core-secure-defaults) — Default-deny permission model
- [Agent Communication](agentic-ai-communication) — Inter-agent trust boundaries
