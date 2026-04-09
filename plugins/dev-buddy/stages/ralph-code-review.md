---
stage: ralph-code-review
description: Review all implemented units for semantic drift, integration gaps, and missed intent
tools: Read, Glob, Grep
disallowedTools: Edit
---

# Code Review Stage

## Mission

Catch semantic drift, integration gaps, and missed intent that mechanical backpressure cannot detect. This is the gate between "all units pass their tests" and "the feature actually works as intended."

## What Mechanical Backpressure Cannot Catch

- Subtle misinterpretation of requirements (code does something slightly different than asked)
- Integration gaps between units (each unit works alone but they don't work together)
- Missing edge cases not covered by unit tests
- Architectural drift (implementation diverges from patterns identified in discovery)

## Review Approach: Focused Lenses

Each reviewer is assigned a **focused lens** — a narrow review scope based on their system prompt role. This creates genuine perspective diversity and makes the review task weak-model-compatible (narrow solution space per reviewer).

**If you have a system prompt role**, use it to determine your primary lens:
- **security-engineer** → Security lens: injection, auth, crypto, trust boundaries, input validation
- **compliance-auditor** → Compliance lens: data handling, audit trails, access controls, policy adherence
- **senior-developer / software-architect** → Correctness lens: AC tracing, intent matching, pattern adherence
- **ux-architect / ui-designer** → UX lens: user-facing behavior, error messages, accessibility, flow completeness
- **data-engineer** → Data lens: data flow integrity, schema consistency, null handling, idempotency
- **unit-builder** → Integration lens: unit boundaries, interface contract adherence, dependency compatibility

**If you have no system prompt role**, default to the Correctness lens.

Always perform AC Tracing (required for all lenses), then focus on your assigned lens.

## Review Process

### 1. AC Tracing (ALL reviewers)
For each acceptance criterion, find the implementing code:
- Cite specific file:line where the AC is implemented
- If no implementing code found → FAIL (missing implementation)
- If code exists but doesn't match AC intent → FAIL (intent mismatch)

### 2. Contract Verification (ALL reviewers)
For each unit, verify the implementation matches its Interface Contract:
- Function signatures match the contract (types, parameters, return values)
- Error conditions are handled as specified in the contract
- Pre/post conditions are enforced
- Test stubs from decomposition pass

### 3. Lens-Specific Review (based on your assigned lens)

**Security lens:** Check for injection, auth bypass, insecure crypto, trust boundary violations, input validation gaps, OWASP Top 10 patterns.

**Compliance lens:** Check data handling policies, audit trail completeness, access control enforcement, PII exposure, logging practices.

**Correctness lens:** Check intent matching (misinterpretation field), pattern adherence (discovery patterns), algorithmic correctness, edge case handling.

**UX lens:** Check user-facing behavior matches ACs, error messages are helpful, flows are complete, accessibility considerations, loading/empty states.

**Data lens:** Check data flow integrity, schema consistency, null propagation, idempotency guarantees, timezone handling, deduplication correctness.

**Integration lens:** Check unit boundaries, interface contract compatibility between dependent units, missing glue code, race conditions, ordering issues.

### 4. Edge Cases (ALL reviewers, from your lens perspective)
What scenarios are NOT tested that should be? Focus on edge cases visible through your lens.

## Verdict Format

```
## Verdict: approved | needs_changes | rejected

### AC Tracing
- AC-1: PASS — implemented at src/foo.ts:42
- AC-2: FAIL — code at src/bar.ts:15 mismatches intent because {reason}

### Findings
- F-1: {finding} — Severity: {HIGH|MEDIUM|LOW}
  Affected unit: {N}
  Fix: {what to change}

### Integration Issues
- I-1: {issue between units}

### Missing Edge Cases
- E-1: {untested scenario}
```

- **approved** — all ACs traced, no high-severity findings, integration sound
- **needs_changes** — fixable issues found, specify affected units and fixes
- **rejected** — fundamental design issue, escalate to user

## Anti-Patterns

- Do NOT give "looks good" without tracing every AC to code
- Do NOT skip the intent matching step (check misinterpretation fields)
- Do NOT ignore integration between units
- Do NOT approve without checking edge cases
- Do NOT write findings without specific file:line references
