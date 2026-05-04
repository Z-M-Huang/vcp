import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devBuddyHostInstructions, DEV_BUDDY_HOSTS, type DevBuddyCommand } from "./host-instructions.ts";

export const DEV_BUDDY_PROMPT_HOSTS = [...DEV_BUDDY_HOSTS, "auto"] as const;
export type DevBuddyPromptHost = typeof DEV_BUDDY_PROMPT_HOSTS[number];

export const DEV_BUDDY_WORKFLOW_COMMANDS = [
  "dev-buddy-build",
  "dev-buddy-chatroom",
  "dev-buddy-code-review",
  "dev-buddy-config",
  "dev-buddy-decompose",
  "dev-buddy-discover",
  "dev-buddy-once",
  "dev-buddy-plan-lint",
  "dev-buddy-ralph",
  "dev-buddy-requirements",
  "dev-buddy-uat",
] as const;
export type DevBuddyWorkflowCommand = typeof DEV_BUDDY_WORKFLOW_COMMANDS[number];

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, "..", "..");
export const PROMPTS_DIR = resolve(PLUGIN_ROOT, "mcp-server", "prompts");

export function promptName(command: DevBuddyWorkflowCommand): string {
  return command.replace(/-/g, "_");
}

export function promptPath(command: DevBuddyWorkflowCommand): string {
  return join(PROMPTS_DIR, `${command}.md`);
}

export function readWorkflowPrompt(command: DevBuddyWorkflowCommand): string {
  const file = promptPath(command);
  if (!existsSync(file)) {
    throw new Error(`Dev Buddy prompt '${command}' not found at ${file}`);
  }
  return readFileSync(file, "utf-8");
}

function hostCommandFor(command: DevBuddyWorkflowCommand): DevBuddyCommand {
  switch (command) {
    case "dev-buddy-ralph":
      return "ralph";
    case "dev-buddy-config":
      return "config";
    case "dev-buddy-once":
      return "once";
    case "dev-buddy-chatroom":
      return "chatroom";
    default:
      return "legacy-stages";
  }
}

export interface RenderPromptInput {
  command: DevBuddyWorkflowCommand;
  host?: DevBuddyPromptHost;
  arguments?: string;
  projectPath?: string;
}

export function renderWorkflowPrompt(input: RenderPromptInput): string {
  const workflow = readWorkflowPrompt(input.command);
  const host = input.host ?? "auto";
  const args = input.arguments?.trim() ? input.arguments.trim() : "(none)";
  const projectPath = input.projectPath?.trim() ? input.projectPath.trim() : "(caller current project)";
  const hostGuidance = host === "auto"
    ? "Caller host is unknown. Use host-neutral behavior and prefer MCP tools over host-specific assumptions."
    : devBuddyHostInstructions({
      host,
      command: hostCommandFor(input.command),
      pluginRoot: PLUGIN_ROOT,
    });

  return [
    "# Dev Buddy MCP Workflow Prompt",
    "",
    `Command: ${input.command}`,
    `Caller host: ${host}`,
    `Project path: ${projectPath}`,
    `Command arguments: ${args}`,
    "",
    "## MCP Tool Contract",
    "",
    "This prompt is the source of truth for the workflow. Slash-command skill files are only launchers.",
    "",
    "Use Dev Buddy MCP tools for deterministic work when available:",
    "- `get_prompt({ command, host, arguments, project_path })` when MCP prompts are not directly exposed by the caller.",
    "- `get_host_instructions({ host, command })` when caller-specific setup guidance is needed.",
    "- `ralph_start`, `ralph_next`, `ralph_list`, `ralph_health`, and `get_run_state` for Ralph runs.",
    "- `get_stage_definition` for stage prompt bodies and `list_presets` for configured AI presets.",
    "",
    "Do not duplicate workflow logic in slash-command skill prose. Keep command behavior in this prompt or in Dev Buddy MCP tools.",
    "",
    "## Caller Guidance",
    "",
    hostGuidance,
    "",
    "## Workflow",
    "",
    workflow.trim(),
    "",
  ].join("\n");
}

export function listPromptMetadata(): Array<{ command: DevBuddyWorkflowCommand; prompt: string; uri: string; exists: boolean }> {
  return DEV_BUDDY_WORKFLOW_COMMANDS.map((command) => {
    const file = promptPath(command);
    return {
      command,
      prompt: promptName(command),
      uri: `dev-buddy://prompts/${command}`,
      exists: existsSync(file) && statSync(file).isFile(),
    };
  });
}
