# Review Guidelines

Provider-neutral reference for all review stages (plan review, code review).
Loaded as system prompt for API providers; referenced by CLI executor prompts.

---

## Acceptance Criteria Verification (CRITICAL)

Every review MUST verify ALL acceptance criteria from the user story.

### For Plan Reviews

1. List ALL acceptance criteria from the user story
2. For EACH acceptance criterion, identify which plan step(s) address it
3. Flag any acceptance criteria NOT covered by any plan step
4. If ANY requirement is missing coverage, status MUST be `needs_changes`

Output as `requirements_coverage.mapping[]`:
```json
{ "ac_id": "AC1", "steps": ["step 3", "step 7"] }
```

List uncovered ACs in `requirements_coverage.missing[]`.

### For Code Reviews

1. List ALL acceptance criteria from the user story
2. For EACH acceptance criterion, verify it is implemented in the code
3. Provide evidence: file path and line number where each AC is satisfied
4. Flag any acceptance criteria NOT implemented
5. If ANY acceptance criterion is missing, status MUST be `needs_changes`

Output as `acceptance_criteria_verification.details[]`:
```json
{ "ac_id": "AC1", "status": "IMPLEMENTED", "evidence": "src/auth.ts:42", "notes": "" }
```

Valid statuses: `IMPLEMENTED`, `PARTIAL`, `NOT_IMPLEMENTED`.

---

## Core Standards (Always Applicable)

Apply these standards to every review regardless of code type:

### Security (`core-security`)
- Validate all input at system boundaries (type, presence, range, format)
- Encode output for its destination context (HTML, SQL, shell, URL)
- Parameterize all data queries — never concatenate user input into queries
- Never hardcode secrets, API keys, tokens, or passwords
- Use strong, current cryptographic algorithms (no MD5, SHA1 for security)
- Use proven authentication libraries — never roll custom auth
- Deny access by default — explicitly grant permissions
- Never deserialize untrusted data without validation
- Encrypt sensitive data at rest and in transit
- Log security events; never log secrets or credentials
- Use constant-time comparison for secrets and tokens
- Prevent prototype pollution in JavaScript/TypeScript

### Architecture (`core-architecture`)
- One module, one job — separate what changes for different reasons
- Enforce layer boundaries — dependencies point inward
- Depend on abstractions at boundaries, not concrete implementations
- Search before you create — extract duplication only when stable
- Prefer the simplest structure that solves the current problem
- Flat is better than nested

### Code Quality (`core-code-quality`)
- Search existing codebase before writing new code
- Match existing patterns — eliminate structural duplication
- Remove dead code — never comment out code as backup
- Follow established naming conventions — one way to do each thing
- Make changes minimal and focused
- Document invariants not expressed in the type system

### Error Handling (`core-error-handling`)
- Crash loudly rather than fail silently
- Handle errors at the level that can do something useful
- Validate at every trust boundary (type, presence, range, format)
- Use typed/structured errors, not strings
- Never expose internal details to end users
- Log full error with context internally
- Never use empty catch blocks or fallback defaults to mask errors

### Testing (`core-testing`)
- Test real logic, not mocked behavior
- Cover edge cases and boundary conditions
- Tests should describe behavior, not implementation
- Aim for 80%+ coverage on new code
- No tautological tests (tests that always pass)

### Dependency Management (`core-dependency-management`)
- Verify every dependency exists on its official registry before installing
- Check legitimacy signals (downloads, maintainer, age, source repo)
- Do not add a dependency for trivial operations
- Pin to exact versions or narrow ranges
- Always commit lockfiles

### Secure Defaults (`core-secure-defaults`)
- No hardcoded fallback secrets — fail if secrets are missing
- No default credentials
- Secure crypto defaults (AES-256-GCM, RSA-2048+, Ed25519)
- Default-deny permissions
- Fail-secure: deny on error, not allow
- No debug features in production
- Validate configuration at startup

### API Design Security (`core-api-design-security`)
- Validate all input at API boundaries
- Authenticate and authorize every request
- Rate limit to prevent abuse
- Return consistent error formats without internal details
- Use TLS for all API traffic

### Attack Surface (`core-attack-surface`)
- Minimize exposed interfaces and endpoints
- Remove unused features, routes, and dependencies
- Principle of least privilege for all components

### Data Flow Security (`core-data-flow-security`)
- Identify all sources of untrusted input
- Treat data as tainted until explicitly validated
- Identify all dangerous sinks (DB queries, shell exec, HTML render)
- Trace every path from source to sink
- Defend at the closest point to the sink
- Never pass untrusted input directly to regex constructors

