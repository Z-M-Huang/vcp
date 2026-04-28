export const MCP_DOC_HOSTS = ["claude", "codex"] as const;
export type McpDocHost = typeof MCP_DOC_HOSTS[number];

export const MCP_DOC_COMMANDS = [
  "overview",
  "init",
  "scan",
  "generate",
  "sync",
  "add-tool",
] as const;
export type McpDocCommand = typeof MCP_DOC_COMMANDS[number];

export interface McpDocInstructionInput {
  host: McpDocHost;
  command?: McpDocCommand;
  pluginRoot: string;
}

function hostLabel(host: McpDocHost): string {
  return host === "codex" ? "Codex CLI" : "Claude Code";
}

function hostSpecificNotes(host: McpDocHost): string {
  if (host === "codex") {
    return [
      "Codex caller notes:",
      "- Pass `host: \"codex\"` when requesting MCP Doc instructions.",
      "- Do not rely on MCP resources being automatically injected into context; call `get_host_instructions` or this prompt explicitly.",
      "- For multi-step skills, use the printed re-invocation flags (`--scope`, `--apply`, `--select`, `--exclude`, `--skip`) instead of expecting interactive prompts.",
      "- After `/mcp-doc-init`, project documentation is served by the generated git-doc-mcp server from the target project's `.mcp.json`.",
    ].join("\n");
  }

  return [
    "Claude Code caller notes:",
    "- Pass `host: \"claude\"` when requesting MCP Doc instructions.",
    "- Use `AskUserQuestion` for interactive choices when the skill requires user confirmation or selection.",
    "- If this MCP guidance server is unavailable, run `/mcp restart mcp-doc` and retry.",
    "- After `/mcp-doc-init`, project documentation is served by the generated git-doc-mcp server from the target project's `.mcp.json`.",
  ].join("\n");
}

function commandNotes(command: McpDocCommand): string {
  switch (command) {
    case "init":
      return [
        "Init workflow:",
        "- Scan docs, build `.mcp/manifest.yml`, generate default action scripts, and merge a git-doc-mcp entry into `.mcp.json`.",
        "- Large projects require a scope decision before writing the manifest.",
        "- Claude should ask interactively; Codex should stop with the exact `--scope` flag to re-run.",
      ].join("\n");
    case "scan":
      return [
        "Scan workflow:",
        "- Read `.mcp/manifest.yml`, compare it with current docs, and report documented, stale, and undocumented directories.",
        "- This is read-only and can run directly through the deterministic scan runner.",
        "- If no manifest exists, direct the user to `/mcp-doc-init`.",
      ].join("\n");
    case "generate":
      return [
        "Generate workflow:",
        "- Generate READMEs for one directory or selected undocumented directories.",
        "- Claude may ask accept/edit/skip for each draft.",
        "- Codex should write drafts to `.mcp/draft-readme-<path>.md` and ask the user to re-run with `--apply` or `--skip`.",
      ].join("\n");
    case "sync":
      return [
        "Sync workflow:",
        "- Detect new docs, stale manifest entries, and changed docs, then regenerate action scripts.",
        "- Claude should ask whether to apply all or deselect entries.",
        "- Codex should print the indexed proposal and wait for `--apply` or `--exclude <indices>`.",
      ].join("\n");
    case "add-tool":
      return [
        "Add-tool workflow:",
        "- Guide creation of a custom git-doc-mcp manifest tool and action script.",
        "- Claude can collect requirements interactively.",
        "- Codex should collect required values through flags and only write on `--apply`.",
      ].join("\n");
    case "overview":
    default:
      return [
        "Default workflow:",
        "- MCP Doc's plugin MCP server provides host-aware guidance.",
        "- The target project's generated git-doc-mcp server serves documentation resources and search tools.",
        "- Keep `.mcp/manifest.yml` and `.mcp/actions/` as the source of truth for generated documentation indexing.",
      ].join("\n");
  }
}

export function mcpDocHostInstructions(input: McpDocInstructionInput): string {
  const command = input.command ?? "overview";
  return [
    "# MCP Doc Host Instructions",
    "",
    `Host: ${hostLabel(input.host)}`,
    `Plugin root: ${input.pluginRoot}`,
    `Command focus: ${command}`,
    "",
    "Principle:",
    "The caller supplies the active assistant host. MCP Doc returns host-specific instructions instead of making static skill prose infer Claude vs Codex behavior.",
    "",
    hostSpecificNotes(input.host),
    "",
    commandNotes(command),
  ].join("\n");
}
