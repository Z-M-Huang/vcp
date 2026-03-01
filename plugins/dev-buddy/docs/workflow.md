# Pipeline Workflow (Task + Hook Architecture, Configurable)

## Architecture Overview

This pipeline uses a **Task + Hook architecture** with a persistent pipeline team and a **configurable stage array**:

- **Config** - Ordered arrays of `{type, provider, model}` stage entries (replaces fixed 9-stage map)
- **Team (Lifecycle)** - Persistent pipeline team provides TaskCreate/TaskUpdate/TaskList access
- **Tasks (Primary)** - Structural enforcement via `blockedBy` dependencies
- **Hook (Guidance)** - Validates output, transitions state, injects reminders
- **Main Thread** - Orchestrator that handles user input and creates dynamic tasks
- **Stage Registry** - 6 fixed stage types with constraints (singleton, allowed_pipelines, output file patterns)

### Custom Agents

| Agent | Default Model | Purpose | Stage Type |
|-------|-------|---------|-------|
| `requirements-gatherer` | opus | Business Analyst + PM hybrid | requirements |
| `planner` | opus | Architect + Fullstack hybrid | planning |
| `plan-reviewer` | sonnet/opus | Architecture + Security + QA | plan-review |
| `implementer` | sonnet | Fullstack + TDD + Quality | implementation |
| `code-reviewer` | sonnet/opus | Security + Performance + QA | code-review |
| `root-cause-analyst` | sonnet/opus | Autonomous bug diagnosis | rca |
| `cli-executor` | external | CLI tool wrapper (invokes any configured CLI tool) | (any CLI preset stage) |

---

## Quick Start

```
/dev-buddy-feature-implement Add user authentication with JWT tokens
/dev-buddy-bug-fix Login fails with 500 after password reset
```

### Feature Development

1. **Load config** - Read `~/.vcp/dev-buddy.json`, resolve `feature_pipeline` stages
2. **Requirements** - requirements-gatherer agent (team-based exploration)
3. **Planning** - planner agent
4. **Plan reviews** - Sequential, one per `plan-review` stage in config
5. **Implementation** - implementer agent
6. **Code reviews** - Sequential, one per `code-review` stage in config
7. **Completion** - Report results

### Bug Fix

1. **Load config** - Read `~/.vcp/dev-buddy.json`, resolve `bugfix_pipeline` stages
2. **RCA stages** - Sequential root-cause-analyst agents (one per `rca` stage)
3. **Inline consolidation** - Orchestrator consolidates RCA findings, writes `user-story/` + `plan/` multi-file directories
4. **Plan validation** - Optional `plan-review` stages (e.g., Codex RCA+plan gate)
5. **Implementation** - implementer agent
6. **Code reviews** - Sequential, one per `code-review` stage
7. **Completion** - Report results

---

## State Flow (Dynamic Phases)

**Feature pipeline:**
```
idle
→ requirements_gathering (or requirements_team_pending / requirements_team_exploring)
→ plan_drafting
→ plan_review_1 ↔ fix_plan_review_1
→ plan_review_2 ↔ fix_plan_review_2
→ plan_review_N ↔ fix_plan_review_N   (N = count of plan-review stages in config)
→ implementation
→ code_review_1 ↔ fix_code_review_1
→ code_review_2 ↔ fix_code_review_2
→ code_review_M ↔ fix_code_review_M   (M = count of code-review stages in config)
→ complete
```

**Bug-fix pipeline:**
```
idle
→ root_cause_analysis (pending / in progress / consolidation)
→ plan_review_1  (Codex RCA+plan validation gate)
→ implementation
→ code_review_1 ↔ fix_code_review_1
→ code_review_M ↔ fix_code_review_M
→ complete
```

Phase tokens are **dynamic** — the index suffix matches the stage position in the pipeline config array (1-based, counting within the stage type). Max `max_iterations` re-reviews per reviewer before escalating to user.

---

## Task Chain (Dynamic)

After loading the config, tasks are created by iterating the resolved pipeline array:

