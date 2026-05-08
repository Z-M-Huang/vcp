#!/usr/bin/env bun
/**
 * VCP MCP server.
 *
 * Exposes VCP workflow prompts as reusable MCP prompts/resources/tools, and
 * keeps deterministic host/path/config checks out of SKILL.md files.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  listPromptMetadata,
  PLUGIN_ROOT,
  promptName,
  renderWorkflowPrompt,
  VCP_COMMANDS,
  VCP_HOSTS,
  type VcpCommand,
} from "./prompt-registry.ts";

const SERVER_STARTED_AT = new Date().toISOString();
const SAFE_PATH_RE = /^[A-Za-z0-9/\\._:\- ]+$/;

function assertProjectPath(p: string, field: string): string {
  if (!isAbsolute(p)) {
    throw new Error(`${field} must be an absolute path; got '${p}'`);
  }
  let real: string;
  try {
    real = realpathSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${field} does not exist: '${p}'`);
    }
    throw err;
  }
  const s = statSync(real);
  if (!s.isDirectory()) {
    throw new Error(`${field} is not a directory: '${p}'`);
  }
  return real;
}

function validatePluginRoot(pluginRoot: string): {
  ok: boolean;
  pluginRoot: string;
  realPath?: string;
  missing: string[];
  reason?: string;
} {
  if (!isAbsolute(pluginRoot)) {
    return { ok: false, pluginRoot, missing: [], reason: "pluginRoot must be absolute" };
  }
  if (!SAFE_PATH_RE.test(pluginRoot)) {
    return { ok: false, pluginRoot, missing: [], reason: "pluginRoot contains unsafe path characters" };
  }

  let realPath: string;
  try {
    realPath = realpathSync(pluginRoot);
  } catch (err) {
    return { ok: false, pluginRoot, missing: [], reason: `pluginRoot cannot be resolved: ${(err as Error).message}` };
  }

  const required = [
    "lib/vcp-context-core.ts",
    "lib/resolve-config.ts",
    "lib/generate-context.ts",
    "scripts/audit-runner.ts",
  ];
  const missing = required.filter((p) => !existsSync(join(realPath, p)));
  return {
    ok: missing.length === 0,
    pluginRoot,
    realPath,
    missing,
    reason: missing.length ? "pluginRoot is missing required VCP runtime files" : undefined,
  };
}

export async function main(): Promise<void> {
  const server = new McpServer(
    { name: "vcp", version: "0.6.1" },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: "Fetch VCP workflow prompts from this MCP server; SKILL.md files are only slash-command launchers.",
    },
  );

  const hostSchema = z.enum(VCP_HOSTS);
  const commandSchema = z.enum(VCP_COMMANDS);

  server.registerTool(
    "ping",
    {
      description: "Echo a message back. Smoke-test for confirming the VCP MCP server is reachable.",
      inputSchema: { message: z.string().describe("The text to echo back.") },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `pong: ${message}` }],
      structuredContent: { reply: `pong: ${message}`, started_at: SERVER_STARTED_AT },
    }),
  );

  server.registerTool(
    "list_prompts",
    {
      description: "List VCP workflow prompts exposed by this MCP server.",
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
      description: "Return a VCP workflow prompt. Use this when MCP prompts are not directly exposed by the caller.",
      inputSchema: {
        command: commandSchema.describe("The VCP command/workflow prompt to fetch."),
        host: hostSchema.optional().describe("Caller-supplied host. Use 'auto' if unknown."),
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
    "detect_installation",
    {
      description: "Return this VCP MCP server's installation root and required runtime file status.",
      inputSchema: {
        host: hostSchema.optional().describe("Caller-supplied host. Recorded for diagnostics only."),
      },
    },
    async ({ host }) => {
      const validation = validatePluginRoot(PLUGIN_ROOT);
      let version = "unknown";
      try {
        const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf-8"));
        if (typeof pkg.version === "string") version = pkg.version;
      } catch {
        // Leave version unknown; validation output still identifies the root.
      }
      return {
        content: [{ type: "text", text: `${validation.ok ? "VCP installation OK" : "VCP installation invalid"}: ${PLUGIN_ROOT}` }],
        structuredContent: { host: host ?? "auto", version, ...validation },
        isError: !validation.ok,
      };
    },
  );

  server.registerTool(
    "validate_plugin_root",
    {
      description: "Validate a legacy pluginRoot before using it in a VCP workflow.",
      inputSchema: {
        plugin_root: z.string().describe("Absolute plugin root path to validate."),
      },
    },
    async ({ plugin_root }) => {
      const validation = validatePluginRoot(plugin_root);
      return {
        content: [{ type: "text", text: validation.ok ? `pluginRoot OK: ${validation.realPath}` : `pluginRoot invalid: ${validation.reason}` }],
        structuredContent: validation,
        isError: !validation.ok,
      };
    },
  );

  server.registerTool(
    "resolve_config",
    {
      description: "Resolve VCP project config using the existing resolve-config runtime.",
      inputSchema: {
        project_path: z.string().describe("Absolute path to the project root."),
      },
    },
    async ({ project_path }) => {
      const projectRoot = assertProjectPath(project_path, "project_path");
      const result = spawnSync("bun", [join(PLUGIN_ROOT, "lib", "resolve-config.ts"), projectRoot], {
        cwd: projectRoot,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      if (result.status !== 0) {
        const err = result.stderr.trim() || result.stdout.trim() || `resolve-config exited ${result.status}`;
        return {
          content: [{ type: "text", text: err }],
          structuredContent: { ok: false, project_path: projectRoot, error: err, status: result.status },
          isError: true,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = { raw: result.stdout };
      }
      return {
        content: [{ type: "text", text: result.stdout.trim() }],
        structuredContent: { ok: true, project_path: projectRoot, result: parsed },
      };
    },
  );

  for (const command of VCP_COMMANDS) {
    server.registerPrompt(
      promptName(command),
      {
        title: `VCP ${command}`,
        description: `Workflow prompt for ${command}.`,
        argsSchema: {
          host: hostSchema.optional().describe("Caller-supplied host. Use 'auto' if unknown."),
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
      `vcp://prompts/${command}`,
      {
        description: `VCP workflow prompt for ${command}.`,
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
