export const DEV_BUDDY_HOSTS = ["claude", "codex"] as const;
export type DevBuddyHost = typeof DEV_BUDDY_HOSTS[number];

export const DEV_BUDDY_COMMANDS = [
  "overview",
  "ralph",
  "config",
  "once",
  "chatroom",
  "legacy-stages",
] as const;
export type DevBuddyCommand = typeof DEV_BUDDY_COMMANDS[number];

export interface DevBuddyInstructionInput {
  host: DevBuddyHost;
  command?: DevBuddyCommand;
  pluginRoot: string;
}

function hostLabel(host: DevBuddyHost): string {
  return host === "codex" ? "Codex CLI" : "Claude Code";
}

function hostSpecificNotes(host: DevBuddyHost): string {
  if (host === "codex") {
    return [
      "Codex caller notes:",
      "- Pass `host: \"codex\"` when requesting Dev Buddy instructions.",
      "- Do not rely on MCP resources being automatically injected into context; call paired tools such as `get_run_state`, `get_stage_definition`, and `list_presets`.",
      "- If Dev Buddy MCP tools are unavailable, register the `dev-buddy` MCP server from the plugin manifest in `~/.codex/config.toml`, then restart Codex.",
      "- Prefer MCP tools over legacy skills that reference `CLAUDE_PLUGIN_ROOT` or Claude-only Task primitives.",
    ].join("\n");
  }

  return [
    "Claude Code caller notes:",
    "- Pass `host: \"claude\"` when requesting Dev Buddy instructions.",
    "- Claude may surface prompts and resources directly, but tools remain the authoritative execution path.",
    "- If Dev Buddy MCP tools are unavailable, run `/mcp restart dev-buddy` and retry.",
    "- Legacy stage skills still exist for Claude-only workflows, but `/dev-buddy-ralph` should use MCP tools.",
  ].join("\n");
}

function commandNotes(command: DevBuddyCommand): string {
  switch (command) {
    case "ralph":
      return [
        "Ralph workflow:",
        "- Resolve the project path to an absolute path before calling MCP tools.",
        "- Call `ralph_start({ project_path, goal })` once and keep the returned `run_id`.",
        "- Call `ralph_next({ project_path, run_id })` until it reports `status: complete`, `next_step: null`, or `status: failed`.",
        "- Use `get_run_state({ project_path, run_id })` for inspection instead of reading state files directly.",
      ].join("\n");
    case "config":
      return [
        "Config workflow:",
        "- `/dev-buddy-config` starts the localhost-only configuration portal.",
        "- MCP currently exposes config inspection through `list_presets`; portal mutations still run through the skill/script path.",
        "- Keep stdout reserved for MCP framing when adding server-side config tools.",
      ].join("\n");
    case "once":
      return [
        "One-shot workflow:",
        "- `/dev-buddy-once` dispatches a single task through the configured preset.",
        "- API presets run through Vercel AI SDK providers; CLI presets run in the project directory.",
        "- For long CLI runs, use background execution from the skill rather than a foreground shell timeout.",
      ].join("\n");
    case "chatroom":
      return [
        "Chatroom workflow:",
        "- `/dev-buddy-chatroom` fans a topic out to configured AI participants and synthesizes consensus.",
        "- Treat participant repo mutation as possible unless a preset is structurally read-only.",
        "- Use configured system prompts rather than embedding provider-specific prompt text in the caller.",
      ].join("\n");
    case "legacy-stages":
      return [
        "Legacy stage workflow:",
        "- The per-stage skills (`discover`, `requirements`, `decompose`, `build`, `code-review`, `uat`) are legacy/transition paths.",
        "- They still reference Claude-oriented execution in places and should not be the default Codex path.",
        "- Prefer `ralph_start` and `ralph_next` for cross-host orchestration.",
      ].join("\n");
    case "overview":
    default:
      return [
        "Default workflow:",
        "- Use MCP tools as the source of truth for cross-host Dev Buddy behavior.",
        "- Use `ralph_start`, `ralph_next`, `ralph_list`, and `ralph_health` for Ralph runs.",
        "- Use paired resource tools in Codex because resources may not be auto-injected.",
      ].join("\n");
  }
}

export function devBuddyHostInstructions(input: DevBuddyInstructionInput): string {
  const command = input.command ?? "overview";
  return [
    "# Dev Buddy Host Instructions",
    "",
    `Host: ${hostLabel(input.host)}`,
    `Plugin root: ${input.pluginRoot}`,
    `Command focus: ${command}`,
    "",
    "Principle:",
    "The caller supplies the active assistant host. Dev Buddy returns host-specific instructions instead of making slash-skill prose infer Claude vs Codex behavior.",
    "",
    hostSpecificNotes(input.host),
    "",
    commandNotes(command),
  ].join("\n");
}