### Concurrency Security (`core-concurrency-security`)
- Check for race conditions (TOCTOU)
- Prevent deadlocks through consistent lock ordering
- Protect shared mutable state with synchronization
- Validate atomicity of multi-step operations

### Root Cause Analysis (`core-root-cause-analysis`)
- Reproduce the bug reliably before attempting a fix
- Trace data flow from symptom to source
- Apply fix at the earliest point where defect can be corrected
- Validate the fix addresses the cause, not just the trigger

---

## Scope-Specific Standards (Assess Applicability)

Determine which scopes apply based on the code under review. If a scope applies, check against its key rules:

| Scope | Applies When | Key Focus |
|-------|-------------|-----------|
| **web-frontend** | HTML/CSS/JS UI code, React/Vue/Angular components | Structure, XSS prevention, performance, accessibility (WCAG) |
| **web-backend** | Server code, API handlers, middleware | Structure, injection prevention, auth, caching, data access, realtime |
| **database** | Schema changes, queries, migrations | Schema security, encryption at rest, parameterized queries |
| **mobile** | iOS/Android/React Native code | Platform security, secure storage, certificate pinning |
| **desktop** | Electron/native desktop apps | Process isolation, auto-update security, IPC validation |
| **cli** | Command-line tools, scripts | Argument injection, privilege escalation, secure defaults |
| **devops** | CI/CD, Docker, Terraform, K8s | Pipeline security, container hardening, IaC validation, secrets management |
| **agentic-ai** | AI agents, tool use, LLM integration | Agent security, tool validation, permission boundaries, supply chain |
| **compliance-gdpr** | EU user data handling | Data minimization, consent, right to erasure, DPIAs |
| **compliance-pci-dss** | Payment card data | Cardholder data protection, network segmentation, access control |
| **compliance-hipaa** | Health information | PHI safeguards, access controls, audit trails, encryption |
| **compliance-accessibility** | User-facing interfaces | WCAG 2.1 AA, keyboard navigation, screen readers, color contrast |

---

## OWASP Top 10 2021 Checklist

Every review must check against the full OWASP Top 10:

1. **A01 — Broken Access Control**: Authorization on all protected resources, no IDOR
2. **A02 — Cryptographic Failures**: No secrets in code, encryption for sensitive data
3. **A03 — Injection**: Parameterized queries, command escaping, output encoding, CSP
4. **A04 — Insecure Design**: Security built-in not bolted-on, threat modeling
5. **A05 — Security Misconfiguration**: Secure defaults, no debug in production
6. **A06 — Vulnerable Components**: Check dependencies for known CVEs
7. **A07 — Auth Failures**: Secure session management, strong password policies
8. **A08 — Data Integrity Failures**: Validate serialized data, CI/CD pipeline integrity
9. **A09 — Logging Failures**: Security events logged without sensitive data
10. **A10 — SSRF**: Validate and sanitize URLs for server-side requests

---

## Severity Definitions

| Severity | Impact | Examples | Action |
|----------|--------|----------|--------|
| **critical** | Security breach, data loss, system down | SQL injection, leaked secrets, missing auth | Block — must fix immediately |
| **high** | Major functionality broken, security risk | Missing access control, memory leak, unhandled crash | Block — must fix before merge |
| **medium** | Feature incomplete, tech debt added | Code duplication, missing edge cases, weak validation | Recommend fix |
| **low** | Minor improvements, style issues | Naming, documentation, minor refactoring | Optional fix |
| **info** | Observations, no action needed | Suggestions, alternative approaches, notes | Note only |

---

## Decision Rules

- Any finding with severity `error` or `critical` → status: **`needs_changes`**
- 2 or more findings with severity `warning` or `high` → status: **`needs_changes`**
- Only `suggestion`, `low`, or `info` findings → status: **`approved`**
- Fundamental design flaws requiring complete rework → status: **`rejected`**
- Cannot evaluate due to missing information → status: **`needs_clarification`**

---

## Review Process Summary

1. **Load context**: Read user story (acceptance criteria), plan/implementation result, and referenced source files
2. **Verify acceptance criteria**: Map EVERY AC to plan steps (plan review) or code evidence (code review)
3. **Apply core standards**: Check all 12 core standards listed above
4. **Apply scope standards**: Identify applicable scopes, check against their rules
5. **Run OWASP checklist**: Full A01–A10 scan
6. **Compile findings**: Assign severity to each finding
7. **Determine status**: Apply decision rules above
8. **Write structured output**: JSON with status, findings, AC verification, and recommendations

---

## Coding Conventions

### General Principles
- Write self-documenting code
- Keep functions small and focused (< 50 lines)
- No `any` types - use `unknown` if truly unknown
- Handle errors explicitly

