---
stage: discovery
description: Explore the codebase and running application to build deep understanding before any changes
tools: Read, Glob, Grep
---

# Discovery Stage

## Mission

Deeply understand the codebase AND the running application before doing anything. Your findings become the foundation for all subsequent stages.

## Exploration Approach: Focused Lenses

Each executor explores through the lens of their system prompt role. This focuses each executor's perspective, making it weak-model-compatible while ensuring broad coverage across all executors. Do not skip areas outside your lens — cover everything, but go deepest in your assigned area.

**If you have a system prompt role**, focus your exploration on the axis most relevant to your role:
- **security-engineer** → Security surface: auth flows, input validation, trust boundaries, secret handling, data exposure
- **compliance-auditor** → Compliance surface: data handling, logging, audit trails, access controls, PII exposure
- **senior-developer / software-architect** → Architecture: code paths, patterns, dependencies, module boundaries, API surface
- **ux-architect / ui-designer** → User experience: UI components, user flows, error states, accessibility, visual state
- **data-engineer** → Data flow: schemas, transformations, storage, migrations, null handling, data integrity
- **unit-builder** → Testability: existing tests, test patterns, coverage gaps, backpressure commands, CI setup

**If you have no system prompt role**, cover all areas equally.

You MUST still cover the full exploration checklist below, but prioritize and go deepest in your assigned lens area.

## Exploration Checklist

For each area, provide findings with file:line references. Every claim needs evidence.

### 1. Code Analysis
- Use Glob/Grep to find all files relevant to the feature request
- Trace code paths through the affected areas
- Identify existing patterns, utilities, and conventions
- Map the dependency graph of affected components
- Find reusable utilities that the implementation should use

### 2. Running App Analysis (if browser tools available)
- If Playwright MCP or Chrome DevTools is available: interact with the app
- Take screenshots of the current state of affected UI areas
- Understand current user flows that the feature will modify
- Document what exists visually before changes

### 3. Impact Analysis
- What existing functionality will this feature touch?
- What could break? Cite specific file:line references
- What integration points exist between affected components?
- What tests already cover the affected areas?

### 4. Pattern Documentation
- What architectural patterns does the project use?
- What naming conventions are in place?
- What testing patterns exist?
- What build/lint/type-check commands does the project use?

## Output Format

Structure your findings using this template. Every field must have concrete content with file:line citations — no vague descriptions.

```
### F-{N}: {finding title}
- **Area:** structure | app-behavior | test-infrastructure | error-handling
- **Lens:** {your system prompt role, or "general"}
- **Evidence:** {file:line references, code snippets, screenshots}
- **Impact:** {what this means for the feature implementation}
- **Reusable:** {existing functions/patterns the implementation should use, if any}
```

Also include a summary section:
1. **Relevant Files** — list of files with what each contains
2. **Code Paths** — how data/control flows through affected areas
3. **Existing Patterns** — conventions the implementation must follow
4. **Impact Points** — what could break, with evidence (file:line)
5. **Reusable Utilities** — existing functions/helpers the implementation should use
6. **Visual State** — screenshots or descriptions of current UI (if applicable)
7. **Backpressure Commands** — test/typecheck/lint/build commands for the project
8. **Source of Truth Contradictions** — conflicts between docs and code, or between docs

### 5. Source of Truth Audit
For the feature area, identify ALL authoritative documents:
- ADRs (Architecture Decision Records)
- Wiki pages defining behavior for the affected area
- API specifications, contract tests
- README/AGENTS.md institutional memory

For each source found, document:
- **Source:** {path or URL}
- **Relevant decision:** {what it says about the affected area}
- **Code alignment:** {does current code follow this? cite file:line}
- **Contradictions:** {where code and docs disagree, or where docs disagree with each other}

If no authoritative documents exist for the feature area, state that explicitly.

## Anti-Patterns

- Do NOT give vague high-level summaries
- Do NOT skip file:line citations — every claim needs evidence
- Do NOT assume patterns without verifying them in the code
- Do NOT ignore the running app if browser tools are available
- Do NOT speculate about what code does — read it and verify
- Do NOT skip the Source of Truth Audit when the project has ADRs, wiki, or specs
