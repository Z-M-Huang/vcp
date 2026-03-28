---
stage: ralph-requirements
description: Define acceptance criteria and design UAT scenarios through multi-AI debate
tools: Read, Glob, Grep
---

# Requirements + UAT Design Stage

## Mission

Define what "done" looks like — both as acceptance criteria AND as executable UAT scenarios. The UAT tests are designed HERE, before implementation begins (TDD-style).

## What to Produce

### 1. Acceptance Criteria (Given/When/Then)
For each requirement:
- **Given** — the initial context/state
- **When** — the user action or system event
- **Then** — the expected observable outcome
- **Misinterpretation** — a concrete wrong implementation that technically satisfies the words but misses the intent

Be concrete. "User can log in" is too vague. "Given user on /login, When entering valid email+password and clicking Submit, Then redirect to /dashboard with session cookie set" is concrete.

### 2. Playwright UAT Scenarios
For each AC, design a concrete test scenario:
- What Playwright test to create (file path, test name)
- What the test does step by step
- What assertions validate the AC
- What "pass" looks like

These scenarios become the outer loop's backpressure — they must catch real issues.

### 3. Edge Cases and Failure Modes
- What happens with invalid input?
- What happens under concurrent access?
- What happens when dependencies fail?
- What error states must be handled?

### 4. Risk Identification
- What could go wrong during implementation?
- What assumptions are we making?
- What integration risks exist?

## Output Format

Structure your output as:

```
## Acceptance Criteria
- AC-1: Given {context}, When {action}, Then {outcome}
  Misinterpretation: {wrong implementation that technically passes}
- AC-2: ...

## UAT Scenarios
- UAT-1: {test file} — {scenario description}
  Steps: {Playwright steps}
  Validates: AC-1, AC-2
- UAT-2: ...

## Edge Cases
- EC-1: {scenario} — Expected: {behavior}

## Risks
- R-1: {risk} — Severity: {HIGH|MEDIUM|LOW} — Mitigation: {mitigation}
```

## Anti-Patterns

- Do NOT write vague ACs ("should work well")
- Do NOT skip the misinterpretation field — it prevents subtle bugs
- Do NOT design UAT tests that only check happy paths
- Do NOT ignore failure modes and edge cases
- Do NOT leave risks without severity ratings and mitigations
