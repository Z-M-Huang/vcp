#!/usr/bin/env bun
/**
 * Dev Buddy MCP server (v0.6.0).
 *
 * Stdio-transport MCP server that exposes Ralph orchestration as
 * cross-host MCP tools (Claude Code + Codex CLI v0.124.0+).
 *
 * Stdout discipline: every tool handler in this server, every transitive
 * import, and every subprocess child must keep stdout reserved for MCP
 * framing. Stray console.log writes go to stderr instead — see the
 * console-redirection at the top of this file.
 *
 * Phase 5a baseline: registers a single `ping` tool that echoes its
 * input. Subsequent phases land state engine, ralph_start / ralph_next /
 * ralph_list, the validator, and the rest of the toolset.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── stdio discipline ──────────────────────────────────────────────────
// Re-route any stray console writes to stderr; only MCP framing should
// land on stdout. Done before any other module evaluates.
console.log = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(" ") + "\n");
console.info = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(" ") + "\n");
console.warn = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(" ") + "\n");

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..");

// ─── server ────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const server = new McpServer(
    { name: "dev-buddy", version: "0.6.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "ping",
    {
      description: "Echo a message back. Smoke-test for confirming the server is up and reachable.",
      inputSchema: {
        message: z.string().describe("The text to echo back."),
      },
    },
    async ({ message }) => {
      const reply = `pong: ${message}`;
      return {
        content: [{ type: "text", text: reply }],
        structuredContent: { reply },
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    // Last-resort: write the fatal error to a file inside the plugin
    // dir. Never to stderr (some hosts surface stderr to the user as
    // an alert) and never to stdout (MCP framing).
    try {
      const logDir = join(PLUGIN_ROOT, "mcp-server", "state");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(
        join(logDir, "fatal.log"),
        `${new Date().toISOString()} ${err?.stack ?? String(err)}\n`,
        { flag: "a" },
      );
    } catch {
      /* swallow — last-resort path must never throw */
    }
    process.exit(1);
  });
}
