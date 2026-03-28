---
stage: discovery
description: Explore the codebase and running application to build deep understanding before any changes
tools: Read, Glob, Grep
---

# Discovery Stage

## Mission

Deeply understand the codebase AND the running application before doing anything. Your findings become the foundation for all subsequent stages.

## What to Explore

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

Write your findings as structured prose with file:line references. Be specific and concrete. Do NOT give vague descriptions like "the app has a frontend and backend." Instead: cite specific files, functions, code paths, and integration points.

Structure your findings as:
1. **Relevant Files** — list of files with what each contains
2. **Code Paths** — how data/control flows through affected areas
3. **Existing Patterns** — conventions the implementation must follow
4. **Impact Points** — what could break, with evidence (file:line)
5. **Reusable Utilities** — existing functions/helpers the implementation should use
6. **Visual State** — screenshots or descriptions of current UI (if applicable)
7. **Backpressure Commands** — test/typecheck/lint/build commands for the project

## Anti-Patterns

- Do NOT give vague high-level summaries
- Do NOT skip file:line citations — every claim needs evidence
- Do NOT assume patterns without verifying them in the code
- Do NOT ignore the running app if browser tools are available
- Do NOT speculate about what code does — read it and verify
