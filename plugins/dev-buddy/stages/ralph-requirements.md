---
stage: ralph-requirements
description: Define acceptance criteria and design UAT scenarios through multi-AI debate
tools: Read, Glob, Grep
---

# Requirements + UAT Design Stage

## Mission

Define what "done" looks like — both as acceptance criteria AND as executable UAT scenarios. The UAT tests are designed HERE, before implementation begins (TDD-style).

## Requirements Approach: Focused Lenses

Each executor generates requirements through the lens of their system prompt role. This narrows the scope per executor, making the task weak-model-compatible while ensuring diverse stakeholder coverage.

**If you have a system prompt role**, focus your requirements generation on the perspective most relevant to your role:
- **security-engineer** → Security requirements: auth flows, input validation, data protection, error handling that doesn't leak info
- **compliance-auditor** → Compliance requirements: audit logging, data retention, access controls, consent flows
- **senior-developer / software-architect** → Functional requirements: core business logic, API contracts, integration points
- **ux-architect / ui-designer** → UX requirements: user flows, error messages, loading states, accessibility, visual feedback
- **data-engineer** → Data requirements: schema changes, migration paths, data integrity, idempotency, null handling
- **unit-builder** → Testability requirements: what makes each AC testable, concrete UAT steps, backpressure commands

**If you have no system prompt role**, cover all perspectives equally.

You MUST produce ALL output sections below, but go deepest in your assigned lens area.

## What to Produce

### 1. Acceptance Criteria (Given/When/Then)
For each requirement, use this exact template:

```
### AC-{N}: {title}
- **Given:** {concrete precondition — specific page, state, data}
- **When:** {specific user action or system event}
- **Then:** {observable, testable outcome — what changes, what appears, what response}
- **Misinterpretation:** {a concrete wrong implementation that technically satisfies the words but misses the intent}
- **Discovery refs:** F-{X}, F-{Y}
- **Edge cases:** {list specific edge cases for this AC}
```

Be concrete. "User can log in" is too vague. "Given user on /login, When entering valid email+password and clicking Submit, Then redirect to /dashboard with session cookie set" is concrete.

### 2. Playwright UAT Scenarios
For each AC, design a concrete test scenario using this template:

```
### UAT-{N}: {title}
- **Validates:** AC-{X}, AC-{Y}
- **Test file:** {path}
- **Steps:** {numbered Playwright steps — goto, click, fill, etc.}
- **Assertions:** {specific checks — toBeVisible, toHaveText, toHaveURL, etc.}
```

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

## User Confirmation

Executor output is a DRAFT. The orchestrator confirms each item with the user individually before writing to the plan file:

1. ALL ACs are presented in batches of up to 4 per AskUserQuestion call — user reviews the entire set first
2. User is asked if additional ACs are needed
3. If any ACs need changes or additions → collect feedback, re-run the stage with history + feedback, present revised ACs from the start
4. Once all ACs are confirmed, same round-based flow for UAT scenarios
5. UAT changes only restart the UAT portion — confirmed ACs are locked

Only confirmed ACs and UAT scenarios are written to the plan. The user never needs to open the plan file — all interaction flows through AskUserQuestion.

## Anti-Patterns

- Do NOT write vague ACs ("should work well")
- Do NOT skip the misinterpretation field — it prevents subtle bugs
- Do NOT design UAT tests that only check happy paths
- Do NOT ignore failure modes and edge cases
- Do NOT leave risks without severity ratings and mitigations
