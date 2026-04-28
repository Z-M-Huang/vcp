import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VCP_HOSTS = ["claude", "codex", "auto"] as const;
export type VcpHost = typeof VCP_HOSTS[number];

export const VCP_COMMANDS = [
  "vcp-init",
  "vcp-config",
  "vcp-context",
  "vcp-audit",
  "vcp-pre-commit-review",
  "vcp-dependency-check",
  "vcp-review-tests",
  "vcp-test-plan",
  "vcp-root-cause-check",
  "vcp-coverage-gaps",
  "migration-planner",
] as const;
export type VcpCommand = typeof VCP_COMMANDS[number];

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, "..", "..");
export const PROMPTS_DIR = resolve(PLUGIN_ROOT, "mcp-server", "prompts");

export function promptName(command: VcpCommand): string {
  return command.replace(/-/g, "_");
}

export function promptPath(command: VcpCommand): string {
  return join(PROMPTS_DIR, `${command}.md`);
}

export function readWorkflowPrompt(command: VcpCommand): string {
  const file = promptPath(command);
  if (!existsSync(file)) {
    throw new Error(`VCP prompt '${command}' not found at ${file}`);
  }
  return readFileSync(file, "utf-8");
}

export interface RenderPromptInput {
  command: VcpCommand;
  host?: VcpHost;
  arguments?: string;
  projectPath?: string;
}

export function renderWorkflowPrompt(input: RenderPromptInput): string {
  const workflow = readWorkflowPrompt(input.command);
  const host = input.host ?? "auto";
  const args = input.arguments?.trim() ? input.arguments.trim() : "(none)";
  const projectPath = input.projectPath?.trim() ? input.projectPath.trim() : "(caller current project)";

  return [
    "# VCP MCP Workflow Prompt",
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
    "Use VCP MCP tools for deterministic work when available:",
    "- `detect_installation({ host })` to identify this VCP MCP server's plugin root and required runtime files.",
    "- `validate_plugin_root({ plugin_root })` to validate any legacy `pluginRoot` value before using it.",
    "- `resolve_config({ project_path })` to resolve `.vcp/config.json`, global defaults, applicable standards, severity, ignore rules, and excludes.",
    "- `get_prompt({ command, host, arguments, project_path })` when MCP prompts are not directly exposed by the caller.",
    "",
    "Do not duplicate caller-dependent path or confirmation behavior in slash-command skill prose. If behavior differs by host, keep that behavior in this prompt or in VCP MCP tools.",
    "",
    "## Workflow",
    "",
    workflow.trim(),
    "",
  ].join("\n");
}

export function listPromptMetadata(): Array<{ command: VcpCommand; prompt: string; uri: string; exists: boolean }> {
  return VCP_COMMANDS.map((command) => {
    const file = promptPath(command);
    return {
      command,
      prompt: promptName(command),
      uri: `vcp://prompts/${command}`,
      exists: existsSync(file) && statSync(file).isFile(),
    };
  });
}
