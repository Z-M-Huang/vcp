## Project: VCP (Vibe Coding Protocol)

### What This Repo Is

Standards, skills, and enforcement tools for AI coding assistants.
Target: Claude Code marketplace first, other tools later.

### Enforcement Model

VCP enforces standards through three layers:

1. **Proactive context** — Standards injected at session start (`security-context.ts`) and available manually (`/vcp-context`) so the AI internalizes rules while writing code
2. **On-demand scanning** — Skills (`/vcp-audit`, `/vcp-dependency-check`, `/vcp-pre-commit-review`, `/vcp-review-tests`) scan code against 41 standards across 12 scopes
3. **Real-time blocking** — `security-gate.ts` hook runs on every Write/Edit/Bash call, blocking hardcoded secrets, SQL injection, eval injection, insecure deserialization, innerHTML XSS, XPath injection, prototype pollution, SSTI, and obfuscated shell execution (21 patterns across 9 CWEs)

### Plugin Structure

- `plugins/vcp/` — VCP plugin with 10 skills, 1 agent, and 4 hooks
- `plugins/dev-buddy/` — Dev Buddy plugin with 5 skills, 7 agents, and 2 hooks
- Skills fetch standards from `standards/manifest.json` at runtime via WebFetch (always latest from main)
- `.vcp/config.json` in project root configures scopes, compliance frameworks, severity threshold, and CWE ignore list
- `security-gate.ts` exits 2 (block) on pattern match, 0 (allow) otherwise
- `stop-reminder.ts` reminds user to run VCP checks before committing

### Repo Structure

- `standards/` — AI-optimized markdown standards (41 files across 12 scopes, flat layout with `{scope}-{topic}.md` naming)
- `standards/manifest.json` — Root manifest indexing per-scope manifests in `standards/scopes/`
- `standards/scopes/` — Per-scope manifest files (core, web-frontend, web-backend, database, mobile, desktop, cli, devops, agentic-ai, compliance-*)
- `plugins/` — Claude Code plugins (vcp, dev-buddy)
- `.claude-plugin/` — Marketplace manifest

### Conventions

- Standards use YAML frontmatter + markdown (see `standards/README.md` for format spec)
- Every planned work item is tracked as a GitHub issue
- README.md roadmap links to issues
- Every folder has a README.md that indexes its contents

### Dev Buddy API Task Runner

The API task runner (`plugins/dev-buddy/scripts/api-task-runner.ts`) is a per-invocation script that creates a V2 Agent SDK session, runs one task, outputs the result as JSON to stdout, and exits. Each invocation is an independent process — multiple instances can run in parallel safely.

**Env var mapping for API presets:**

| Env Var | Source | Purpose |
|---------|--------|---------|
| `ANTHROPIC_BASE_URL` | `preset.base_url` | Route SDK to external provider |
| `ANTHROPIC_API_KEY` | `preset.api_key` | Authenticate with provider |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `preset.models[0]` | Map haiku alias to provider model |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `preset.models[0]` | Map sonnet alias to provider model |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `preset.models[0]` | Map opus alias to provider model |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `preset.models[0]` | Model for nested subagents |

All aliases set to the same provider model name (**case-sensitive** — e.g., `MiniMax-M2.5` not `minimax-m2.5`).
Claude Code only accepts `haiku`/`sonnet`/`opus` as model identifiers; the env vars map those to the actual provider model.

The subprocess env uses a platform-aware allowlist (not `...process.env`) for clean isolation.
Per-task timeout defaults to 5 minutes, configurable via `ApiPreset.timeout_ms` (set in the web portal under "Task Timeout").
`api-task-runner.ts --task-timeout` receives the preset's timeout value.

The runner also supports `--system-prompt <path>` to append a file (must be under plugin's `docs/` dir) to the session's system prompt — used for review stages to inject centralized review guidelines.

See `plugins/dev-buddy/CLAUDE.md` § "API Task Runner Architecture" for full details.

### Writing Standards

- State the PRINCIPLE and WHY first
- Give recommended patterns with code examples
- Show anti-patterns with explanation of WHY they're wrong
- Be actionable: "Do X" not "Consider X"
- Be AI-parseable: consistent structure, clear headings
