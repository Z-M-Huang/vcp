---
name: dev-buddy-chatroom
description: PK Stage — multi-AI competitive debate with iterative consensus. Sends a topic to all configured AI participants simultaneously, synthesizes the best approach, then iterates until consensus or max rounds.
user-invocable: true
allowed-tools: Read, Bash, Task, TaskOutput, AskUserQuestion, Glob, Grep
---

# PK Stage — Multi-AI Competitive Debate

Fan out a topic to ALL configured AIs + Claude simultaneously, synthesize the best approach, iterate until consensus.

**Usage:** `/dev-buddy-chatroom <topic or question>`

**Config:** `~/.vcp/dev-buddy-chatroom.json` — use `/dev-buddy-config` web portal or edit manually.

---

## Step 1: Parse & Load Config

Extract the user's topic from the arguments after the skill trigger.

Load and validate the chatroom config:

```bash
bun -e "
import { loadChatroomConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/chatroom-config.ts';
import { readPresets } from '${CLAUDE_PLUGIN_ROOT}/scripts/preset-utils.ts';
import { validateChatroomConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/chatroom-config.ts';
const config = loadChatroomConfig();
const presets = readPresets();
const err = validateChatroomConfig(config, presets);
if (err) { console.error('CONFIG ERROR: ' + err); process.exit(1); }
console.log(JSON.stringify({
  participants: config.participants.map((p, i) => ({
    index: i,
    preset: p.preset,
    model: p.model,
    type: presets.presets[p.preset]?.type || 'unknown',
    timeout_ms: presets.presets[p.preset]?.timeout_ms
  })),
  max_rounds: config.max_rounds
}));
"
```

If config error or no participants: report error to user and stop.

**Resolve session variables:**

1. Resolve tmpdir:
   ```bash
   bun -e "console.log(require('os').tmpdir())"
   ```
   Store result as `{TMPDIR}`.

2. Compute project hash:
   ```bash
   bun -e "const c=require('crypto');console.log(c.createHash('sha256').update(process.env.CLAUDE_PROJECT_DIR||process.cwd()).digest('hex').slice(0,8))"
   ```
   Store result as `{PROJHASH}`.

3. Generate random suffix:
   ```bash
   bun -e "console.log(require('crypto').randomBytes(2).toString('hex'))"
   ```
   Store result as `{RAND}`.

4. Generate session ID: `{PROJHASH}-{Date.now()}-{RAND}` → store as `{SESSION_ID}`

5. Assign each participant a zero-based index: `p0`, `p1`, `p2`, ...

6. Ensure output directory exists:
   ```bash
   mkdir -p "{TMPDIR}/.vcp/oneshot"
   ```

7. **No startup cleanup** — stale files from other sessions are harmless.

**Display session info to user:**
- Number of participants, their presets/models
- Max rounds configured
- Session ID (for debugging)

---

## Step 2: Opening Round (Fan-Out)

**PARALLEL OK — dispatch all participants + generate Claude's position in a single message.**

### 2a. Generate heredoc delimiter

Generate a unique delimiter to prevent heredoc injection:
```bash
bun -e "console.log('VCPTASK_' + require('crypto').randomBytes(4).toString('hex'))"
```
Store result as `{DELIM}` (e.g., `VCPTASK_a3f7b2c1`).

### 2b. Dispatch ALL participants in parallel

For each participant at index `{i}`:

**Output ID:** `cr-{SESSION_ID}-p{i}-r1`

**Opening prompt template:**
```
You are participating in a multi-AI debate on the following topic.

TOPIC:
{user_topic}

Provide your analysis, recommendations, and reasoning. Be specific and concrete.

IMPORTANT: ONLY read and analyze. Do NOT modify any files. Do NOT use Write, Edit, or Bash tools to change anything.
```

Route by participant type:

- **Subscription:** `Task(subagent_type: "general-purpose", model: {model}, prompt: {prompt})`

- **API:** `Bash(run_in_background: true)` →
  ```bash
  bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
    --type api --output-id cr-{SESSION_ID}-p{i}-r1 \
    --preset "{PRESET}" --model "{MODEL}" \
    --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin <<'{DELIM}'
  {prompt_text}
  {DELIM}
  ```

- **CLI:** `Bash(run_in_background: true)` →
  ```bash
  bun "${CLAUDE_PLUGIN_ROOT}/scripts/one-shot-runner.ts" \
    --type cli --output-id cr-{SESSION_ID}-p{i}-r1 \
    --preset "{PRESET}" --model "{MODEL}" \
    --cwd "${CLAUDE_PROJECT_DIR}" --task-stdin <<'{DELIM}'
  {prompt_text}
  {DELIM}
  ```

### 2c. Claude generates its own opening position

While background tasks run, generate your own analysis of the topic inline. This is Claude's opening position in the debate.

---

## Step 3: Collect Responses (SEQUENTIAL)

**CRITICAL:** Poll background tasks ONE AT A TIME. Do NOT issue multiple TaskOutput calls in the same message — this causes sibling cascade failures.

**Subscription participants:** Result was returned directly from the Task call in Step 2. Already collected.

**API/CLI participants:** For each, sequentially:

1. Derive timeout: `min(timeout_ms + 120000, 600000)` where `timeout_ms` is the preset's configured timeout (default 300000 for API, 1200000 for CLI).

