## Project: VCP (Vibe Coding Protocol)

### What This Repo Is

Standards, skills, and enforcement tools for AI coding assistants.
Target: Claude Code marketplace first, other tools later.

### Enforcement Model

VCP enforces standards through three layers:

1. **Proactive context** — Standards injected at session start (`security-context.ts`) and available manually (`/vcp-context`) so the AI internalizes rules while writing code
2. **On-demand scanning** — Skills (`/vcp-audit`, `/vcp-dependency-check`, `/vcp-pre-commit-review`, `/vcp-review-tests`) scan code against 32 standards across 9 scopes
3. **Real-time blocking** — `security-gate.ts` hook runs on every Write/Edit/Bash call, blocking hardcoded secrets, SQL injection, eval injection, insecure deserialization, innerHTML XSS, XPath injection, prototype pollution, and obfuscated shell execution (19 patterns across 9 CWEs)

### Plugin Structure

- `plugins/vcp/` — VCP plugin with 10 skills, 1 agent, and 4 hooks
- `plugins/dev-buddy/` — Dev Buddy plugin with 4 skills, 7 agents, and 2 hooks
- Skills fetch standards from `standards/manifest.json` at runtime via WebFetch (always latest from main)
- `.vcp/config.json` in project root configures scopes, compliance frameworks, severity threshold, and CWE ignore list
- `security-gate.ts` exits 2 (block) on pattern match, 0 (allow) otherwise
- `stop-reminder.ts` reminds user to run VCP checks before committing

### Repo Structure

- `standards/` — AI-optimized markdown standards (32 files, flat layout with `{scope}-{topic}.md` naming)
- `standards/manifest.json` — Root manifest indexing per-scope manifests in `standards/scopes/`
- `standards/scopes/` — Per-scope manifest files (core, web-frontend, web-backend, database, mobile, desktop, cli, devops, compliance-*)
- `plugins/` — Claude Code plugins (vcp, dev-buddy)
- `.claude-plugin/` — Marketplace manifest

### Conventions

- Standards use YAML frontmatter + markdown (see `standards/README.md` for format spec)
- Every planned work item is tracked as a GitHub issue
- README.md roadmap links to issues
- Every folder has a README.md that indexes its contents

### Writing Standards

- State the PRINCIPLE and WHY first
- Give recommended patterns with code examples
- Show anti-patterns with explanation of WHY they're wrong
- Be actionable: "Do X" not "Consider X"
- Be AI-parseable: consistent structure, clear headings

# READ README.md FOR PROJECT DETAILS
