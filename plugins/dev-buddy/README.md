<div align="center">

# Dev Buddy

**Break the AI echo chamber. Ship secure code.**

![Skills-12](https://img.shields.io/badge/Skills-12-blue?style=flat-square)
![Stages-6](https://img.shields.io/badge/Stages-6-green?style=flat-square)
![Role Prompts-6](https://img.shields.io/badge/Role%20Prompts-6-purple?style=flat-square)

<img src="../../assets/hero.png" alt="Dev Buddy — Multi-AI Pipeline Orchestration" width="700">

</div>

---

## The Problem

<div align="center">
<img src="../../assets/echo-chamber.png" alt="The Echo Chamber Problem" width="800">
</div>

When one AI writes your code and the same AI reviews it, you get a rubber stamp — not a review. Same-family models share training biases, architectural lineage, and blind spots. They miss the same classes of bugs. Every time.

---

## The Solution

<div align="center">
<img src="../../assets/pipeline.png" alt="Multi-AI Pipeline" width="800">
</div>

Dev Buddy routes code through **independent AI reviewers** from different providers — with task-based enforcement that prevents skipping stages. Each reviewer operates independently. No shared context between reviewers. No rubber stamps.

---

## Real Pipeline in Action

<div align="center">
<img src="../../assets/real-screenshot.png" alt="5 concurrent reviews across MiniMax, Qwen, Kimi, GLM, Codex" width="800">
</div>

*5 concurrent reviews across MiniMax, Qwen, Kimi, GLM, Codex — each operating independently with no shared context.*

---

## Pipelines

Pipelines are user-defined sequences of stages. Create any pipeline you need — the two defaults ship out of the box, but you can define your own via the web portal (`/dev-buddy-config`) or JSON config.

### Default Pipelines

**`feature`** — Feature Development

```
Requirements + TDD → Planning → Plan Reviews → Implementation → Code Reviews
```

**`bug-fix`** — Bug Fix

```
Root Cause Analysis → Requirements + TDD → Planning → Plan Reviews → Implementation → Code Reviews
```

All phases append to a **single plan file** — no scattered artifact files.

### Stage Types

| Stage | What Happens |
|-------|-------------|
| **Requirements + TDD** | Gather requirements with pessimistic-first impact analysis. Generate TDD test plans (unit, e2e, skill tests) BEFORE planning. Build risk registry with user acknowledgment. |
| **Planning** | Create granular implementation steps mapped to ACs and test IDs. Each step is one architectural unit with rollback. Reuse existing code — KISS architecture. |
| **Plan Reviews** | Assume nothing works. Verify every AC has steps AND tests. Flag coverage gaps, missing rollbacks, unnecessary code creation. Includes false-positive analysis and user confirmation checkpoints. |
| **Implementation** | TDD loop per step with TaskManagement progress tracking. Run mapped tests before and after each step. Fully autonomous — no user prompts. |
| **Code Reviews** | Assume every change has a bug. Verify each AC with file:line evidence. Trace input → processing → output. Includes false-positive analysis and user confirmation checkpoints. |
| **Root Cause Analysis** | Multiple independent analyzers investigate the bug with pessimistic tracing (ask "why" five times, cite file:line evidence) |

### Custom Pipelines

Define any pipeline as an ordered array of stage types. Pipeline names must match `/^[a-z0-9][a-z0-9-]*$/` (max 50 characters). Manage pipelines via the web portal — create, rename, and delete with full CRUD support.

---

## Cross-AI Review Gates

Different AI models review each other's work at each phase:

```
Claude Opus plans ──→ Claude Sonnet reviews ──→ Claude Opus reviews ──→ Codex reviews
                                                                            │
                      Claude Sonnet implements ◀────────────────────────────┘
                            │
                      Claude Sonnet reviews ──→ Claude Opus reviews ──→ Codex reviews
```

Each review is independent — reviewers don't see each other's verdicts.

### Why Task-Based Enforcement Matters

| Instruction-Based (fragile) | Task-Based (Dev Buddy) |
|-----------------------------|------------------------|
| "Run Sonnet → Opus → Codex" | `blockedBy` prevents Codex until Opus completes |
| AI can skip "redundant" steps | `TaskList()` only shows unblocked tasks |
| No audit trail | Complete task history with metadata |
| Hidden progress | Real-time task progress visible to user |

---

## Team-Based Requirements

The feature pipeline spawns 5 specialist agents that explore your codebase in parallel before a single line of code is planned:

| Specialist | Focus |
|------------|-------|
| Technical Analyst | Existing codebase, patterns, dependencies, files to modify |
| UX/Domain Analyst | User workflows, edge cases, accessibility |
| Security Analyst | Threat model, OWASP relevance, non-functional security requirements |
| Performance Analyst | Load impact, scalability, bottlenecks, caching |
| Architecture Analyst | Design patterns, SOLID principles, maintainability |

Their findings inform requirements gathering — producing richer, more complete specifications from the start.

---

## Configurable Pipeline

<div align="center">
<img src="../../assets/dev-buddy-pipeline.png" alt="Configurable Pipeline" width="800">
</div>

The config (`~/.vcp/dev-buddy.json`, version `4.0`) stores pipelines under a `pipelines` map — each key is a pipeline name, each value is an ordered array of stages. Each stage specifies a type, provider, and model. Add, remove, or reorder stages. Swap AI providers per stage — API presets support both **Anthropic-compatible** and **OpenAI-compatible** endpoints via the `protocol` field.

Use the web portal (`/dev-buddy-config`) or edit JSON directly. The portal supports full CRUD for pipelines — create, rename, and delete.

<details>
<summary><strong>Example: config v4.0 with custom pipelines</strong></summary>

```json
{
  "version": "4.0",
  "pipelines": {
    "feature": [
      { "type": "requirements", "provider": "anthropic-subscription", "model": "opus" },
      { "type": "planning", "provider": "anthropic-subscription", "model": "opus" },
      { "type": "plan-review", "provider": "anthropic-subscription", "model": "sonnet" },
      { "type": "plan-review", "provider": "anthropic-subscription", "model": "opus" },
      { "type": "plan-review", "provider": "my-codex-preset", "model": "o3" },
      { "type": "implementation", "provider": "anthropic-subscription", "model": "sonnet" },
      { "type": "code-review", "provider": "anthropic-subscription", "model": "sonnet" },
      { "type": "code-review", "provider": "anthropic-subscription", "model": "opus" },
      { "type": "code-review", "provider": "my-codex-preset", "model": "o3" }
    ],
    "bug-fix": [
      { "type": "rca", "provider": "anthropic-subscription", "model": "opus" },
      { "type": "requirements", "provider": "anthropic-subscription", "model": "opus" },
      { "type": "planning", "provider": "anthropic-subscription", "model": "opus" },
      { "type": "plan-review", "provider": "anthropic-subscription", "model": "sonnet" },
      { "type": "implementation", "provider": "anthropic-subscription", "model": "sonnet" },
      { "type": "code-review", "provider": "anthropic-subscription", "model": "sonnet" }
    ]
  }
}
```

</details>

---

## Quick Start

```bash
# Install Dev Buddy
/plugin install vcp@dev-buddy

# Run any pipeline by name
/dev-buddy-run feature Add user authentication with JWT
/dev-buddy-run bug-fix Login fails when email contains a plus sign

# Deprecated aliases (will be removed in a future release):
# /dev-buddy-feature-implement → use /dev-buddy-run feature
# /dev-buddy-bug-fix → use /dev-buddy-run bug-fix

# Configure pipelines, stages, and providers via web portal
/dev-buddy-config
```

---

## Skills Reference

| Skill | Command | Description |
|-------|---------|-------------|
| Run Pipeline | `/dev-buddy-run <pipeline-name>` | Generic pipeline runner — runs any user-defined pipeline by name |
| Feature Implement | `/dev-buddy-feature-implement` | **Deprecated** — use `/dev-buddy-run feature` |
| Bug Fix | `/dev-buddy-bug-fix` | **Deprecated** — use `/dev-buddy-run bug-fix` |
| Plan | `/dev-buddy-plan` | Create granular implementation steps from plan file. Each step mapped to ACs and test IDs with KISS architecture |
| Review | `/dev-buddy-review` | Review plan (`--plan`) or code (`--code`). Pessimistic-first with false-positive analysis and user confirmation checkpoints |
| Implement | `/dev-buddy-implement` | TDD implementation with TaskManagement tracking. Fully autonomous — no user prompts |
| Requirements | `/dev-buddy-requirements` | Requirements + TDD test plans + risk registry. Pessimistic-first impact analysis |
| RCA | `/dev-buddy-rca` | Root cause analysis with evidence-based diagnosis. Appends to plan file |
| Once | `/dev-buddy-once` | Run a single task using a specific AI provider and model |
| Config | `/dev-buddy-config` | Web portal for managing executors, stages, pipelines, system prompts, and settings |
| Manage Presets | `/dev-buddy-manage-presets` | List, add, update, or remove AI provider presets |
| Chatroom | `/dev-buddy-chatroom` | PK Stage — multi-AI competitive debate with iterative consensus |

## Agents Reference

| Agent | Role |
|-------|------|
| requirements-gatherer | Synthesizes specialist findings into complete specifications |
| planner | Designs implementation plans from requirements and codebase analysis |
| plan-reviewer | Reviews plans for completeness, correctness, and security |
| implementer | Executes plans with subtask creation and task-based dependencies |
| code-reviewer | Reviews code for security, architecture, quality, and correctness |
| root-cause-analyst | Investigates bugs to identify root cause vs. symptoms |
| cli-executor | Executes CLI-based reviews using preset templates |

## Hooks Reference

| Hook | Trigger | Description |
|------|---------|-------------|
| guidance-hook | UserPromptSubmit | Injects pipeline guidance into user prompts |
| *(Review validation is handled by `cli-executor.ts` and `dev-buddy-review` SKILL.md)* | | |

---

## Prerequisites

- **[Bun](https://bun.sh/)** — Required for hook execution
- **[Claude Code](https://code.claude.com/)** — The AI coding assistant

---

## Documentation

Full documentation is on the **[VCP Wiki](https://github.com/Z-M-Huang/vcp/wiki)**:

- **[Dev Buddy Quick Start](https://github.com/Z-M-Huang/vcp/wiki/Dev-Buddy-Quick-Start)** — Installation, first pipeline run
- **[Dev Buddy Configuration](https://github.com/Z-M-Huang/vcp/wiki/Dev-Buddy-Configuration)** — Pipeline stages, providers, models
- **[Feature Pipeline](https://github.com/Z-M-Huang/vcp/wiki/Dev-Buddy-Feature-Pipeline)** — Team-based requirements, plan reviews, code reviews
- **[Bug Fix Pipeline](https://github.com/Z-M-Huang/vcp/wiki/Dev-Buddy-Bug-Fix-Pipeline)** — RCA, consolidation, minimal fix
- **[AI Provider Presets](https://github.com/Z-M-Huang/vcp/wiki/Dev-Buddy-AI-Provider-Presets)** — Subscription, API, and CLI presets
- **[Agents Reference](https://github.com/Z-M-Huang/vcp/wiki/Dev-Buddy-Agents-Reference)** — All 8 agent types
- **[Dev Buddy Hooks](https://github.com/Z-M-Huang/vcp/wiki/Dev-Buddy-Hooks-Reference)** — Guidance hook and review validator

---

## License

[Apache License 2.0](../../LICENSE.md)
