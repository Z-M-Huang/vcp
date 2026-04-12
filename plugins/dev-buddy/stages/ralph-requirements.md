---
stage: ralph-requirements
description: Define acceptance criteria and design UAT scenarios through multi-AI debate
tools: Read, Glob, Grep
---

# Requirements + UAT Design Stage

## Mission

Define what "done" looks like — both as acceptance criteria AND as executable UAT scenarios. The UAT tests are designed HERE, before implementation begins (TDD-style).

## Requirements Approach: Focused Lenses

Each executor generates requirements through the lens of their system prompt role. This focuses each executor's perspective, making the task weak-model-compatible while ensuring diverse stakeholder coverage. Every discovery finding must be addressed — each executor covers ALL findings but goes deepest in their lens area.

**If you have a system prompt role**, focus your requirements generation on the perspective most relevant to your role:
- **security-engineer** → Security requirements: auth flows, input validation, data protection, error handling that doesn't leak info
- **compliance-auditor** → Compliance requirements: audit logging, data retention, access controls, consent flows
- **senior-developer / software-architect** → Functional requirements: core business logic, API contracts, integration points
- **ux-architect / ui-designer** → UX requirements: user flows, error messages, loading states, accessibility, visual feedback
- **data-engineer** → Data requirements: schema changes, migration paths, data integrity, idempotency, null handling
- **unit-builder** → Testability requirements: what makes each AC testable, concrete UAT steps, backpressure commands

**If you have no system prompt role**, cover all perspectives equally.

You MUST produce ALL output sections below, but go deepest in your assigned lens area.

## Mandatory Output Format

**The pipeline gate parser uses regex to detect ACs and UATs. If you deviate from these heading formats, the pipeline BLOCKS and your output is rejected.**

- ACs: `### AC-{N}: {title}` — H3 heading, sequential integer, colon after number
- UATs: `### UAT-{N}: {title}` — H3 heading, sequential integer, colon after number
- Do NOT use bold text (`**AC-1.1**`), bullets, workstream prefixes, or any other format
- Numbering is flat sequential (AC-1, AC-2, AC-3...), NOT grouped by workstream (AC-1.1, AC-1.2)
- Group by workstream using H2 headings above the ACs if needed, but each AC/UAT heading MUST match the regex `### AC-\d+:` / `### UAT-\d+:`

## What to Produce

### 1. Acceptance Criteria (Given/When/Then)
For each requirement, use this exact template:

```
### AC-{N}: {title}
- **Given:** {concrete precondition — specific page, state, data}
- **When:** {specific user action or system event}
- **Then:** {observable, testable outcome — what changes, what appears, what response}
- **Misinterpretation:** {a concrete wrong implementation that technically satisfies the words but misses the intent}
- **Partial implementation trap:** {a way this AC could appear "done" by building a component without connecting it to the rest of the system — e.g., creating a loader function but never calling it from the dispatch pipeline}
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
### Acceptance Criteria

### AC-1: {title}
- **Given:** {concrete precondition}
- **When:** {specific action}
- **Then:** {observable outcome}
- **Misinterpretation:** {wrong implementation that technically passes}
- **Partial implementation trap:** {appears done but not connected}
- **Discovery refs:** F-{X}
- **Edge cases:** {list}

### AC-2: {title}
...

### UAT Scenarios

### UAT-1: {title}
- **Validates:** AC-1, AC-2
- **Test file:** {path}
- **Steps:** {Playwright steps}
- **Assertions:** {specific checks}

### UAT-2: {title}
...

### Edge Cases
- EC-1: {scenario} — Expected: {behavior}

### Risks
- R-1: {risk} — Severity: {HIGH|MEDIUM|LOW} — Mitigation: {mitigation}
```

**CRITICAL:** ACs MUST use `### AC-N: {title}` H3 headings, NOT bullet points or bold text. UATs MUST use `### UAT-N: {title}` H3 headings. The pipeline gate parser requires this exact format.

## Contradiction Handling

If Discovery's Source of Truth Audit found contradictions:
1. List each contradiction at the top of your output
2. For each: state which source governs and why, using the precedence order below
3. Ensure ACs align with the governing source, NOT the contradicted one
4. If you cannot resolve a contradiction, FLAG it for the user checkpoint

### Source Precedence
When authoritative sources conflict:
`ADR > contract tests/specs > API docs/wiki > README/AGENTS.md`
If precedence does not resolve the conflict, escalate to user checkpoint.

## Anti-Patterns

- Do NOT write vague ACs ("should work well")
- Do NOT skip the misinterpretation field — it prevents subtle bugs
- Do NOT skip the partial implementation trap field — it prevents orphan code
- Do NOT design UAT tests that only check happy paths
- Do NOT ignore failure modes and edge cases
- Do NOT leave risks without severity ratings and mitigations
- Do NOT ignore contradictions from the Source of Truth Audit
- Do NOT drop or deprioritize discovery findings — every finding must map to at least one AC
- Do NOT reduce scope to make the task "manageable" or "focused" — if the scope is large, produce more ACs