2. Poll for completion:
   ```
   TaskOutput(task_id: "{id}", block: true, timeout: {computed_timeout})
   ```

3. If TaskOutput returns but task is still running, repeat:
   ```
   TaskOutput(task_id: "{id}", block: true, timeout: 600000)
   ```
   Keep repeating until the task completes.

4. Read the output file:
   ```
   Read("{TMPDIR}/.vcp/oneshot/cr-{SESSION_ID}-p{i}-r{round}.json")
   ```
   Parse the JSON. Extract the `result` field for successful responses. Note `error` field for failures.

5. **CLI output normalization:** Strip ANSI escape sequences (`/\x1b\[[0-9;]*[a-zA-Z]/g` pattern). The useful content may be mixed with banners or progress output.

**Error handling:**
- If a participant times out or errors: note the failure, continue with remaining participants.
- **Quorum rule:** Need at least 1 external response + Claude's own to proceed. If ALL external participants fail, report the error to the user and stop.

---

## Step 4: Synthesize & Check Consensus

Read ALL collected responses (Claude's own + all external participants).

**For Round 1 (opening):**
- Identify the strongest ideas from each participant
- Note areas of agreement and disagreement
- Synthesize a combined approach that takes the best elements

**For subsequent rounds:**
- Apply CLI output normalization (strip ANSI, as above)
- Search for consensus keywords **anywhere** in each response (not just the first line):
  - `AGREE` — participant accepts the synthesis
  - `DISAGREE: <reason>` — participant rejects with specific reason
  - `PARTIAL: <accepted> / <contested>` — partial agreement
- If no keyword found, interpret overall sentiment to classify as agree/disagree/partial

**Decision:**
- If ALL participants agree → go to **Step 6**
- If max_rounds reached → go to **Step 6** (report final state)
- If any disagree and rounds remaining → refine synthesis, go to **Step 5**

---

## Step 5: Subsequent Rounds

Generate a new heredoc delimiter (same method as Step 2a).

**Consensus check prompt template:**
```
MULTI-AI DEBATE — Round {N} Consensus Check

ORIGINAL TOPIC:
{user_topic}

DEBATE HISTORY SUMMARY:
{summary_of_positions_from_all_rounds}

CURRENT SYNTHESIS:
{claude_synthesis}

Do you agree with this synthesis? Respond with one of:
- AGREE — if you accept this approach
- DISAGREE: <your specific objection and alternative> — if you reject it
- PARTIAL: <what you accept> / <what you contest> — if you partially agree

Then explain your reasoning.

IMPORTANT: ONLY read and analyze. Do NOT modify any files.
```

Dispatch to all participants using the same pattern as Step 2b (parallel fan-out with `run_in_background: true`).

Output ID for round N: `cr-{SESSION_ID}-p{i}-rN`

Collect responses using the same sequential pattern as Step 3.

Return to **Step 4** with the new responses.

---

## Step 6: Present Results & Cleanup

### Present final results to user:

**If consensus reached:**
```
## Consensus Reached (Round {N}/{max_rounds})

All {count} participants agree on the following approach:

{final_synthesis}

### Participant Positions:
- Claude: AGREE
- {preset}/{model} (p0): AGREE
- {preset}/{model} (p1): AGREE
```

**If max rounds exhausted without full consensus:**
```
## Debate Complete — No Full Consensus (Round {max_rounds}/{max_rounds})

### Best Synthesis:
{final_synthesis}

### Remaining Disagreements:
- {preset}/{model} (p1): DISAGREE — {reason}

### Areas of Agreement:
{agreed_points}
```

### Cleanup

Remove THIS session's output files only:
```bash
rm -f "{TMPDIR}/.vcp/oneshot/cr-{SESSION_ID}-"*
```

---

## Known Limitations

1. **Participant repo mutation:** Both API participants (via api-task-runner's Write/Edit/Bash tools) and CLI participants (via their native shell access, e.g., Codex `--full-auto`) retain the ability to modify the repo despite the prompt instruction to only read and analyze. This is prompt-level enforcement only. A structural read-only mode is a follow-up feature.

2. **CLI output noise:** CLI tools may emit banners, ANSI sequences, progress output, or debug text alongside the actual response. The SKILL strips ANSI and searches for consensus keywords anywhere in the response, but noisy output may still confuse synthesis.

3. **Web portal:** Configuration is available via `/dev-buddy-config` web portal (Chatroom tab) or manual editing of `~/.vcp/dev-buddy-chatroom.json`.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No participants configured | Report error, suggest editing `~/.vcp/dev-buddy-chatroom.json` |
| Config validation fails | Report the specific error |
| All external participants fail | Report error to user (quorum not met) |
| Single participant fails | Note failure, continue with remaining (if quorum met) |
| Max rounds exhausted | Present best synthesis with disagreements noted |

---

## Anti-Patterns

- Do NOT issue multiple TaskOutput calls in the same message — cascade failure
- Do NOT use a fixed heredoc delimiter like `TASK_EOF` — generates a random one per dispatch
- Do NOT cleanup files from OTHER sessions — only clean `cr-{SESSION_ID}-*`
- Do NOT skip Claude's own position — Claude is always a participant
- Do NOT fall back to foreground Bash for background tasks — always use `run_in_background: true` + TaskOutput polling
- Do NOT use the default TaskOutput timeout (30s) — always compute from preset's `timeout_ms`
