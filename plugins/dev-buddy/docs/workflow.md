# Dev Buddy Workflow (v0.6.0)

Dev Buddy v0.6.0 has two Ralph paths:

- **Legacy Claude stage-skill path:** production path for full LLM-driven Ralph work today. Skills call `ralph-state-machine.ts`, `stage-runner.ts`, `plan-lint.ts`, and `build-loop-runner.ts`.
- **Cross-host MCP path:** skeleton path for Claude Code and Codex CLI. Tools (`ralph_start`, `ralph_next`, `ralph_list`, `ralph_health`) persist state and advance one skeleton step at a time under `.vcp/ralph/<run-id>/`.

## Core Concepts

```text
Stage Definition (.md) + Role Prompt (.md) + Preset + Model = Executor
Stage = ordered executor list with parallel groups and a final synthesizer
Ralph = six pipeline stages plus plan-lint and optional unit-review gates
```

- **Stage definitions:** `discovery`, `ralph-requirements`, `decomposition`, `ralph-build`, `ralph-code-review`, `ralph-uat`, plus `plan-lint` and optional `unit-review`.
- **Role prompts:** 7 built-ins (`discoverer`, `ralph-requirements-analyst`, `decomposer`, `unit-builder`, `unit-reviewer`, `ralph-code-reviewer`, `uat-evaluator`) plus custom prompts from `~/.vcp/system-prompts/*.md`.
- **Executors:** `system_prompt + preset + model`, configured in `~/.vcp/dev-buddy.json` v5.
- **Plan files:** legacy stage-skill state under `{PROJECT}/.vcp/plan/`.
- **MCP run state:** cross-host skeleton state under `{PROJECT}/.vcp/ralph/<run-id>/`.

## Legacy Stage-Skill Ralph Flow

```text
DISCOVER -> REQUIREMENTS+UAT -> DECOMPOSE -> PLAN-LINT -> BUILD -> CODE REVIEW -> UAT
   |              |                |                         ^          |
   v              v                v                         |          v
user gate      user gate        user gate       needs_changes +---- UAT failure
```

### Discovery / Requirements / Decomposition

The orchestrator queries `ralph-state-machine.ts --action next`, invokes `stage-runner.ts` for the current stage, validates the synthesized output, writes the stage section to the master plan, then pauses at a user checkpoint.

### Plan-Lint

`plan-lint.ts` validates the decomposition before build:
- Rejects units whose red tests already pass at HEAD.
- Rejects uncompilable test/backpressure commands.
- Checks entropy and required unit sections.

Plan-lint does not consume build attempts.

### Build Inner Loop

Per unit:

1. `build-loop-runner.ts --unit N` starts the unit loop.
2. BLR calls `ralph/build-actions.ts:composeBuildDispatch`, which seeds state if needed, reserves an attempt, and returns the build prompt.
3. BLR dispatches `stage-runner.ts --stage-type ralph-build`.
4. BLR runs mechanical backpressure and `contract-verifier.ts`.
5. BLR calls `recordAttemptResultAction`.
6. If `unit-review` has executors, BLR dispatches `stage-runner.ts --stage-type unit-review --unit N`, then records the result with `recordReviewResultAction`.
7. BLR streams JSON events and exits with `done`, `failed`, or `stuck`.

All dynamic per-unit state is persisted in `.vcp/plan/.state/ralph-{slug}/units/unit-N.json`. `unit-N.md` stays immutable after decomposition.

### Review Gate

`ralph-code-review` reviewers trace acceptance criteria at point, path, and intent levels. The synthesized verdict is:

- `approved` -> UAT
- `needs_changes` -> build loop
- `rejected` -> user escalation

### UAT Outer Loop

`ralph-uat` runs Playwright scenarios and full mechanical backpressure. Failures identify affected units and return to build/review until `max_outer_iterations` is reached.

## State Layout

Legacy stage-skill state:

```text
{PROJECT}/.vcp/plan/
├── ralph-{slug}.md
├── ralph/{slug}/unit-N.md
└── .state/ralph-{slug}/
    ├── plan.json
    ├── units/unit-N.json
    └── progress/stage-progress-*.json
```

MCP skeleton state:

```text
{PROJECT}/.vcp/ralph/<run-id>/
├── state.json
├── lease.json
├── events.jsonl
└── subprocess-stderr/
```

## Enforcement Stack

| Layer | Catches |
|-------|---------|
| Unit plan + contracts | Intent drift, missing wiring, wrong source of truth |
| Plan-lint | Already-satisfied tests, uncompilable tests, invalid unit shape |
| Mechanical backpressure | Compilation, type, lint, and test errors |
| Contract verifier | Missing exports, wrong signatures, broken declared interfaces |
| Optional unit-review | Per-unit AC drift after mechanical pass |
| Orchestrator verification | False self-reports and missing required sections |
| Multi-AI code review | Semantic drift, integration gaps, orphan code |
| UAT | Real user scenario failures |
| User checkpoints | Product/intent mismatch |
| Disk-backed JSON state | Context compaction and process restart survival |
