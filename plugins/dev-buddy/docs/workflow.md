# Dev Buddy Workflow (v0.4.0 — Ralph Loop Architecture)

## Core Concepts

```
Stage Definition (.md) + Role Prompt (.md) + Preset + Model = Executor
Stage = collection of Executors (parallel dispatch, orchestrator synthesizes)
Ralph = 6 stages with two nested loops and multi-AI diversity
```

- **Stage Definitions** — 6 Ralph types (discovery, ralph-requirements, decomposition, ralph-build, ralph-code-review, ralph-uat) that define WHAT happens
- **Role Prompts** — Agent role definitions. Built-in (`system-prompts/built-in/*.md`) + custom (`~/.vcp/system-prompts/*.md`)
- **Executors** — Combinations of system_prompt + preset + model. Defined in `~/.vcp/dev-buddy.json`
- **Plan Files** — Claude Code's `~/.claude/plans/` for state management. Master plan + per-unit plans.
- **TaskManagement** — Structural enforcement that survives context compaction

## The Ralph Loop

```
DISCOVER ──> REQUIREMENTS ──> DECOMPOSE ──> BUILD ──> CODE REVIEW ──> UAT
                                              ^           |             |
                                              |           v             |
                                              +--- needs_changes -------+
                                              |                         |
                                              +------ fail (loop back) -+
```

### Inner Loop (BUILD)
Per unit of work:
1. Read unit plan file from disk (fresh context)
2. Dispatch single implementer executor
3. Orchestrator independently runs backpressure (tests, types, lint)
4. If pass: mark done, next unit
5. If fail: append failure details, retry with fresh context

### Review Gate (CODE REVIEW)
Multi-executor dispatch:
- Each reviewer independently traces ACs to code (file:line evidence)
- Orchestrator synthesizes findings
- Verdict: approved → UAT, needs_changes → back to BUILD, rejected → user

### Outer Loop (UAT)
1. Run Playwright UAT tests designed in requirements stage
2. Run all mechanical backpressure
3. If all pass: done
4. If fail: identify affected units, loop back to BUILD → CODE REVIEW → UAT

## Enforcement Stack

| Layer | Catches |
|-------|---------|
| Unit plan prompt | Intent drift |
| Mechanical backpressure | Compilation, type, lint errors |
| Orchestrator verify | Subagent false self-reports |
| Code review (multi-AI) | Semantic drift, integration gaps |
| UAT (Playwright) | Real user scenario failures |
| User checkpoint | Everything above missed |
| TaskManagement | Process compliance (no skipping) |
| Plan files on disk | State survival after compaction |

## State Management

No scattered files. Uses Claude Code's native `~/.claude/plans/` infrastructure.

- **Master plan:** `~/.claude/plans/ralph-{slug}.md` — status, discovery, requirements, units table, UAT results
- **Per-unit plans:** `~/.claude/plans/ralph-{slug}-unit-{N}.md` — implementation spec, attempts, backpressure
- **Progress tracking:** Master plan's "Units of Work" table is the status tracker
