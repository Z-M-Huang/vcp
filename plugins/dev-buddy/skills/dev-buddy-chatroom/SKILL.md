---
name: dev-buddy-chatroom
description: Multi-model chatroom for collaborative ideation and design discussion
user-invocable: true
allowed-tools: Read, Bash, Task, TaskOutput, AskUserQuestion, Glob, Grep
---

# Multi-Model Chatroom

Spawn a multi-model deliberation "chatroom" where Claude formulates an approach, sends it to N configured AI models for critique, iterates until consensus or max rounds, then presents everything to the user.

This is a **standalone orchestration skill** — it manages its own multi-round deliberation loop directly, unlike pipeline skills which are thin executor loops over `pipeline-driver.ts`.

**Usage:** `/dev-buddy-chatroom <topic>`

**Examples:**
```
/dev-buddy-chatroom How should we architect a caching layer for the API?
/dev-buddy-chatroom Design a retry strategy for the payment service
/dev-buddy-chatroom What's the best approach for migrating from REST to GraphQL?
```

---

## Step 1: Parse Topic

Extract the topic from the user's message after `/dev-buddy-chatroom`. Everything after the skill trigger is the topic. If no topic is provided, ask the user with `AskUserQuestion`.

---

## Step 2: Read and Validate Config

Load the chatroom config through the helper (handles missing file, invalid JSON, structural validation, and defaults):

```bash
bun -e "
import { loadChatroomConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/chatroom-config.ts';
try {
  const config = loadChatroomConfig();
  console.log(JSON.stringify(config));
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
"
```

If the command exits with code 1, report the error message to the user and suggest `/dev-buddy-config`.

If the config loads successfully but has 0 participants, report an error:
```
No chatroom participants configured. Use /dev-buddy-config to add participants in the Chatroom tab.
```

**Validate at least 1 participant** is configured. The config file allows 0 participants (for saving), but the skill requires at least 1 to execute.

Resolve each participant's preset by reading the presets file:

```bash
bun -e "
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
const presets = readPresets();
console.log(JSON.stringify(Object.entries(presets.presets).map(([k,v]) => ({
  name: k, type: v.type, models: v.models || ['haiku','sonnet','opus'],
  timeout_ms: v.timeout_ms
}))));
"
```

Validate each participant's preset exists and model is valid (same as dev-buddy-once Step 2).

---

## Step 3: Formulate Initial Draft

Think about the topic and write your initial approach/design/analysis. This is the draft that will be sent to all participants for critique. Be substantive — give participants something concrete to react to.

---

## Step 4: Fan Out to Participants (Parallel)

Launch ALL participants in parallel in a single message with multiple tool calls:

### Subscription Participants (`type: "subscription"`)

```
Task(
  subagent_type: "general-purpose",
  model: "<model>",
  prompt: "<deliberation prompt from templates below>"
)
```

Tell the subagent to respond with analysis only — no file editing, no tool use beyond reading.

### API Participants (`type: "api"`)

For each API participant, generate a unique output ID:
```
{preset}-{model}-{unix_timestamp}-{pid}
```

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type api \
  --preset "<exact_preset_name>" \
  --model "<model>" \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --output-id "<preset>-<model>-$(date +%s)-$$" \
  --task-stdin <<'TASK_EOF'
<deliberation prompt>
TASK_EOF
```

**MUST use `run_in_background: true`** — API tasks take 2-5 minutes.

**Remember each participant's `--output-id` token** — the output file will be at `/tmp/.vcp/oneshot/<id>.json`. You will Read it in Step 5.

### CLI Participants (`type: "cli"`)

For each CLI participant, generate a unique output ID (same pattern):
```
{preset}-{model}-{unix_timestamp}-{pid}
```

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
  --type cli \
  --preset "<exact_preset_name>" \
  --model "<model>" \
  --cwd "${CLAUDE_PROJECT_DIR}" \
  --output-id "<preset>-<model>-$(date +%s)-$$" \
  --task-stdin <<'TASK_EOF'
<deliberation prompt>
TASK_EOF
```

**MUST use `run_in_background: true`** — CLI tasks take 5-20 minutes.

**Remember each participant's `--output-id` token** — the output file will be at `/tmp/.vcp/oneshot/<id>.json`. You will Read it in Step 5.

### Dispatch Contract

For each API/CLI participant launched with `run_in_background: true`:
1. Save the returned `task_id` from the Bash tool.
2. If `run_in_background` does not return a `task_id`, report a dispatch failure — do NOT retry in foreground mode.
3. Remember both the `task_id` and the `--output-id` token for Step 5.

---

## Step 5: Collect Responses

**CRITICAL: Poll participants ONE AT A TIME.** Never call multiple TaskOutput in the same message — if one fails, Claude Code cascades the failure to all siblings ("Sibling tool call errored").

For each participant, **sequentially** (one per message turn):

