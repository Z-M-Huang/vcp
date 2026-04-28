# VCP Context Injection

Load and inject VCP rule summaries into context so you write better code from the start.

## Step 1: Resolve Config and Runtime

1. Resolve the project root to an absolute path.
2. Call `resolve_config({ project_path: "<project-root>" })`. If it reports missing or invalid config, stop and tell the user: "No VCP configuration found. Run `/vcp-init` to configure VCP for this project."
3. Call `detect_installation({ host })`. If the tool reports an invalid installation, stop and relay its error. Use the returned `pluginRoot` as the runtime root for bundled scripts in this workflow.

## Step 2: Generate Context

Run the context generation script:
```bash
bun "<pluginRoot>/lib/generate-context.ts" "<project-root>"
```

Replace `<pluginRoot>` with the value from Step 1 and `<project-root>` with the current project root path.

## Step 3: Output Result

Output the script's stdout directly. This is the formatted VCP Standards Context — scope-grouped rule summaries with token budget applied, ignores respected, and a cross-reference to `/vcp-audit`.

The TypeScript module handles all logic: config loading, manifest fetching, standard resolution, ignore filtering, rule extraction, scope grouping, severity ordering, and token budget truncation.
