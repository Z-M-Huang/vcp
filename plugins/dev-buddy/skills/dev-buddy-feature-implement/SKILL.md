---
name: dev-buddy-feature-implement
description: Dev Buddy multi-AI pipeline. Plan -> Review -> Implement (loop until reviews approve). Configurable pipeline with Codex final gate.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, TaskOutput, AskUserQuestion, Skill, TeamCreate, TeamDelete, SendMessage
---

# Multi-AI Feature Pipeline — Driver-Based Executor

You are a thin executor loop. The pipeline-driver.ts state machine decides what to do; you execute the tool calls it commands.

**Driver:** `${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts`
**Task dir:** `${CLAUDE_PROJECT_DIR}/.vcp/task/`

---

## Execution Model

1. **ONE command at a time.** The driver returns ONE JSON command. Execute it, report, get next.
2. **WAIT for result.** After each tool call, WAIT for the result before reporting.
3. **NEVER skip steps.** If a command fails, report the failure. The driver decides recovery.
4. **User interruption = FULL STOP.** If the user sends a message mid-pipeline, report `{interrupted: true}`.

---

## Step 1: Initialize

Write the user's feature description to a temp file, then pass it via `--description-file`:

```bash
# Write description to temp file (safe from shell injection)
cat <<'DESCRIPTION_EOF' > /tmp/vcp-description.txt
<paste the user's feature description here>
DESCRIPTION_EOF

bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts" init --pipeline feature --cwd "${CLAUDE_PROJECT_DIR}" --description-file /tmp/vcp-description.txt
```

If no description was provided by the user, omit `--description-file`.

Parse the JSON output. This is your first command.

---

## Step 2: Execute-Report Loop

Repeat until the driver reaches a terminal outcome:

- If `action === "done"` and `terminal_state === "completed"`, the pipeline succeeded. Show `summary` and exit.
- If `action === "done"` and `terminal_state !== "completed"`, the pipeline **failed**. Show the `summary` and `terminal_reason` as an error and **stop**. Do NOT continue with manual implementation or ad-hoc recovery outside the pipeline driver.

### 2a. Execute the command

Map `action` to the corresponding tool call:

| Action | Tool | Key Fields |
|--------|------|-----------|
| `create_team` | TeamCreate | `team_name` |
| `delete_team` | TeamDelete | `team_name` |
| `spawn_agent` | Task | `subagent_type`, `name`, `model`, `prompt_file` (read file for prompt) |
| `spawn_teammate` | Task | `subagent_type`, `name`, `team_name`, `model`, `prompt_file` |
| `spawn_background` | Bash | `command` with `run_in_background: true`, `timeout_ms` |
| `wait_for_task` | TaskOutput | `task_id`, `timeout_ms`, `poll_on_still_running` |
| `send_message` | SendMessage | `recipient`, `content_file` (read for content), `summary` |
| `receive_messages` | *(automatic)* | Messages are auto-delivered; report any received |
| `shutdown_teammate` | SendMessage | type: `shutdown_request`, `recipient` |
| `ask_user` | AskUserQuestion | `question`, `options`, `context` |
| `show_status` | *(display)* | Show `message` to user. If `progress` field present, display it. |
| `read_file` | Read | `path` |
| `write_file` | Write | `path`, `content_file` (read for content) |
| `write_multi_file` | Write (multiple) | `files[]`, `manifest_path` + `manifest_content_file` written LAST |
| `parallel_batch` | *(multiple)* | Execute all `commands[]` in parallel |
| `noop` | *(skip)* | Driver handled internally; if `progress` field present, display it. Proceed to report. |
| `done` | *(terminal)* | If `terminal_state === "completed"`, pipeline succeeded. Otherwise pipeline **failed** — show error and stop. Do NOT implement manually. |
| `escalate` | AskUserQuestion | Show `error` + `context`, present `recovery_options` |
| `pause` | *(stop)* | Show `reason`. Wait for user to resume. |

### 2b. Report result

Write result to a temp file:

```bash
echo '<json>' > /tmp/vcp-report.json
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts" report \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --id "<command_id>" \
  --result-file /tmp/vcp-report.json
```

**Report JSON fields:**

```json
{
  "command_id": "<must match>",
  "ok": true,
  "task_id": "<from Bash run_in_background>",
  "answer": "<from AskUserQuestion>",
  "content": "<from Read file>",
  "messages": [{"from": "...", "summary": "..."}],
  "batch_results": {"<sub_cmd_id>": {"ok": true, "task_id": "...", "content": "..."}},
  "interrupted": false,
  "exit_code": 0,
  "still_running": false,
  "error": "<if ok=false>"
}
```

Include only the fields relevant to the action. `command_id` and `ok` are always required.
For `parallel_batch`, include `batch_results` keyed by each sub-command's `command_id` with that sub-command's result fields.

### 2c. Get next command

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts" next --cwd "${CLAUDE_PROJECT_DIR}"
```

Parse the JSON output. Go to 2a.

---

## Action-Specific Notes

### Progress Display

If the command has a `progress` field, display it to the user **before** executing the command's action. This provides real-time pipeline status without extra round-trips.

### spawn_agent / spawn_teammate

Read the prompt from `prompt_file` path. Pass to Task tool:

```
Task(subagent_type: cmd.subagent_type, name: cmd.name, model: cmd.model, prompt: <file_content>)
```

**CRITICAL: `spawn_agent` MUST run as a foreground blocking Task.** Do NOT set `run_in_background`.
The agent may use AskUserQuestion to interact with the user — this only works when the Task
blocks the main thread. **WAIT for the Task to fully complete and return its result.** Only
THEN file the report and call `next`. If you report before the Task returns, the driver will
enter a terminal error state because the output file doesn't exist yet.

For `spawn_teammate`, also pass `team_name`. Teammates run in the background as part of the team.

For `cli` provider types (e.g., Codex): use `subagent_type: "dev-buddy:cli-executor"`. Do NOT pass `model` on the Task tool — the CLI tool receives it via flags in the prompt.

### spawn_background

If `prompt_file` is present, pipe it to stdin: `Bash(command: "cat '<prompt_file>' | <cmd.command>", run_in_background: true, timeout: cmd.timeout_ms)`. Otherwise run the command directly: `Bash(command: cmd.command, run_in_background: true, timeout: cmd.timeout_ms)`. Report back the `task_id` from the Bash result.

### wait_for_task

Poll with `TaskOutput(task_id: cmd.task_id, block: true, timeout: min(cmd.timeout_ms, 600000))`. If result shows `still_running` and `poll_on_still_running` is true, re-poll up to `max_poll_attempts`. **Always include `task_id` (the background task ID from `cmd.task_id`) in the report.**

### parallel_batch

Execute all commands in `commands[]` as parallel tool calls in a single response. Collect all results. Report as a batch.

### write_multi_file

Write all `files[]` first, then write `manifest_path` + `manifest_content_file` LAST. The manifest signals completion.

### escalate

Present `error` and `context` to the user via AskUserQuestion. If `recovery_options` are provided, present them as choices. Report the user's answer.

---

## Emergency Controls

- **Reset:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd "${CLAUDE_PROJECT_DIR}"`
- **Status:** `bun "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-driver.ts" status --cwd "${CLAUDE_PROJECT_DIR}"`
- **Check artifacts:** Read `.vcp/task/*.json` files directly
