import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpDocHostInstructions, MCP_DOC_HOSTS, type McpDocCommand } from "./host-instructions.ts";

export const MCP_DOC_PROMPT_HOSTS = [...MCP_DOC_HOSTS, "auto"] as const;
export type McpDocPromptHost = typeof MCP_DOC_PROMPT_HOSTS[number];

export const MCP_DOC_WORKFLOW_COMMANDS = [
  "mcp-doc-add-tool",
  "mcp-doc-generate",
  "mcp-doc-init",
  "mcp-doc-scan",
  "mcp-doc-sync",
] as const;
export type McpDocWorkflowCommand = typeof MCP_DOC_WORKFLOW_COMMANDS[number];

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, "..", "..");
export const PROMPTS_DIR = resolve(PLUGIN_ROOT, "mcp-server", "prompts");

export function promptName(command: McpDocWorkflowCommand): string {
  return command.replace(/-/g, "_");
}

export function promptPath(command: McpDocWorkflowCommand): string {
  return join(PROMPTS_DIR, `${command}.md`);
}

export function readWorkflowPrompt(command: McpDocWorkflowCommand): string {
  const file = promptPath(command);
  if (!existsSync(file)) {
    throw new Error(`MCP Doc prompt '${command}' not found at ${file}`);
  }
  return readFileSync(file, "utf-8");
}

function hostCommandFor(command: McpDocWorkflowCommand): McpDocCommand {
  switch (command) {
    case "mcp-doc-add-tool":
      return "add-tool";
    case "mcp-doc-generate":
      return "generate";
    case "mcp-doc-init":
      return "init";
    case "mcp-doc-scan":
      return "scan";
    case "mcp-doc-sync":
      return "sync";
  }
}

export interface RenderPromptInput {
  command: McpDocWorkflowCommand;
  host?: McpDocPromptHost;
  arguments?: string;
  projectPath?: string;
}

export function renderWorkflowPrompt(input: RenderPromptInput): string {
  const workflow = readWorkflowPrompt(input.command);
  const host = input.host ?? "auto";
  const args = input.arguments?.trim() ? input.arguments.trim() : "(none)";
  const projectPath = input.projectPath?.trim() ? input.projectPath.trim() : "(caller current project)";
  const hostGuidance = host === "auto"
    ? "Caller host is unknown. Use host-neutral behavior and prefer explicit re-invocation flags when interactive selection is not available."
    : mcpDocHostInstructions({
      host,
      command: hostCommandFor(input.command),
      pluginRoot: PLUGIN_ROOT,
    });

  return [
    "# MCP Doc MCP Workflow Prompt",
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
    "Use MCP Doc MCP tools for deterministic work when available:",
    "- `get_prompt({ command, host, arguments, project_path })` when MCP prompts are not directly exposed by the caller.",
    "- `get_host_instructions({ host, command })` when caller-specific setup guidance is needed.",
    "- The generated git-doc-mcp server remains the source for target-project documentation resources and search tools.",
    "",
    "Do not duplicate workflow logic in slash-command skill prose. Keep command behavior in this prompt or in MCP Doc MCP tools.",
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

export function listPromptMetadata(): Array<{ command: McpDocWorkflowCommand; prompt: string; uri: string; exists: boolean }> {
  return MCP_DOC_WORKFLOW_COMMANDS.map((command) => {
    const file = promptPath(command);
    return {
      command,
      prompt: promptName(command),
      uri: `mcp-doc://prompts/${command}`,
      exists: existsSync(file) && statSync(file).isFile(),
    };
  });
}
