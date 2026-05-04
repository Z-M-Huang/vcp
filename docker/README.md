# VCP Docker

A containerized AI development environment with **Claude Code**, **OpenAI Codex CLI**, **Google Gemini CLI**, and essential dev tools — ready to use in seconds.

## What's Inside

| Tool | Description |
|------|-------------|
| **[Claude Code](https://claude.ai)** | Anthropic's CLI for Claude (official binary) |
| **[OpenAI Codex CLI](https://github.com/openai/codex)** | OpenAI's terminal coding assistant |
| **[Google Gemini CLI](https://github.com/google-gemini/gemini-cli)** | Google's CLI for Gemini |
| **[Bun](https://bun.sh/)** | Fast JavaScript runtime (required for VCP hooks, skills, and MCP servers) |
| **TypeScript** | `typescript` + `ts-node` globally installed |
| **Git** | Version control with SSH support |
| **GitHub CLI** | `gh` — PRs, issues, actions from the terminal |
| **tmux** | Terminal multiplexer (mouse mode enabled) |
| **ripgrep** | Fast file content search |

**Base image:** `ubuntu:24.04` with Node.js 22 (NodeSource).

## Quick Start

### 1. Copy the environment template

```bash
cd docker/
cp .env.example .env
```

### 2. Configure `.env`

Set your host directories and API keys:

```env
# ── Host Directories ────────────────────────────────────
HOST_PROJECTS_DIR=./code               # Your project code → /app
HOST_SSH_DIR=~/.ssh                     # SSH keys (mounted read-only)
HOST_CLAUDE_DATA_DIR=./vcp-claude-code-data  # Claude Code persistent data
HOST_TMP_DIR=./vcp-tmp                  # Temporary files

# ── API Keys (at least one required) ────────────────────
ANTHROPIC_API_KEY=sk-ant-...            # Claude Code
OPENAI_API_KEY=sk-...                   # Codex CLI (optional)
GEMINI_API_KEY=...                      # Gemini CLI (optional)
```

### 3. Start the container

```bash
docker compose up -d
```

### 4. Attach to the container

```bash
docker exec -it vcp-docker bash
```

You're now inside the container at `/app` with all tools available.

## Using Claude Code

Claude Code runs with `--dangerously-skip-permissions` by default (via shell alias) since the container provides isolation.

```bash
# Start Claude Code in your project
cd /app/your-project
claude

# Or run a one-shot command
claude "explain this codebase"
```

### Installing VCP Plugins

Inside the container:

```
/plugin marketplace add Z-M-Huang/vcp
/plugin install vcp@vcp
/vcp-init
```

## Using OpenAI Codex CLI

Codex CLI is installed globally. VCP plugins for Codex are discovered from `~/.codex/plugins`, so install the repo there inside the container:

```bash
git clone https://github.com/Z-M-Huang/vcp ~/.codex/plugins/vcp
cd ~/.codex/plugins/vcp
bun install

cd /app/your-project
codex
```

Inside Codex, use dollar-prefixed skills such as `$vcp-init`, `$vcp-audit`, and `$dev-buddy-ralph`. Codex MCP servers are registered through each plugin's `.codex-plugin/plugin.json` and `.mcp.json`.

The default compose file persists Claude Code data through `HOST_CLAUDE_DATA_DIR`. If you also want Codex plugin/config data to survive container deletion, add a host mount for `/home/devuser/.codex` in `docker-compose.yml`.

## Using Other Tools

```bash
# Google Gemini CLI (requires GEMINI_API_KEY)
gemini
```

## Volume Mounts

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `HOST_PROJECTS_DIR` | `/app` | Your project code (read-write) |
| `HOST_SSH_DIR` | `/home/devuser/.ssh` | SSH keys for git (read-only) |
| `HOST_CLAUDE_DATA_DIR` | `/home/devuser/.claude` | Claude Code settings, plugins, conversation history |
| `HOST_TMP_DIR` | `/home/devuser/tmp` | Temporary files |

**Important:** The Claude data directory (`HOST_CLAUDE_DATA_DIR`) persists your installed plugins, settings, and CLAUDE.md project memories across container restarts. Codex uses `/home/devuser/.codex`; mount that path separately if you need Codex plugin state to persist after deleting the container.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude Code API key |

### Optional

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_BASE_URL` | Override Claude API endpoint (for proxies/third-party providers) |
| `OPENAI_API_KEY` | OpenAI Codex CLI API key |
| `OPENAI_BASE_URL` | Override OpenAI API endpoint |
| `GEMINI_API_KEY` | Google Gemini CLI API key |
| `GOOGLE_API_KEY` | Google Cloud API key (takes precedence over `GEMINI_API_KEY`) |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud project ID (for Vertex AI) |

## Using tmux

The container includes tmux with mouse mode enabled. Run multiple AI assistants side by side:

```bash
# Start a tmux session
tmux new -s dev

# Split vertically: Ctrl+B then %
# Split horizontally: Ctrl+B then "
# Switch panes: Ctrl+B then arrow keys
# Or just click with mouse (mouse mode is on)
```

## Networking

The container uses `network_mode: host` — it shares the host's network stack directly. This means:

- The container can access `localhost` services on your host (databases, dev servers)
- No port mapping is needed
- On Linux, this works natively; on macOS/Windows with Docker Desktop, host networking behaves differently — check [Docker documentation](https://docs.docker.com/engine/network/drivers/host/)

## Building from Source

To build the image locally instead of pulling from Docker Hub:

```bash
cd docker/
docker compose build
docker compose up -d
```

Or build directly:

```bash
docker build -t vcp-docker .
```

## Platform Notes

### Windows

Use forward-slash paths in `.env` (backslashes can cause volume mount errors):

```env
HOST_PROJECTS_DIR=D:/Code
HOST_SSH_DIR=C:/Users/yourname/.ssh
HOST_CLAUDE_DATA_DIR=D:/vcp-data/.claude
HOST_TMP_DIR=D:/vcp-data/tmp
```

### macOS / Linux

Use standard paths:

```env
HOST_PROJECTS_DIR=~/code
HOST_SSH_DIR=~/.ssh
HOST_CLAUDE_DATA_DIR=~/.vcp-docker/claude
HOST_TMP_DIR=~/.vcp-docker/tmp
```

## Container Details

- **Image:** [`zhironghuang/vcp:latest`](https://hub.docker.com/r/zhironghuang/vcp)
- **User:** `devuser` (non-root, with passwordless `sudo` for package installs)
- **Shell:** `bash`
- **Init:** `tini` (proper signal handling, zombie process reaping)
- **Auto-updater:** Disabled (`DISABLE_AUTOUPDATER=1`)
- **Restart policy:** `unless-stopped`
