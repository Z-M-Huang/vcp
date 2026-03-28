# Dev Buddy Workflow

Dev Buddy has two architectures: **v3 Stage Skills** (granular, executor-based) and **v2 Pipeline Skills** (monolithic, team-based).

---

## v3 Architecture: Modular Stage Skills

### Core Concepts

```
Stage Definition + Role Prompt (.md file) + Preset + Model = Executor
Stage = collection of Executors (parallel/sequential)
Stage Skill = individually-invocable command that runs a stage's executors
```

- **Stage Definitions** — 6 fixed types (requirements, planning, plan-review, implementation, code-review, rca) that define WHAT happens at each pipeline phase
- **Role Prompts** — Reusable agent role definitions. Built-in (`system-prompts/built-in/*.md`, read-only) + custom (`~/.vcp/system-prompts/*.md`)
- **Executors** — Named combinations of system_prompt + preset + model. Defined in `~/.vcp/dev-buddy.json`
- **Stages** — 6 fixed types, each with an array of executor refs. Executors can run in parallel or sequential
- **Pipelines** — User-configurable ordered lists of stages

### Stage Skills

| Skill | Command | Purpose |
|-------|---------|---------|
| Plan | `/dev-buddy-plan` | Create implementation plan with test cases and step-to-AC mapping |
| Review | `/dev-buddy-review` | Review plan (`--plan`) or code (`--code`). Multi-executor, evidence-bound findings |
| Implement | `/dev-buddy-implement` | Implement with TDD loop — tests after each step, escalate on failure |
| Requirements | `/dev-buddy-requirements` | Gather requirements with provenance tracking. Minimal 4-file output |
| RCA | `/dev-buddy-rca` | Root cause analysis. Outputs diagnosis only |

### Typical Workflows

**Feature development:**
```
/dev-buddy-requirements  →  /dev-buddy-plan  →  /dev-buddy-review --plan  →  /dev-buddy-implement  →  /dev-buddy-review --code
```

**Bug fix:**
```
/dev-buddy-rca  →  /dev-buddy-requirements  →  /dev-buddy-plan  →  /dev-buddy-review --plan  →  /dev-buddy-implement  →  /dev-buddy-review --code
```

Each stage reads input artifacts from `.vcp/task/` and writes output artifacts. No team mode, no persistent state between stages.

### Anti-Drift Mechanisms

1. **Original request injection** — every executor prompt gets the verbatim original request
2. **TDD loop** — implementation runs tests after each step, loops on failure (max 5 retries)
3. **Step-to-AC mapping** — every plan step must reference acceptance criteria
4. **Evidence-bound reviews** — blocking findings require `contract_reference` + `evidence`
5. **Requirements provenance** — ACs track their source (original_request, user_answer, specialist_suggestion)

### Config Format (v4)

File: `~/.vcp/dev-buddy.json` with `"version": "4.0"`

```json
{
  "version": "4.0",
  "stages": {
    "planning": { "executors": [{ "system_prompt": "planner", "preset": "anthropic-subscription", "model": "opus" }] },
    "plan-review": { "executors": [{ "system_prompt": "plan-reviewer", "preset": "anthropic-subscription", "model": "sonnet" }] }
  },
  "pipelines": {
    "feature": ["requirements", "planning", "plan-review", "implementation", "code-review"],
    "bug-fix": ["rca", "requirements", "planning", "plan-review", "implementation", "code-review"]
  },
  "max_iterations": 10,
  "max_tdd_iterations": 5
}
```

### Output Files

| File Pattern | Stage Type |
|------|-------------|
| `.vcp/task/user-story/manifest.json` | requirements |
| `.vcp/task/plan/manifest.json` | planning |
| `.vcp/task/plan/test-plan.json` | planning (TDD test cases) |
| `.vcp/task/{stage}-{system_prompt}-{provider}-{model}-{index}.json` | plan-review, code-review |
| `.vcp/task/rca-{system_prompt}-{provider}-{model}-{index}-v{version}.json` | rca |
| `.vcp/task/pipeline-tasks.json` | pipeline state (created by orchestrators) |
| `.vcp/task/impl-result.json` | implementation |
| `.vcp/task/rca-diagnosis.json` | rca (consolidated) |

### Provider Dispatch

All stage skills resolve the executor's system prompt, embed it in the task prompt, and dispatch via `general-purpose` subagent:
- **subscription** → `Task(subagent_type: "general-purpose", model, prompt: "<system_prompt>\n---\n<task>")`
- **api** → `Bash(run_in_background: true)` → `api-task-runner.ts` → `TaskOutput`
- **cli** → `Task(subagent_type: "general-purpose", prompt: "Run: bun cli-executor.ts ...")`

---

## Role Prompts (built-in)

| Role Prompt | Purpose |
|-------------|---------|
| `requirements-gatherer` | Business Analyst + PM hybrid |
| `planner` | Architect + Fullstack planning |
| `plan-reviewer` | Architecture + Security + QA validation |
| `implementer` | Fullstack + TDD implementation |
| `code-reviewer` | Security + Performance + QA review |
| `root-cause-analyst` | Autonomous bug diagnosis |

Located in `system-prompts/built-in/`. Users create custom role prompts in `~/.vcp/system-prompts/`.

---

## Scripts

| Command | Purpose |
|---------|---------|
| `bun pipeline-config.ts validate-v3` | Validate v3 config |
| `bun pipeline-config.ts migrate` | Migrate v2 → v3 config (auto on first load) |
| `bun system-prompts.ts list` | List all system prompts (built-in + custom) |
| `bun system-prompts.ts discover` | Show full discovery details |

---

## Review Statuses

- `approved` — Proceed to next stage
- `needs_changes` — Fix and re-review (requires `must_fix` finding with evidence)
- `needs_clarification` — Ask user, then re-run
- `rejected` — Major issue, escalate to user