- **Subscription**: Read the Task tool result directly (already available from Step 4).

- **API/CLI**: Two-phase retrieval:
  1. **Wait for completion**: Call `TaskOutput(task_id, block: true, timeout: <computed>)` with the timeout from the Timeout Contract below.
  2. **Read the output file**: Use the **Read tool** to read `/tmp/.vcp/oneshot/<id>.json` (where `<id>` is the `--output-id` token from Step 4). Parse the JSON:
     - `{"event": "complete", ...}` → extract `result` field
     - `{"event": "error", ...}` → note the error, continue with other participants
     - If the file does not exist, the task likely failed — check TaskOutput for error details

  **Fallback**: If TaskOutput itself errors (sibling cascade, task not found), try Reading the output file directly — the task may have already completed and written its result.

**IMPORTANT**: Do NOT rely on TaskOutput stdout for the result — background task stdout capture is unreliable. Always Read the output file.

If a participant errored or timed out, note it in the output but continue with remaining responses.

### Timeout Contract (for each TaskOutput call)

1. **Derive timeout:** Read `timeout_ms` from preset config (default: 300000 for API, 1200000 for CLI).
2. **Poll with correct timeout (NOT the default 30s):**
   ```
   TaskOutput(task_id: "<task_id>", block: true, timeout: min(timeout_ms + 120000, 600000))
   ```
3. If TaskOutput returns but the task is still running, repeat with `timeout: 600000` until done.
4. NEVER use default 30s TaskOutput timeout.
5. NEVER retry in foreground mode.
6. NEVER call multiple TaskOutput in the same message.

---

## Step 6: Evaluate Consensus

Read all participant responses and determine:

1. **All agree** → Proceed to Step 7 (synthesis)
2. **Any disagree or partially agree** → If `current_round < max_rounds`:
   - Update your draft based on feedback
   - Go back to Step 4 with the updated draft and conversation history
3. **Max rounds reached** → Proceed to Step 7 regardless

Look for explicit "AGREE" or "DISAGREE" statements at the start of each response. If ambiguous, interpret the overall sentiment.

---

## Step 7: Present Results to User

Show the complete deliberation to the user:

1. **Your initial draft** (brief summary)
2. **Each round's responses** — for each participant per round, show:
   - Participant name (preset + model)
   - Their response (full text)
   - Whether they agreed or disagreed
3. **Final synthesis** — your updated approach incorporating feedback from all rounds
4. **Consensus status** — "All agreed in round N" or "Max rounds reached with partial agreement"

---

## Prompt Templates

### Round 1 Prompt

```
You are participating in a multi-model brainstorming discussion about a software design topic.

Think creatively and explore unconventional approaches. Challenge assumptions freely.
Propose bold alternatives rather than safe incremental suggestions. Play devil's advocate
where appropriate — the goal is to surface ideas the host AI might have missed.

TOPIC: {topic}

The host AI has proposed the following approach:

{claude_draft}

Analyze this approach:
1. State AGREE or DISAGREE clearly at the start
2. What are the strengths?
3. What's missing or could be improved?
4. If you disagree, what alternative do you propose?

Be specific and constructive. Keep your response concise.
```

### Subsequent Round Prompt

```
You are participating in a multi-model brainstorming discussion (Round {N} of {max_rounds}).

Think creatively. Challenge assumptions. Propose bold alternatives where you see opportunity.

TOPIC: {topic}

PREVIOUS ROUNDS:
{conversation_history}

The host has updated their approach based on feedback:

{updated_draft}

Has the updated approach addressed your concerns?
State AGREE or DISAGREE clearly at the start, then explain.
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No config file | Report error, suggest `/dev-buddy-config` |
| 0 participants configured | Report error, suggest adding participants in Chatroom tab |
| Preset not found | Report which preset is missing, suggest `/dev-buddy-manage-presets` |
| Model not in preset | Report available models for that preset |
| Participant timeout | Note timeout, continue with other responses |
| Participant error | Note error, continue with other responses |
| All participants failed | Report all failures, suggest checking preset configs |
| No topic provided | Ask user with `AskUserQuestion` |

---

## Anti-Patterns

- Do NOT run a full pipeline — this is a standalone deliberation skill
- Do NOT create pipeline tasks (TaskCreate/TaskUpdate) — no orchestration infrastructure
- Do NOT skip preset resolution — always validate preset and model first
- For subscription: do NOT run the one-shot-runner.ts script — use Task tool directly
- Do NOT fall back to foreground Bash when background TaskOutput returns empty
- Do NOT retry API/CLI tasks in foreground mode
- Do NOT use the default TaskOutput timeout (30s) for API/CLI tasks
- Do NOT suppress participant errors — always report them to the user
- Do NOT hide individual model responses — show everything for transparency
- Do NOT call multiple TaskOutput in the same message — Claude Code cascades failures to sibling tool calls
