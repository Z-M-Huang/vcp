---
id: agentic-ai-communication
title: Agent Communication
scope: agentic-ai
severity: high
tags: [security, agentic-ai, multi-agent, communication, cascading-failures, circuit-breaker, owasp-asi, asi07, asi08]
references:
  - title: "OWASP Agentic AI Security Initiative — Top 10 (Dec 2025)"
    url: https://genai.owasp.org/2025/12/09/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security/
  - title: "ASI07 — Insecure Inter-Agent Communication"
    url: https://genai.owasp.org/resource/insecure-inter-agent-communication/
  - title: "ASI08 — Cascading Failures"
    url: https://genai.owasp.org/resource/cascading-hallucination-and-decision-failures/
---

## Principle

In multi-agent systems, agents communicate to delegate tasks, share findings, and coordinate actions. Every inter-agent message is a trust boundary crossing — a compromised agent can inject malicious instructions through messages, and a failing agent can cascade errors through the entire system. Communication channels must be authenticated, messages must be validated, and failures must be isolated.

## Rules

### Message Authentication and Integrity (ASI07)

1. **Authenticate inter-agent messages.** Every message between agents must include verifiable sender identity. Use bearer tokens, signed messages, or mutual TLS. Never accept messages from unauthenticated sources — even within the same process. (ASI07)

2. **Validate message content at each hop.** When an agent receives a message from another agent, validate the content against the expected schema. Do not assume messages from "trusted" agents are well-formed or safe. An upstream agent may be compromised. (ASI07)

3. **Do not grant implicit trust between agents.** Each agent must independently validate inputs, regardless of the source agent's reputation or role. A "security reviewer" agent sending code review results does not mean the results are trustworthy — they must be structurally validated. (ASI07)

4. **Encrypt sensitive data in transit between agents.** If inter-agent messages contain credentials, PII, or security findings, encrypt them in transit. Use TLS for network communication and structured encryption for message payloads when passing through untrusted intermediaries. (ASI07)

5. **Scope message routing.** Agents should only be able to send messages to agents they are authorized to communicate with. Implement an allowlist of permitted communication pairs. A code review agent should not be able to message a deployment agent directly. (ASI07)

### Cascading Failure Prevention (ASI08)

6. **Implement circuit breakers for agent chains.** When one agent in a chain fails repeatedly, stop sending requests to it rather than allowing errors to propagate. Use circuit breaker patterns with configurable failure thresholds, reset intervals, and fallback behaviors. (ASI08)

7. **Isolate agent failures.** One agent's failure must not corrupt another agent's state, memory, or output. Use separate execution contexts (processes, containers) and validate all inter-agent data at reception. A crashing agent should produce an error result, not garbage data. (ASI08)

8. **Set timeouts on all inter-agent calls.** Every message or task sent to another agent must have an explicit timeout. Without timeouts, a single hanging agent blocks the entire pipeline. Timeouts should be tuned per agent type and task complexity. (ASI08)

9. **Limit retry depth in agent chains.** When an agent-to-agent call fails, limit automatic retries to prevent retry storms. Use exponential backoff. A failing agent retried indefinitely by multiple upstream agents can cause system-wide resource exhaustion. (ASI08)

10. **Propagate errors with context, not raw failures.** When an agent fails and the error must reach upstream agents or the orchestrator, wrap it in a structured error format that includes: which agent failed, what task it was performing, why it failed, and whether it's retryable. Never propagate raw exceptions or stack traces between agents. (ASI08)

## Patterns

### Do This

