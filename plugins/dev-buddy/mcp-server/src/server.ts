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
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  initRunDir, writeState, readState, listRuns, readLease,
  STATE_SCHEMA_VERSION, type RunState,
} from "./engine/state-store.ts";
import { advance } from "./engine/state-machine.ts";

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
const SERVER_STARTED_AT = new Date().toISOString();

// ─── input guards ──────────────────────────────────────────────────────

function assertAbsolutePath(p: string, field: string): void {
  if (!isAbsolute(p)) {
    throw new Error(`${field} must be an absolute path; got '${p}'`);
  }
}

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

  server.registerTool(
    "ralph_start",
    {
      description: "Create a new Ralph run for a project. Persists initial state under <project_path>/.vcp/ralph/<run-id>/.",
      inputSchema: {
        project_path: z.string().describe("Absolute path to the user's project. State lives under this dir."),
        goal: z.string().describe("Goal description for the Ralph run."),
      },
    },
    async ({ project_path, goal }) => {
      assertAbsolutePath(project_path, "project_path");
      if (!goal.trim()) throw new Error("goal must be non-empty");

      const runId = randomUUID();
      initRunDir(project_path, runId);
      const now = new Date().toISOString();
      const initial: RunState = {
        schema_version: STATE_SCHEMA_VERSION,
        run_id: runId,
        goal,
        project_path,
        status: "pending",
        step: "discover",
        created_at: now,
        updated_at: now,
        subprocess_pids: [],
      };
      writeState(project_path, initial);

      return {
        content: [{ type: "text", text: `Ralph run created: ${runId}` }],
        structuredContent: {
          run_id: runId,
          status: initial.status,
          step: initial.step,
          state_path: join(project_path, ".vcp", "ralph", runId, "state.json"),
        },
      };
    },
  );

  server.registerTool(
    "ralph_next",
    {
      description: "Advance the run by exactly one step. Acquires the step lease, dispatches to the matching engine handler, commits the resulting state, releases the lease.",
      inputSchema: {
        project_path: z.string().describe("Absolute path to the user's project."),
        run_id: z.string().describe("The run id returned by ralph_start."),
      },
    },
    async ({ project_path, run_id }) => {
      assertAbsolutePath(project_path, "project_path");
      const result = await advance(project_path, run_id);
      const text = result.ok
        ? `step '${result.step_run ?? "(none)"}' done; status=${result.status}; next=${result.next_step ?? "complete"}`
        : `step '${result.step_run ?? "(none)"}' failed: ${result.reason ?? "unknown"}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "ralph_list",
    {
      description: "List all Ralph runs in a project, newest first.",
      inputSchema: {
        project_path: z.string().describe("Absolute path to the user's project."),
      },
    },
    async ({ project_path }) => {
      assertAbsolutePath(project_path, "project_path");
      const runs = listRuns(project_path);
      const summary = runs.length === 0
        ? "No Ralph runs found."
        : runs.map((r) => `${r.run_id}  ${r.status}  step=${r.step}  goal="${r.goal}"`).join("\n");
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { runs },
      };
    },
  );

  server.registerTool(
    "ralph_health",
    {
      description: "Report MCP server health. With project_path, includes per-project active-run info and current lease holders.",
      inputSchema: {
        project_path: z.string().optional().describe("Optional absolute path to a project; when provided, the response includes that project's active runs."),
      },
    },
    async ({ project_path }) => {
      const uptime_ms = Date.now() - new Date(SERVER_STARTED_AT).getTime();
      const base = {
        version: "0.6.0",
        started_at: SERVER_STARTED_AT,
        uptime_ms,
      };

      if (!project_path) {
        return {
          content: [{ type: "text", text: `dev-buddy MCP server up; uptime ${uptime_ms} ms` }],
          structuredContent: base,
        };
      }

      assertAbsolutePath(project_path, "project_path");
      const runs = listRuns(project_path);
      const runDetails = runs.map((r) => {
        const lease = readLease(project_path, r.run_id);
        return {
          ...r,
          lease: lease
            ? { owner_id: lease.owner_id, step: lease.step_name, heartbeat_at: lease.heartbeat_at }
            : null,
        };
      });
      const active = runDetails.filter((r) =>
        r.status === "pending" || r.status === "running"
      );

      return {
        content: [{
          type: "text",
          text: `dev-buddy MCP server up; uptime ${uptime_ms} ms; ${runs.length} runs (${active.length} active) in ${project_path}`,
        }],
        structuredContent: { ...base, project_path, runs: runDetails, active_count: active.length },
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
