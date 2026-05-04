#!/usr/bin/env bun
/**
 * MCP Doc guidance MCP server.
 *
 * This server does not replace the generated git-doc-mcp server that
 * serves a target project's `.mcp/manifest.yml`. It exposes host-aware
 * prompt/resource/tool guidance for MCP Doc's plugin skills.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpDocHostInstructions, MCP_DOC_COMMANDS, MCP_DOC_HOSTS } from "./host-instructions.ts";
import {
  MCP_DOC_PROMPT_HOSTS,
  MCP_DOC_WORKFLOW_COMMANDS,
  listPromptMetadata,
  promptName,
  renderWorkflowPrompt,
} from "./prompt-registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..");
const SERVER_STARTED_AT = new Date().toISOString();

export async function main(): Promise<void> {
  const server = new McpServer(
    { name: "mcp-doc", version: "0.6.0" },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: "Fetch MCP Doc workflow prompts from this MCP server; SKILL.md files are slash-command launchers.",
    },
  );

  const hostSchema = z.enum(MCP_DOC_HOSTS);
  const promptHostSchema = z.enum(MCP_DOC_PROMPT_HOSTS);
  const commandSchema = z.enum(MCP_DOC_COMMANDS);
  const workflowCommandSchema = z.enum(MCP_DOC_WORKFLOW_COMMANDS);

  server.registerTool(
    "ping",
    {
      description: "Echo a message back. Smoke-test for confirming the MCP Doc guidance server is reachable.",
      inputSchema: {
        message: z.string().describe("The text to echo back."),
      },
    },
    async ({ message }) => {
      const reply = `pong: ${message}`;
      return {
        content: [{ type: "text", text: reply }],
        structuredContent: { reply, started_at: SERVER_STARTED_AT },
      };
    },
  );

  server.registerTool(
    "list_prompts",
    {
      description: "List MCP Doc workflow prompts exposed by this MCP server.",
      inputSchema: {},
    },
    async () => {
      const prompts = listPromptMetadata();
      return {
        content: [{ type: "text", text: prompts.map((p) => `${p.prompt} (${p.command})`).join("\n") }],
        structuredContent: { prompts },
      };
    },
  );

  server.registerTool(
    "get_prompt",
    {
      description: "Return an MCP Doc workflow prompt. Use this when MCP prompts are not directly exposed by the caller.",
      inputSchema: {
        command: workflowCommandSchema.describe("The MCP Doc command/workflow prompt to fetch."),
        host: promptHostSchema.optional().describe("Caller-supplied host. Use 'auto' if unknown."),
        arguments: z.string().optional().describe("Raw slash-command arguments, if any."),
        project_path: z.string().optional().describe("Absolute project path, if known."),
      },
    },
    async ({ command, host, arguments: args, project_path }) => {
      const text = renderWorkflowPrompt({ command, host, arguments: args, projectPath: project_path });
      return {
        content: [{ type: "text", text }],
        structuredContent: { command, prompt: promptName(command), host: host ?? "auto", project_path, instructions: text },
      };
    },
  );

  server.registerTool(
    "get_host_instructions",
    {
      description: "Return MCP Doc instructions tailored to the caller host. The caller must pass host='claude' or host='codex'.",
      inputSchema: {
        host: hostSchema.describe("The assistant host requesting instructions."),
        command: commandSchema.optional().describe("Optional command focus for the returned instructions."),
      },
    },
    async ({ host, command }) => {
      const text = mcpDocHostInstructions({ host, command, pluginRoot: PLUGIN_ROOT });
      return {
        content: [{ type: "text", text }],
        structuredContent: { host, command: command ?? "overview", pluginRoot: PLUGIN_ROOT, instructions: text },
      };
    },
  );

  server.registerPrompt(
    "host_instructions",
    {
      title: "Host-specific MCP Doc instructions",
      description: "Prompt text for using MCP Doc from Claude Code or Codex CLI.",
      argsSchema: {
        host: hostSchema.describe("The assistant host requesting instructions."),
        command: commandSchema.optional().describe("Optional command focus for the returned instructions."),
      },
    },
    async ({ host, command }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: mcpDocHostInstructions({ host, command, pluginRoot: PLUGIN_ROOT }),
        },
      }],
    }),
  );

  for (const host of MCP_DOC_HOSTS) {
    server.registerResource(
      `host_instructions_${host}`,
      `mcp-doc://host-instructions/${host}`,
      {
        description: `MCP Doc host instructions for ${host}.`,
        mimeType: "text/markdown",
      },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          mimeType: "text/markdown",
          text: mcpDocHostInstructions({ host, pluginRoot: PLUGIN_ROOT }),
        }],
      }),
    );
  }

  for (const command of MCP_DOC_WORKFLOW_COMMANDS) {
    server.registerPrompt(
      promptName(command),
      {
        title: `MCP Doc ${command}`,
        description: `Workflow prompt for ${command}.`,
        argsSchema: {
          host: promptHostSchema.optional().describe("Caller-supplied host. Use 'auto' if unknown."),
          arguments: z.string().optional().describe("Raw slash-command arguments, if any."),
          project_path: z.string().optional().describe("Absolute project path, if known."),
        },
      },
      async ({ host, arguments: args, project_path }) => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: renderWorkflowPrompt({ command, host, arguments: args, projectPath: project_path }),
          },
        }],
      }),
    );

    server.registerResource(
      promptName(command),
      `mcp-doc://prompts/${command}`,
      {
        description: `MCP Doc workflow prompt for ${command}.`,
        mimeType: "text/markdown",
      },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          mimeType: "text/markdown",
          text: renderWorkflowPrompt({ command }),
        }],
      }),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
