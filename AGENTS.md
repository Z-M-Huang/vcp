## Project: VCP (Vibe Coding Protocol)

### What This Repo Is

Standards, skills, and enforcement tools for AI coding assistants.
Primary hosts: Claude Code marketplace and OpenAI Codex CLI plugins.

### Enforcement Model

VCP enforces standards through three layers:

1. **Proactive context** — Standards injected at session start (`security-context.ts`) and available manually (`/vcp-context`) so the AI internalizes rules while writing code
2. **On-demand scanning** — Skills (`/vcp-audit`, `/vcp-dependency-check`, `/vcp-pre-commit-review`, `/vcp-review-tests`) scan code against 41 standards across 12 scopes
3. **Real-time blocking** — `security-gate.ts` hook runs on every Write/Edit/Bash call, blocking hardcoded secrets, SQL injection, eval injection, insecure deserialization, innerHTML XSS, XPath injection, prototype pollution, SSTI, and obfuscated shell execution (21 patterns across 9 CWEs)

### Plugin Structure

- `plugins/vcp/` — VCP plugin with 10 skills, 1 agent, and 4 hooks
- `plugins/dev-buddy/` — Dev Buddy plugin with 11 skills, 8 stage definitions (6 Ralph pipeline stages plus `plan-lint` and optional `unit-review`), 7 role prompts, and 0 hooks. Uses Ralph loop architecture: Discovery → Requirements+UAT → Decomposition → Plan-lint → Build (inner loop with optional unit review) → Code Review → UAT (outer loop). `/dev-buddy-ralph` runs the legacy Claude stage-skill workflow; the MCP server exposes the cross-host skeleton Ralph path (`ralph_start`, `ralph_next`, `ralph_list`, `ralph_health`). Multi-AI diversity at each stage via executor-based dispatch. Build uses immutable per-unit plan files plus persisted per-unit JSON state with fresh context per iteration and mechanical backpressure. Config format v5 (`~/.vcp/dev-buddy.json`) with auto-migration from v2/v3/v4.
- `plugins/mcp-doc/` — MCP Doc plugin with 5 skills. Documentation manifest generator for git-doc-mcp — indexes project docs as MCP resources with embedded search, path-lookup, and tree-view tools
- Skills fetch standards from `standards/manifest.json` at runtime via WebFetch (always latest from main)
- Each plugin has `.claude-plugin/plugin.json` for Claude Code and `.codex-plugin/plugin.json` plus `.mcp.json` for Codex plugin/MCP registration
- `.vcp/config.json` in project root configures scopes, compliance frameworks, severity threshold, and CWE ignore list
- `security-gate.ts` exits 2 (block) on pattern match, 0 (allow) otherwise
- `stop-reminder.ts` reminds user to run VCP checks before committing

### Repo Structure

- `standards/` — AI-optimized markdown standards (41 files across 12 scopes, flat layout with `{scope}-{topic}.md` naming)
- `standards/manifest.json` — Root manifest indexing per-scope manifests in `standards/scopes/`
- `standards/scopes/` — Per-scope manifest files (core, web-frontend, web-backend, database, mobile, desktop, cli, devops, agentic-ai, compliance-*)
- `plugins/` — Host-aware plugins (vcp, dev-buddy, mcp-doc) for Claude Code and Codex CLI
- `.claude-plugin/` — Claude Code marketplace manifest

### Conventions

- Standards use YAML frontmatter + markdown (see `standards/README.md` for format spec)
- Every planned work item is tracked as a GitHub issue
- README.md roadmap links to issues
- Every folder has a README.md that indexes its contents

### Dev Buddy API Task Runner

The API task runner (`plugins/dev-buddy/scripts/api-task-runner.ts`) runs one task per invocation, outputs the result as JSON to stdout, and exits. Each invocation is an independent process — multiple instances can run in parallel safely.

A single `UnifiedRunner` implements the `AgentRunner` interface using Vercel AI SDK's `generateText()` with agentool-provided tools (read, write, edit, bash, glob, grep). The `protocol` field (`'anthropic'` | `'openai'`) selects the Vercel AI SDK provider constructor (`@ai-sdk/anthropic` or `@ai-sdk/openai`). Credentials are passed directly to the provider — no env var mapping or subprocess isolation.

Per-task timeout defaults to 5 minutes, configurable via `ApiPreset.timeout_ms` (set in the web portal under "Task Timeout").
`api-task-runner.ts --task-timeout` receives the preset's timeout value.

The runner also supports `--system-prompt <path>` to append a file (must be under the plugin directory) to the session's system prompt — used to inject role prompts and review guidelines. Combined with `--stage-type <type>`, this auto-resolves the stage definition and composes `stage + role` as the system prompt.

### Writing Standards

- State the PRINCIPLE and WHY first
- Give recommended patterns with code examples
- Show anti-patterns with explanation of WHY they're wrong
- Be actionable: "Do X" not "Consider X"
- Be AI-parseable: consistent structure, clear headings