```python
# Authenticated inter-agent messaging with replay protection
class AgentMessage:
    sender: str
    recipient: str
    payload: dict
    nonce: str       # Unique per message — prevents replay
    timestamp: float # Sender's time — reject stale messages
    signature: str   # HMAC-SHA256 of (sender + recipient + payload + nonce + timestamp)

NONCE_TTL = 300  # 5 minutes — matches stale window

def send_message(msg: AgentMessage, channel: SecureChannel):
    msg.nonce = secrets.token_hex(16)
    msg.timestamp = time.time()
    # Bind sender + recipient into signature to prevent forwarding attacks
    sign_data = msg.sender + msg.recipient + json.dumps(msg.payload, sort_keys=True) + msg.nonce + str(msg.timestamp)
    msg.signature = hmac_sign(sign_data, shared_secret)
    channel.send(msg)

def receive_message(msg: AgentMessage, seen_nonces: dict) -> dict:
    # Evict expired nonces (bounded storage)
    now = time.time()
    expired = [n for n, ts in seen_nonces.items() if now - ts > NONCE_TTL]
    for n in expired:
        del seen_nonces[n]
    # Reject stale messages (> 5 min)
    if abs(now - msg.timestamp) > NONCE_TTL:
        raise SecurityError(f"Stale message from {msg.sender}")
    # Reject replayed messages
    if msg.nonce in seen_nonces:
        raise SecurityError(f"Replayed message from {msg.sender}")
    # Verify signature binds sender, recipient, payload, nonce, and timestamp
    sign_data = msg.sender + msg.recipient + json.dumps(msg.payload, sort_keys=True) + msg.nonce + str(msg.timestamp)
    if not hmac_verify(sign_data, msg.signature, shared_secret):
        raise SecurityError(f"Invalid signature from {msg.sender}")
    seen_nonces[msg.nonce] = now  # Track with timestamp for TTL eviction
    validate(msg.payload, expected_schema)
    return msg.payload
```

```python
# Circuit breaker for agent chains
class CircuitBreaker:
    def __init__(self, failure_threshold=3, reset_timeout=60):
        self.failures = 0
        self.threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self.state = "closed"  # closed = healthy, open = failing

    async def call(self, agent_fn, *args):
        if self.state == "open":
            raise CircuitOpenError("Agent circuit is open — too many failures")
        try:
            result = await asyncio.wait_for(agent_fn(*args), timeout=300)
            self.failures = 0
            return result
        except Exception as e:
            self.failures += 1
            if self.failures >= self.threshold:
                self.state = "open"
                asyncio.get_event_loop().call_later(self.reset_timeout, self._reset)
            raise
```

```javascript
// Structured error propagation between agents
function createAgentError(agentId, task, error, retryable = false) {
  return {
    type: 'agent_error',
    agent: agentId,
    task: task,
    error: error.message,  // Never raw stack trace
    retryable: retryable,
    timestamp: new Date().toISOString(),
  };
}
```

### Not This

```python
# VULNERABLE: No message authentication
def handle_message(msg):
    execute_task(msg["task"])  # Any agent (or attacker) can send messages

# VULNERABLE: No circuit breaker — cascading failure
async def review_pipeline(agents):
    for agent in agents:
        result = await agent.execute(task)  # If one hangs, all block
        task = result  # Error in one agent corrupts downstream

# VULNERABLE: Raw exception propagation
try:
    result = await agent.execute(task)
except Exception as e:
    send_to_upstream(str(e))  # Leaks internal details, no structure
```

**Why it's wrong:** Unauthenticated messages allow any compromised agent to impersonate trusted agents and inject malicious tasks. No circuit breakers mean one failing agent blocks or corrupts the entire pipeline. Raw exception propagation leaks internal details and provides no actionable error handling information.

## Exceptions

- Agents within the same process boundary (e.g., in-process function calls within an orchestrator) may use simplified authentication (caller identity verification) rather than cryptographic signatures.
- Read-only agents that produce advisory output (not consumed by other agents) may skip message integrity checks for their output, as no downstream agent depends on it.
- Single-agent systems with no inter-agent communication may skip this standard entirely, but should still implement timeouts for external tool calls.

## Cross-References

- [Agent Security](agentic-ai-agent-security) — Goal integrity and prompt injection defense
- [Agent Permissions](agentic-ai-permissions) — Rogue agent detection and isolation
- [Supply Chain Security](agentic-ai-supply-chain) — Agent identity verification
- [Error Handling](core-error-handling) — Structured error propagation fundamentals
- [Security](core-security) — Transport encryption (rule 9) and authentication (rule 6)
