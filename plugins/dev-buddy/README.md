<div align="center">

# Dev Buddy

**Break the AI echo chamber. Ship correct features.**

![Skills-10](https://img.shields.io/badge/Skills-10-blue?style=flat-square)
![Stages-6](https://img.shields.io/badge/Stages-6-green?style=flat-square)
![Role Prompts-6](https://img.shields.io/badge/Role%20Prompts-6-purple?style=flat-square)

<img src="../../assets/hero.png" alt="Dev Buddy — Multi-AI Pipeline Orchestration" width="700">

</div>

---

## The Problem

When one AI writes your code and the same AI reviews it, you get a rubber stamp. Same-family models share training biases and blind spots. Mechanical backpressure (tests, types, lint) catches compilation errors but not semantic drift — when code technically works but doesn't match intent.

---

## The Solution: Ralph Loop Architecture

Dev Buddy implements a **Ralph loop** workflow ([Ralph Wiggum technique](https://ghuntley.com/ralph/)) — fresh context per iteration, specs on disk, iterate until correct.

```mermaid
---
config:
  flowchart:
    curve: linear
---
flowchart TD
    START(["/dev-buddy-ralph"]) --> INIT["Create plan file + stage tasks"]
    INIT --> Q1

    Q1[["CC → Bash: ralph-state-machine.ts --action next<br/>⬇ JSON: next action + state"]]

    Q1 -->|"invoke_skill: discover"| D
    D["DISCOVER — multi-AI executors<br/>🔧 CC → Bash: stage-runner.ts"]
    D --> D_VAL{"Adversarial<br/>validation<br/>🔧 CC validates<br/>synthesis"}
    D_VAL -->|fail, retries left| D
    D_VAL -->|pass / exhausted| D_UC{"User<br/>Checkpoint<br/>🔧 CC → AskUser"}
    D_UC -->|Approve| Q1
    D_UC -->|Reject / Context| D

    Q1 -->|"invoke_skill: requirements"| R
    R["REQUIREMENTS + UAT — multi-AI executors<br/>🔧 CC → Bash: stage-runner.ts"]
    R --> R_VAL{"Adversarial<br/>validation<br/>6 backpressure gates"}
    R_VAL -->|fail, retries left| R
    R_VAL -->|pass / exhausted| R_UC{"User<br/>Checkpoint"}
    R_UC -->|Approve| Q1
    R_UC -->|Reject / Context| R

    Q1 -->|"invoke_skill: decompose"| DC
    DC["DECOMPOSE — multi-AI executors<br/>🔧 CC → Bash: stage-runner.ts"]
    DC --> DC_VAL{"Adversarial<br/>validation<br/>+ section check"}
    DC_VAL -->|fail, retries left| DC
    DC_VAL -->|pass / exhausted| DC_UC{"User<br/>Checkpoint"}
    DC_UC -->|Approve| Q1
    DC_UC -->|Reject / Context| DC

    Q1 -->|"invoke_skill: ralph-build<br/>(per unit)"| BUILD_ENTRY

    subgraph BUILD_MECHANICAL["build-loop-runner.ts --unit N — retry loop per unit"]
        BUILD_ENTRY["CC → Bash: build-loop-runner.ts --unit N"]
        B_DISPATCH["subprocess: stage-runner.ts<br/>⟶ configured executor"]
        B_BP{"spawnSync: backpressure<br/>test, typecheck, lint"}
        B_REVIEW{"unit-review<br/>configured?"}
        B_WRITE_PASS["Write Status: done"]
        B_RETRY["Write Status: pending<br/>(retry)"]
        B_FAILED["Write Status: failed"]

        BUILD_ENTRY --> B_DISPATCH
        B_DISPATCH --> B_BP
        B_BP -->|pass| B_REVIEW
        B_REVIEW -->|"skip / PASS"| B_WRITE_PASS
        B_REVIEW -->|"NEEDS_CHANGES,<br/>attempts left"| B_RETRY
        B_REVIEW -->|"NEEDS_CHANGES,<br/>exhausted"| B_FAILED
        B_BP -->|fail, attempts left| B_RETRY
        B_RETRY --> B_DISPATCH
        B_BP -->|fail, exhausted| B_FAILED
    end

    B_WRITE_PASS -->|"JSON: unit_done"| Q1
    B_FAILED -->|"JSON: unit_failed"| Q1

    Q1 -->|"invoke_skill: review"| CR
    CR["CODE REVIEW — multi-AI flow tracing<br/>🔧 CC → Bash: stage-runner.ts"]
    CR -->|approved| Q1
    CR -->|needs_changes| Q1
    CR -->|rejected| STOP([Escalate to User])

    Q1 -->|"invoke_skill: uat"| UAT
    UAT["UAT — Playwright + full backpressure<br/>🔧 CC → Bash: stage-runner.ts"]
    UAT -->|all pass| DONE([Done])
    UAT -->|any fail| Q1
```

```mermaid
sequenceDiagram
    actor User
    participant CC as CC Main Process<br/>(LLM / Ralph skill)
    participant SM as ralph-state-<br/>machine.ts
    participant SR as stage-runner.ts
    participant BLR as build-loop-<br/>runner.ts
    participant EX as Configured<br/>Executors
    participant FS as Plan + Unit<br/>Files on Disk

    Note over CC: /dev-buddy-ralph <feature>
    CC->>FS: Write plan file (Status: discover)

    rect rgb(230, 240, 255)
        Note over CC,EX: DISCOVER / REQUIREMENTS / DECOMPOSE (same pattern × 3)
        CC->>SM: Bash: --plan X --action next
        SM->>FS: Read plan + state
        SM-->>CC: JSON: {actions: [invoke_skill(stage)]}
        CC->>SR: Bash: --stage-type <stage> --task-stdin
        SR->>EX: Dispatch parallel/sequential executors
        EX-->>SR: Per-executor outputs
        SR-->>CC: JSON: {synthesis, worker_outputs[]}
        CC->>CC: Validate synthesis (adversarial)
        CC->>FS: Write stage section + Status: X-review
        CC->>SM: Bash: --action next
        SM-->>CC: JSON: {user_checkpoint, approveStatus}
        Note over CC: Stage skill already got user approval.<br/>Auto-advance (no re-ask).
        CC->>FS: Write approveStatus to plan
    end

    rect rgb(255, 235, 220)
        Note over CC,FS: BUILD — per-unit dispatch, retries internal to runner
        loop For each unit (CC drives via state machine)
            CC->>SM: Bash: --action next
            SM-->>CC: JSON: {invoke_skill(ralph-build, unitId, unitPath)}
            CC->>CC: TaskUpdate(unit N → in_progress)
            CC->>BLR: Bash: --plan X --cwd Y --unit N
            loop Retry loop (mechanical, inside runner)
                BLR->>FS: writeRunnerTail({status: pending, attempts++})
                BLR->>SR: subprocess: --stage-type ralph-build --task-stdin<br/>(prompt = STATIC PLAN + [PRIOR MECHANICAL FAILURE] + PRIOR REVIEW FEEDBACK + INSTRUCTION)
                SR->>EX: Dispatch configured build executor
                EX-->>SR: Implementation result
                SR-->>BLR: JSON: {synthesis}
                BLR->>BLR: runBackpressure(commands, cwd)
                alt all backpressure pass
                    opt unit-review configured
                        BLR->>SR: subprocess: --stage-type unit-review --task-stdin
                        SR->>EX: Dispatch reviewer executor(s)
                        EX-->>SR: Review verdict
                        SR-->>BLR: JSON: {synthesis: PASS|NEEDS_CHANGES}
                        Note over BLR: Fail-closed parsing: malformed output → NEEDS_CHANGES
                        alt NEEDS_CHANGES + attempts remain
                            BLR->>FS: writeRunnerTail({reviewFeedback, status: pending})
                        end
                    end
                    BLR->>FS: writeRunnerTail({status: done, reviewFeedback: ''})
                else fail + attempts remain
                    Note over BLR: Carry mechanicalContext in-memory for next attempt's dispatch prompt
                    BLR->>FS: writeRunnerTail({status: pending, latestAttempt})
                else fail + exhausted
                    BLR->>FS: writeRunnerTail({status: failed, latestAttempt})
                end
            end
            BLR-->>CC: JSON: {event: unit_done|unit_failed}
            CC->>CC: TaskUpdate(unit N → completed|failed)
        end
    end

    CC->>SM: Bash: --action next

    rect rgb(220, 245, 220)
        Note over CC,EX: CODE REVIEW
        SM-->>CC: JSON: {invoke_skill(review)}
        CC->>SR: Bash: --stage-type ralph-code-review
        SR->>EX: Dispatch reviewer executors
        EX-->>SR: Verdict + AC tracing
        SR-->>CC: JSON: {synthesis: approved|needs_changes}
    end

    alt verdict = needs_changes
        CC->>SM: Bash: --action next
        SM-->>CC: JSON: {write_plan(review→build)}
        CC->>FS: Apply write_plan edits
        Note over CC: Re-enters build loop via SM query
    else verdict = approved
        rect rgb(240, 230, 250)
            Note over CC,EX: UAT
            CC->>SM: Bash: --action next
            SM-->>CC: JSON: {invoke_skill(uat)}
            CC->>SR: Bash: --stage-type ralph-uat
            SR->>EX: Execute Playwright tests
            EX-->>SR: Test results (pass/fail per UAT)
            SR-->>CC: JSON: {synthesis}
        end
    end

    alt all UATs pass
        CC->>SM: Bash: --action next
        SM-->>CC: JSON: {write_plan(uat→done), done}
        CC->>FS: Apply write_plan
        CC-->>User: Pipeline complete
    else any UAT fail
        CC->>SM: Bash: --action next
        SM-->>CC: JSON: {write_plan(uat→build)}
        CC->>FS: Apply write_plan
        Note over CC: Re-enters build loop via SM query
    end
```

**Mechanical failure context:** on a non-zero exit from dispatch or backpressure, the runner captures stdout+stderr head+tail excerpts (≤1000 chars each, verbatim) and carries them in-memory into the next attempt within the same `runSingleUnit` invocation. The retry's dispatch prompt includes a `--- PRIOR MECHANICAL FAILURE ---` block so the executor can restore the green state before pursuing semantic changes. Excerpts are not persisted across process restarts — a mid-unit crash loses the mechanical context (review feedback survives via the unit-file tail).

**Script enforcement boundaries:**
- **ralph-state-machine.ts** (passive) — Computes next action when queried. CC calls it via Bash before every stage transition. Reads plan + unit files, returns JSON with the next action. Never drives execution.
- **stage-runner.ts** (dispatch) — Multi-executor dispatcher. CC calls it via Bash for all stages. Loads config, resolves system prompts, spawns executors (subscription/API/CLI), synthesizes outputs.
- **build-loop-runner.ts** (single-unit executor) — Owns single-unit execution with internal retries. CC calls it per unit via Bash with `--unit N`; it retries internally: dispatches executor (subprocess to stage-runner), runs backpressure (spawnSync), optional semantic review (subprocess to stage-runner with unit-review), writes unit status (fs). Returns JSON when the unit is done or failed.
- **CC Main Process** (LLM) — Drives the pipeline: queries SM, invokes scripts, validates synthesis, presents user checkpoints, updates tasks. Drives unit-to-unit build progression via state machine queries and task management.

**Task-board projection:** the CC orchestrator creates one task per stage with `blockedBy` chaining, then (post-decompose) registers a unit task per decomposition unit with `blockedBy` mirroring the unit DAG. Bulk registration happens via `ralph-state-machine.ts --action register-task-graph` (single atomic state write). `--action verify-task-graph` warns on drift at every subsequent build-stage `next` query without blocking execution — unit-file `dependsOn` remains authoritative for build ordering; the task board is a human-visibility projection of that DAG.

**Two nested loops + review gate:**
- **Inner (BUILD -> CODE REVIEW):** per-unit Ralph loop — fresh context from disk, implement, mechanical backpressure (test/typecheck/lint), optional per-unit semantic review, retry up to `max_build_attempts`. Code review can send units back for rework. Per-unit retry loop is fully mechanical via `build-loop-runner.ts --unit N`. Unit-to-unit progression is driven by the CC orchestrator via state machine queries and task management.
- **Outer (UAT):** integration Ralph loop — real Playwright UAT against running app. Failures identify affected units and loop back through BUILD and CODE REVIEW (up to `max_outer_iterations`).
- **User checkpoints** after Discovery, Requirements, and Decompose — approve, reject, or provide additional context. Each stage runs internal adversarial validation before presenting to the user.

---

## The 6 Stages

| Stage | What Happens | Multi-AI |
|-------|-------------|----------|
| **Discovery** | Explore codebase + running app. Map code paths, patterns, impact points. Screenshot current state. | Yes |
| **Requirements + UAT** | Define ACs (Given/When/Then + misinterpretation). Design Playwright UAT scenarios. Risk registry. | Yes |
| **Decomposition** | Break into ~50 LOC units. Each unit gets its own plan file with precise instructions. | Yes |
| **Build** | Per-unit implementation with fresh context. Runner runs backpressure + optional semantic review. | Configurable |
| **Code Review** | Flow tracing (point + path + intent). Stub/orphan detection. Cross-unit integration. | Yes |
| **UAT** | Execute Playwright tests + all mechanical backpressure against running app. | Single |

---

## The 9-Layer Enforcement Stack

```
Layer 1: Unit plan + contracts     <- intent, data flow traces, authoritative sources
Layer 2: Mechanical backpressure   <- compilation, types, lint errors
Layer 3: Per-unit semantic review  <- AC tracing, contract verification (optional, multi-AI)
Layer 4: Orchestrator verify       <- subagent lies, missing sections, source violations
Layer 5: Code review (multi-AI)    <- flow tracing, stub detection, drift probe
Layer 6: UAT (Playwright)          <- real user scenario failures
Layer 7: User checkpoint           <- everything above missed
Layer 8: TaskManagement            <- process compliance (no skipping)
Layer 9: Plan files on disk        <- state survival after compaction
```

Each layer catches what the layers above missed. With weaker models, more layers fire. With stronger models, most pass through cleanly.

---

## Quick Start

```bash
# Install Dev Buddy
/plugin install vcp@dev-buddy

# Run the Ralph workflow
/dev-buddy-ralph Add user authentication with JWT

# Configure via web portal
/dev-buddy-config

# Multi-AI debate on any topic
/dev-buddy-chatroom Should we use REST or GraphQL?

# Run a single task with a specific AI
/dev-buddy-once --preset openai-api --model gpt-5.4 "Review auth middleware"
```

---

## Skills Reference

| Skill | Command | Description |
|-------|---------|-------------|
| Ralph | `/dev-buddy-ralph <description>` | Full pipeline orchestrator — chains all 6 stages with loop logic |
| Discover | `/dev-buddy-discover` | Discovery stage — multi-AI codebase and running app exploration |
| Requirements | `/dev-buddy-requirements` | Requirements + UAT design — acceptance criteria and test scenarios |
| Decompose | `/dev-buddy-decompose` | Decomposition — break features into small units of work |
| Build | `/dev-buddy-build` | Build stage — per-unit implementation with backpressure |
| Code Review | `/dev-buddy-code-review` | Code review — multi-AI semantic drift detection |
| UAT | `/dev-buddy-uat` | UAT stage — execute tests against the running app |
| Chatroom | `/dev-buddy-chatroom <topic>` | Multi-AI competitive debate with iterative consensus |
| Once | `/dev-buddy-once` | Run a single task using a specific AI provider and model |
| Config | `/dev-buddy-config` | Web portal for managing stages, presets, system prompts, and settings |

Each stage skill works standalone (reads existing plan files) or as part of the `/dev-buddy-ralph` pipeline.

## Agents Reference

| Agent | Stage | Role |
|-------|-------|------|
| discoverer | Discovery | Codebase + app explorer |
| ralph-requirements-analyst | Requirements | AC + UAT designer |
| decomposer | Decomposition | Task breakdown specialist |
| unit-builder | Build | Focused unit implementer |
| unit-reviewer | Build (review) | Per-unit AC verifier (optional) |
| ralph-code-reviewer | Code Review | Semantic drift detector |
| uat-evaluator | UAT | Pessimistic test executor |

---

## Configuration

The config (`~/.vcp/dev-buddy.json`, version `5.0`) stores:
- **Stages:** Per-stage executor assignments (system prompt + preset + model)
- **Pipeline:** Ralph pipeline (6 stages in fixed order)
- **Settings:** config_port, max_iterations, max_build_attempts, max_outer_iterations, max_discovery_iterations, max_requirements_iterations, max_decomposition_iterations, theme

Use the web portal (`/dev-buddy-config`) or edit JSON directly.

<details>
<summary><strong>Example: config v5.0</strong></summary>

```json
{
  "version": "5.0",
  "stages": {
    "discovery": { "executors": [
      { "system_prompt": "discoverer", "preset": "anthropic-subscription", "model": "sonnet", "parallel": true },
      { "system_prompt": "discoverer", "preset": "openai-api", "model": "o3", "parallel": true }
    ]},
    "ralph-requirements": { "executors": [
      { "system_prompt": "ralph-requirements-analyst", "preset": "anthropic-subscription", "model": "opus" }
    ]},
    "decomposition": { "executors": [
      { "system_prompt": "decomposer", "preset": "anthropic-subscription", "model": "opus" }
    ]},
    "ralph-build": { "executors": [
      { "system_prompt": "unit-builder", "preset": "anthropic-subscription", "model": "sonnet" }
    ]},
    "ralph-code-review": { "executors": [
      { "system_prompt": "ralph-code-reviewer", "preset": "anthropic-subscription", "model": "sonnet", "parallel": true },
      { "system_prompt": "ralph-code-reviewer", "preset": "openai-api", "model": "o3", "parallel": true }
    ]},
    "ralph-uat": { "executors": [
      { "system_prompt": "uat-evaluator", "preset": "anthropic-subscription", "model": "sonnet" }
    ]},
    "unit-review": { "executors": [] }
  },
  "pipelines": { "ralph": ["discovery", "ralph-requirements", "decomposition", "ralph-build", "ralph-code-review", "ralph-uat"] },
  "config_port": 8888,
  "max_iterations": 10,
  "max_build_attempts": 3,
  "max_outer_iterations": 3,
  "max_discovery_iterations": 3,
  "max_requirements_iterations": 3,
  "max_decomposition_iterations": 2
}
```

</details>

### Migration from v0.3.x

Configs auto-migrate on first load. Old stage types map to Ralph equivalents:

| Old Stage | New Stage |
|-----------|-----------|
| requirements | ralph-requirements |
| planning | decomposition |
| plan-review | discovery |
| implementation | ralph-build |
| code-review | ralph-code-review |
| rca | discovery |

Presets and models are preserved. Old pipelines are replaced with the `ralph` pipeline.

---

## Prerequisites

- **[Bun](https://bun.sh/)** - Required for hook execution
- **[Claude Code](https://code.claude.com/)** - The AI coding assistant

---

## Documentation

Full documentation is on the **[VCP Wiki](https://github.com/Z-M-Huang/vcp/wiki)**.

---

## License

[Apache License 2.0](../../LICENSE.md)
