<div align="center">

# Dev Buddy

**Break the AI echo chamber. Ship secure code.**

![Skills-6](https://img.shields.io/badge/Skills-6-blue?style=flat-square)
![Agents-8](https://img.shields.io/badge/Agents-8-green?style=flat-square)
![Hooks-2](https://img.shields.io/badge/Hooks-2-orange?style=flat-square)

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

## Two Pipelines

### Feature Development

```
Requirements → Planning → Plan Reviews → Implementation → Code Reviews
```

| Stage | What Happens |
|-------|-------------|
| **Requirements** | 5 specialist agents explore your codebase in parallel, then a requirements gatherer synthesizes their findings into a complete specification |
| **Planning** | A planner designs the implementation based on requirements and codebase analysis |
| **Plan Reviews** | Multiple independent AI models review the plan — each without seeing others' verdicts |
| **Implementation** | An implementer executes the plan, creating subtasks with task-based dependencies |
| **Code Reviews** | Multiple independent AI models review the code for security, architecture, and quality |

### Bug Fix

```
Root Cause Analysis → Validation → Implementation → Code Reviews
```

| Stage | What Happens |
|-------|-------------|
| **Root Cause Analysis** | Multiple independent analyzers investigate the bug, each producing an RCA |
| **Validation** | A consolidator synthesizes all RCAs and validates the root cause |
| **Implementation** | A developer applies the minimal fix at the correct level |
| **Code Reviews** | Multiple independent AI models verify the fix addresses the cause, not the symptom |

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

The pipeline is defined in `~/.vcp/dev-buddy.json` as ordered arrays of stages. Each stage specifies a type, provider, and model. Add, remove, or reorder stages. Swap AI providers per stage — API presets support both **Anthropic-compatible** and **OpenAI-compatible** endpoints via the `protocol` field.

Use the web portal (`/dev-buddy-config`) or edit JSON directly.

<details>
<summary><strong>Example: feature pipeline with Codex final gates</strong></summary>

```json
{
  "feature_pipeline": [
    { "type": "requirements", "provider": "anthropic-subscription", "model": "opus" },
    { "type": "planning", "provider": "anthropic-subscription", "model": "opus" },
    { "type": "plan-review", "provider": "anthropic-subscription", "model": "sonnet" },
    { "type": "plan-review", "provider": "anthropic-subscription", "model": "opus" },
    { "type": "plan-review", "provider": "my-codex-preset", "model": "o3" },
    { "type": "implementation", "provider": "anthropic-subscription", "model": "sonnet" },
    { "type": "code-review", "provider": "anthropic-subscription", "model": "sonnet" },
    { "type": "code-review", "provider": "anthropic-subscription", "model": "opus" },
    { "type": "code-review", "provider": "my-codex-preset", "model": "o3" }
  ]
}
```

</details>

---

## Quick Start

```bash
# Install Dev Buddy
/plugin install vcp@dev-buddy

# Feature development pipeline
/dev-buddy-feature-implement Add user authentication with JWT

# Bug fix pipeline
/dev-buddy-bug-fix Login fails when email contains a plus sign

# Configure pipeline stages and providers via web portal
/dev-buddy-config
```

---

## Skills Reference

| Skill | Command | Description |
|-------|---------|-------------|
| Feature Implement | `/dev-buddy-feature-implement` | Full feature development pipeline — requirements, planning, reviews, implementation, code reviews |
| Bug Fix | `/dev-buddy-bug-fix` | Bug fix pipeline — root cause analysis, validation, implementation, code reviews |
| Once | `/dev-buddy-once` | Run a single task using a specific AI provider and model |
| Config | `/dev-buddy-config` | Web portal for managing pipeline stages, providers, and models |
| Manage Presets | `/dev-buddy-manage-presets` | List, add, update, or remove AI provider presets |

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
| review-validator | SubagentStop | Validates review outputs meet quality standards |

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
