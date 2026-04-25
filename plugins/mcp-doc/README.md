# MCP Doc

**Local documentation indexing for AI assistants.**

MCP Doc helps you create a documentation manifest served via [git-doc-mcp](https://github.com/Z-M-Huang/git-doc-mcp), giving AI assistants instant access to your project's documentation through MCP resources and search tools — no manual file hunting required.

![Skills-5](https://img.shields.io/badge/Skills-5-blue?style=flat-square)

## What It Does

MCP Doc scans your project for existing documentation files (READMEs, architecture docs, ADRs, coding standards, etc.) and creates a `.mcp/manifest.yml` that serves them as MCP resources with embedded search tools. The AI can then:

- **Search docs by keyword** — finds matches in titles, section headers, and content
- **Look up docs by source path** — "what documentation applies to `src/api/routes/users.ts`?"
- **Browse the doc tree** — see documentation coverage with filtering by subtree and depth
- **Read specific docs** — access any indexed doc directly as an MCP resource

## Skills

| Command | Description |
|---------|-------------|
| `/mcp-doc-init` | Initialize documentation manifest — scans project, creates `.mcp/manifest.yml` and `.mcp.json`, generates search tools |
| `/mcp-doc-scan [path]` | Report documentation coverage — finds undocumented directories with prioritized recommendations |
| `/mcp-doc-generate <path\|all>` | Generate AI-written READMEs for undocumented directories with sequential review |
| `/mcp-doc-sync` | Sync manifest with current project state — adds new docs, removes stale entries, regenerates tools |
| `/mcp-doc-add-tool` | Create a custom MCP tool with guided workflow — filter by tags, scope, or custom logic |

## How It Works

1. **Discovery** — Scans for `**/*.md`, `**/*.rst`, prioritized files (README, CONTRIBUTING, ARCHITECTURE, ADRs), with smart exclusion of build artifacts and dependencies
2. **Indexing** — Extracts section headers, content excerpts, tags, and scope for each doc
3. **Manifest generation** — Creates `.mcp/manifest.yml` with resources (one per doc) and tools (search, path-lookup, tree-view)
4. **Tool actions** — Generates JavaScript action scripts with embedded search indexes (no filesystem access needed at runtime)
5. **MCP server** — Configures git-doc-mcp in `.mcp.json` to serve the manifest

## What Gets Created

```
your-project/
├── .mcp/
│   ├── manifest.yml          # git-doc-mcp manifest
│   └── actions/
│       ├── search-docs.js    # Keyword + section-level search
│       ├── get-doc-tree.js   # Filterable documentation tree
│       └── get-applicable-docs.js  # Path → relevant docs lookup
└── .mcp.json                 # MCP server config
```

The plugin only creates/manages the `.mcp/` folder. It indexes existing docs wherever they are — inside or outside the project.

## Large Project Support

For projects with 50+ documentation files (e.g., monorepos with multiple teams), the init skill detects the scale and offers scoping strategies:
- Specify include roots (e.g., `packages/my-team`)
- Filter by CODEOWNERS team membership
- Scan everything

## Prerequisites

- **[git-doc-mcp](https://github.com/Z-M-Huang/git-doc-mcp)** v0.2.3+ — the MCP server that serves the manifest. Installed automatically via `npx` when the MCP server starts. Requires Node.js >= 20.11.0.

## Documentation

Full documentation is on the **[VCP Wiki](https://github.com/Z-M-Huang/vcp/wiki)**:

- **[MCP Doc Quick Start](https://github.com/Z-M-Huang/vcp/wiki/MCP-Doc-Quick-Start)** — First-time setup and usage guide
- **[MCP Doc Skills Reference](https://github.com/Z-M-Huang/vcp/wiki/MCP-Doc-Skills-Reference)** — Detailed skill documentation with examples