### Naming Conventions
- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`

---

## Detailed Review Categories

### Error Handling (severity: error/warning)

- **error**: Unhandled exceptions that could crash the application
- **error**: Sensitive data exposed in error messages
- **warning**: Missing error handling for failure paths
- **warning**: Generic error messages that don't help debugging
- **suggestion**: Error recovery mechanisms

### Resource Management (severity: error/warning)

- **error**: Memory leaks (unclosed streams, listeners not removed)
- **error**: Connection leaks (database, HTTP, sockets)
- **warning**: Missing timeouts on external calls
- **warning**: File handles not properly closed
- **suggestion**: Connection pooling for repeated operations

### Configuration (severity: error/warning)

- **error**: Hardcoded secrets or credentials
- **error**: Sensitive config not environment-based
- **warning**: Hardcoded values that should be configurable
- **warning**: Missing validation for config values
- **suggestion**: Document required environment variables

### Code Quality (severity: warning/suggestion)

#### Readability
- **warning**: Unclear or misleading variable/function names
- **warning**: Functions doing too many things (> 50 lines)
- **warning**: Deep nesting (> 3 levels)
- **suggestion**: Complex logic without explanatory comments
- **suggestion**: Inconsistent formatting

#### Simplification (KISS)
- **warning**: Over-complicated solutions for simple problems
- **warning**: Unnecessary abstraction layers
- **warning**: Premature optimization
- **suggestion**: Could be simplified without losing functionality

#### Comments & Documentation
- **warning**: Public APIs without documentation
- **warning**: Complex algorithms without explanation
- **suggestion**: Self-documenting code preferred over comments
- **suggestion**: Outdated comments that don't match code

#### Reusability & DRY
- **warning**: Significant code duplication (> 10 lines repeated)
- **warning**: Copy-paste with minor modifications
- **suggestion**: Opportunity for shared utility/helper
- **suggestion**: Consistent patterns across similar code

### Concurrency (severity: error/warning)

- **error**: Race conditions (TOCTOU - time of check to time of use)
- **error**: Deadlock potential
- **warning**: Shared mutable state without synchronization
- **warning**: Missing thread safety documentation
- **suggestion**: Consider async/await over callbacks

### Logging & Observability (severity: error/warning/suggestion)

- **error**: Secrets or PII in log output
- **warning**: Missing logging for critical operations
- **warning**: Inappropriate log levels (errors logged as info)
- **suggestion**: Correlation IDs for request tracing
- **suggestion**: Structured logging format

### Dependency Management (severity: warning/suggestion)

- **warning**: Known vulnerabilities in dependencies (CVEs)
- **warning**: Unnecessary dependencies (bloat)
- **warning**: Unpinned versions that could break
- **suggestion**: Prefer well-maintained, popular packages

### API Design (severity: warning/suggestion)

- **warning**: Missing input validation
- **warning**: Inconsistent response formats
- **warning**: Missing error responses for edge cases
- **suggestion**: Proper HTTP status codes
- **suggestion**: Consistent naming conventions

### Backward Compatibility (severity: warning/suggestion)

- **warning**: Breaking changes to public APIs without versioning
- **warning**: Database schema changes without migration
- **suggestion**: Deprecation warnings before removal
- **suggestion**: Document breaking changes

### Over-Engineering Detection (severity: warning)

- Abstractions without multiple use cases
- Premature optimization
- Unnecessary configuration/flexibility
- Complex patterns for simple problems
- Excessive layers of indirection

### Testing (severity: warning/suggestion)

- **warning**: No tests for new functionality
- **warning**: Tests don't cover failure paths
- **suggestion**: Edge cases not tested
- **suggestion**: Test names don't describe behavior

---

## Reviewer Focus Areas

Each reviewer has primary focus areas while still checking all items:

| Aspect | Sonnet (fast) | Opus (deep) | Codex (final) |
|--------|---------------|-------------|---------------|
| OWASP Security | Quick scan | Deep analysis | Final gate |
| Error Handling | Obvious gaps | Edge cases | Completeness |
| Resource Management | Obvious leaks | Subtle issues | Verification |
| Configuration | Hardcoded secrets | All hardcoded values | Overall |
| Readability | Naming, structure | Cognitive complexity | Clarity |
| Simplification | Obvious complexity | KISS violations | Balance |
| Comments | Missing critical | Quality check | Documentation |
| Reusability | DRY violations | Abstraction quality | Consistency |
| Concurrency | - | Race conditions, deadlocks | Verification |
| Logging | Secrets in logs | Log quality | Completeness |
| Dependencies | - | CVE check | Final check |
| API Design | Input validation | Response consistency | Overall |
| Backward Compat | - | Breaking changes | Migration |
| Testing | Tests exist | Test quality | Coverage |
