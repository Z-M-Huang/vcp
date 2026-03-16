# Provider Dispatch Routing

> **When to execute:** From the main loop (step 5c) when dispatching a task to an agent, or from the phased implementation loop when dispatching implementers and reviewers.

---

## Routing by Provider Type

Read the stage's `providerType` field from `pipeline-tasks.json` stages[] to determine routing:

### If providerType is 'subscription'

Use Task tool (NO `team_name` — one-shot subagent):

```
Task(subagent_type: "dev-buddy:<agent-name>", model: "<model>", prompt: "...")
// Do NOT add team_name or name parameters. This is a one-shot subagent, NOT a teammate.
```

### If providerType is 'api'

Use `api-task-runner.ts` — a per-invocation script that creates a V2 Agent SDK session, runs the task, and exits.

**Derive timeout:** Read `~/.vcp/ai-presets.json` -> find the preset matching the stage's `provider` name -> read `timeout_ms` (default: 300000 if not set or lookup fails).

**IMPORTANT:** The Bash tool has a hard max timeout of 600,000ms (10 min). API tasks can run much longer (e.g., 30 min). Always use `run_in_background: true` to prevent the Bash tool from killing the process prematurely.

```bash
# Run with run_in_background: true — saves task_id
bun "${CLAUDE_PLUGIN_ROOT}/scripts/api-task-runner.ts" \
  --preset "<stage.provider>" \
  --model "<stage.model>" \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --task-timeout "<timeout_ms>" \
  --task-stdin <<'TASK_EOF'
...prompt...
TASK_EOF
```

**For review stages (plan-review, code-review) ONLY:** Add `--system-prompt "${CLAUDE_PLUGIN_ROOT}/docs/review-guidelines.md"` to the api-task-runner.ts invocation to inject centralized review guidelines into the API session's system prompt.

Save `task_id` along with the pipeline task ID, provider, and model. If no `task_id` is returned, treat as dispatch failure — do not retry in foreground mode.

Then poll for completion:
```
TaskOutput(task_id, block: true, timeout: min(timeout_ms + 120000, 600000))
```
If TaskOutput returns but the task is still running (not complete), repeat `TaskOutput` with `timeout: 600000` until the background task finishes.

Uses `--task-stdin` with heredoc to avoid OS argv size limits and ps exposure.
Parse the final output for JSON: `{ event: "complete", result: "..." }` or `{ event: "error", error: "..." }`. Exit code 3 = timeout.
The api-task-runner creates a V2 Agent SDK session with Read/Write/Edit/Bash — it CAN modify files on disk. API providers support ALL stage types including implementation and RCA.

### If providerType is 'cli'

The task description specifies the exact cli-executor.ts invocation with `--output-file` and optional `--model` flags:

```
Task(
  subagent_type: "dev-buddy:cli-executor",
  prompt: "Run: bun '${CLAUDE_PLUGIN_ROOT}/scripts/cli-executor.ts' \
    --type {plan|code} \
    --plugin-root '${CLAUDE_PLUGIN_ROOT}' \
    --preset '{stage.provider}' \
    --model '{stage.model}' \
    --output-file '${CLAUDE_PROJECT_DIR}/.vcp/task/{stage.output_file}'
  Review the {plan|code} and write output to the specified file."
  // Do NOT add team_name or name. One-shot subagent, NOT a teammate.
)
```

The `--preset` flag selects the CLI preset from `~/.vcp/ai-presets.json`. The preset's `args_template` contains placeholders (`{model}`, `{output_file}`, `{prompt}`, `{schema_path}`) that the executor substitutes at runtime.

Do NOT pass model parameter to Task tool. Model is passed via --model flag to cli-executor.ts.

### Stage Type Auto-Resolution

The `--stage-type` flag enables auto-resolution of stage definitions from `stages/{type}.md`. When passed, the runner loads the stage definition markdown and prepends it to the system prompt content. Combine with `--system-prompt` to inject a role prompt file — the runner composes `stage + role` into the system prompt layer. Example:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/api-task-runner.ts" \
  --preset "<stage.provider>" \
  --model "<stage.model>" \
  --stage-type "<stage.type>" \
  --system-prompt "${CLAUDE_PLUGIN_ROOT}/system-prompts/built-in/<role>.md" \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --task-timeout "<timeout_ms>" \
  --task-stdin <<'TASK_EOF'
...prompt...
TASK_EOF
```

When `--stage-type` is provided, the runner auto-resolves the stage definition from `stages/`. The `--system-prompt` flag provides the role prompt content. Together they compose `stage_definition + role_prompt` as the session's system prompt. If `--system-prompt` is omitted, only the stage definition is used (no role perspective).