```
// Feature pipeline with default 9 stages:
T1 = TaskCreate(subject: "Requirements 1")
T2 = TaskCreate(subject: "Planning 1")         → addBlockedBy: [T1]
T3 = TaskCreate(subject: "Plan Review 1")      → addBlockedBy: [T2]
T4 = TaskCreate(subject: "Plan Review 2")      → addBlockedBy: [T3]
T5 = TaskCreate(subject: "Plan Review 3")      → addBlockedBy: [T4]  <- last plan-review gate
T6 = TaskCreate(subject: "Implementation 1")   → addBlockedBy: [T5]
T7 = TaskCreate(subject: "Code Review 1")      → addBlockedBy: [T6]
T8 = TaskCreate(subject: "Code Review 2")      → addBlockedBy: [T7]
T9 = TaskCreate(subject: "Code Review 3")      → addBlockedBy: [T8]  <- final gate
```

Store returned IDs + `resolved_config` snapshot in `.vcp/task/pipeline-tasks.json`. See SKILL.md for full details.

### Dynamic Fix Tasks

When a review returns `needs_changes`:

1. `fix = TaskCreate(subject: "Fix Plan Review 2 v1", ...)` then `TaskUpdate(fix.id, addBlockedBy: [review_id])`
2. `rerev = TaskCreate(subject: "Plan Review 2 v2", ...)` then `TaskUpdate(rerev.id, addBlockedBy: [fix.id])`
3. `if next_stage_task_id is not null: TaskUpdate(next_stage_task_id, addBlockedBy: [rerev.id])`
   - Re-review returns to **same stage index** — not next stage

---

## Output Files (Versioned Naming)

| File Pattern | Stage Type | Description |
|------|-------------|-------------|
| `.vcp/task/user-story/manifest.json` | requirements | Approved requirements (multi-file directory) |
| `.vcp/task/plan/manifest.json` | planning | Implementation plan (multi-file directory) |
| `.vcp/task/plan-review-{provider}-{model}-{N}-v{V}.json` | plan-review | Plan review (e.g., `plan-review-anthropic-subscription-sonnet-1-v1.json`) |
| `.vcp/task/impl-result.json` | implementation | Implementation result (singleton) |
| `.vcp/task/code-review-{provider}-{model}-{N}-v{V}.json` | code-review | Code review (e.g., `code-review-anthropic-subscription-opus-2-v1.json`) |
| `.vcp/task/rca-{provider}-{model}-{N}-v{V}.json` | rca | Root cause analysis (e.g., `rca-anthropic-subscription-sonnet-1-v1.json`) |
| `.vcp/task/pipeline-tasks.json` | (meta) | Team name + Task IDs + `resolved_config` + `stages[]` with `current_version` |

---

## Review Statuses

**All review types:**
- `approved` - Proceed to next stage
- `needs_changes` - Fix and re-review (same stage index)
- `needs_clarification` - Ask user, then re-run same reviewer
- `rejected` - Major issue (terminal for some stages — escalate to user)

---

## Scripts

| Command | Purpose |
|---------|---------|
| `bun orchestrator.ts` | Show current state and next action |
| `bun orchestrator.ts status` | Show current state details |
| `bun orchestrator.ts reset --cwd <dir>` | Reset pipeline to idle |
| `bun orchestrator.ts dry-run` | Validate setup |
| `bun orchestrator.ts phase` | Output current phase token |

---

## Emergency Controls

If stuck:

1. **Check task state:** `TaskList()` to see blocked tasks (requires pipeline team to be active)
2. **Check artifacts:** Read `.vcp/task/*.json` files to understand progress
3. **Reset pipeline:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"`
4. **Check phase:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" phase`

---

## Default Settings

| Setting | Default Value |
|---------|-------|
| Feature pipeline stages | 9 (requirements, planning, 3x plan-review, implementation, 3x code-review) |
| Bug-fix pipeline stages | 7 (2x rca, 1x plan-review, implementation, 3x code-review) |
| Default provider | anthropic-subscription |
| max_iterations | 10 |
| team_name_pattern | pipeline-{BASENAME}-{HASH} |

Configure via web portal (`/dev-buddy-config`) or edit `~/.vcp/dev-buddy.json` directly.
Model is required on every stage entry.
