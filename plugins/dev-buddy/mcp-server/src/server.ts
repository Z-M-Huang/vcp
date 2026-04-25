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
import { writeFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  initRunDir, writeState, readState, listRuns, readLease,
  STATE_SCHEMA_VERSION, type RunState,
} from "./engine/state-store.ts";
import { advance } from "./engine/state-machine.ts";
import { loadStageDefinition } from "@vcp-lib/prompt-assets";
import { readPresets, maskPresetKeys } from "@vcp-lib/llm-runner/presets";

// stdout discipline lives in bootstrap.ts — that file's `console.log = ...`
// statements run before this module's static imports do, so noise from any
// transitively-imported module is captured. This file should not write to
// stdout outside the MCP framing layer regardless.

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..");
const STAGES_DIR = resolve(PLUGIN_ROOT, "stages");
const SERVER_STARTED_AT = new Date().toISOString();

// ─── input guards ──────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate run_id is a UUID. Tools take run_id from MCP callers, then
 * join it into filesystem paths under .vcp/ralph/<run_id>/. Without
 * this check, a caller could pass `run_id="../../etc"` and escape the
 * run directory. randomUUID() always produces valid UUIDs, so legitimate
 * runs created via ralph_start are unaffected.
 */
export function assertValidRunId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`run_id must be a UUID; got '${id}'`);
  }
}

/**
 * Canonicalize a project_path argument: must be absolute, must exist,
 * must be a directory. Returns the canonical (realpath-resolved) path.
 *
 * This blocks two abuse patterns: (1) relative paths the server would
 * resolve against its own cwd; (2) symlink-to-symlink chains where the
 * caller-visible path differs from where the server actually writes.
 *
 * Callers must use the returned canonical path for state operations.
 */
export function assertProjectPath(p: string, field: string): string {
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
  let s;
  try {
    s = statSync(real);
  } catch (err) {
    throw new Error(`${field} cannot be stat'd: '${p}' (${(err as Error).message})`);
  }
  if (!s.isDirectory()) {
    throw new Error(`${field} is not a directory: '${p}'`);
  }
  return real;
}

/** @deprecated Kept for source compatibility; new code uses assertProjectPath. */
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
      const projectRoot = assertProjectPath(project_path, "project_path");
      if (!goal.trim()) throw new Error("goal must be non-empty");

      const runId = randomUUID();
      initRunDir(projectRoot, runId);
      const now = new Date().toISOString();
      const initial: RunState = {
        schema_version: STATE_SCHEMA_VERSION,
        run_id: runId,
        goal,
        project_path: projectRoot,
        status: "pending",
        step: "discover",
        created_at: now,
        updated_at: now,
        subprocess_pids: [],
      };
      writeState(projectRoot, initial);

      return {
        content: [{ type: "text", text: `Ralph run created: ${runId}` }],
        structuredContent: {
          run_id: runId,
          status: initial.status,
          step: initial.step,
          state_path: join(projectRoot, ".vcp", "ralph", runId, "state.json"),
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
      const projectRoot = assertProjectPath(project_path, "project_path");
      assertValidRunId(run_id);
      const result = await advance(projectRoot, run_id);
      const text = result.ok
        ? `step '${result.step_run ?? "(none)"}' done; status=${result.status}; next=${result.next_step ?? "complete"}`
        : `step '${result.step_run ?? "(none)"}' failed: ${result.reason ?? "unknown"}`;
      return {
        content: [{ type: "text", text }],
        // structuredContent has nullable fields (next_step, step_run);
        // SDK's CallToolResult.structuredContent is unknown so widen.
        structuredContent: result as unknown as Record<string, unknown>,
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
      const projectRoot = assertProjectPath(project_path, "project_path");
      const runs = listRuns(projectRoot);
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

      const projectRoot = assertProjectPath(project_path, "project_path");
      const runs = listRuns(projectRoot);
      const runDetails = runs.map((r) => {
        const lease = readLease(projectRoot, r.run_id);
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
          text: `dev-buddy MCP server up; uptime ${uptime_ms} ms; ${runs.length} runs (${active.length} active) in ${projectRoot}`,
        }],
        structuredContent: { ...base, project_path: projectRoot, runs: runDetails, active_count: active.length },
      };
    },
  );

  // ─── Resource/tool duality ────────────────────────────────────────
  // Phase 0 probe 12 confirmed Codex does NOT auto-inject MCP
  // resources into the LLM context. Every resource exposed below ALSO
  // has a paired get_*/list_* tool so Codex callers can reach the
  // same data via tool calls.

  server.registerTool(
    "get_run_state",
    {
      description: "Read a Ralph run's state.json. Same content as the dev-buddy://runs/<id>/state resource.",
      inputSchema: {
        project_path: z.string().describe("Absolute path to the user's project."),
        run_id: z.string().describe("The run id."),
      },
    },
    async ({ project_path, run_id }) => {
      const projectRoot = assertProjectPath(project_path, "project_path");
      assertValidRunId(run_id);
      const state = readState(projectRoot, run_id);
      if (!state) {
        return {
          content: [{ type: "text", text: `run ${run_id} not found in ${projectRoot}` }],
          structuredContent: { found: false, run_id, project_path: projectRoot },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
        structuredContent: state as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "get_stage_definition",
    {
      description: "Read a Ralph stage definition (frontmatter + body) from plugins/dev-buddy/stages/. Same content as the dev-buddy://stages/<name> resource.",
      inputSchema: {
        stage: z.string().describe("Stage name: discovery, ralph-requirements, decomposition, ralph-build, ralph-code-review, ralph-uat, unit-review."),
      },
    },
    async ({ stage }) => {
      const stageDef = loadStageDefinition(stage, STAGES_DIR);
      if (!stageDef) {
        return {
          content: [{ type: "text", text: `stage definition '${stage}' not found at ${STAGES_DIR}` }],
          structuredContent: { found: false, stage },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: stageDef.content }],
        structuredContent: stageDef as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "list_presets",
    {
      description: "List configured AI presets from ~/.vcp/ai-presets.json. API keys are masked. Same content as the dev-buddy://presets resource.",
      inputSchema: {},
    },
    async () => {
      const config = readPresets();
      const masked = Object.fromEntries(
        Object.entries(config.presets).map(([name, preset]) => [name, maskPresetKeys(preset)]),
      );
      const summary = Object.entries(config.presets)
        .map(([name, p]) => `${name} (${p.type})`)
        .join("\n");
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { version: config.version, presets: masked },
      };
    },
  );

  // ─── Resources (Claude auto-injects; Codex must use the get_*/list_* tools above) ──

  server.registerResource(
    "runs",
    "dev-buddy://runs",
    { description: "All Ralph runs in a project, newest first.", mimeType: "application/json" },
    async (uri) => {
      const url = new URL(uri.href);
      const project_path = url.searchParams.get("project_path");
      if (!project_path) {
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "missing project_path query param" }) }],
        };
      }
      let projectRoot: string;
      try {
        projectRoot = assertProjectPath(project_path, "project_path");
      } catch (err) {
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: (err as Error).message }) }],
        };
      }
      const runs = listRuns(projectRoot);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(runs, null, 2) }],
      };
    },
  );

  server.registerResource(
    "presets",
    "dev-buddy://presets",
    { description: "Configured AI presets (API keys masked).", mimeType: "application/json" },
    async (uri) => {
      const config = readPresets();
      const masked = Object.fromEntries(
        Object.entries(config.presets).map(([name, p]) => [name, maskPresetKeys(p)]),
      );
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ version: config.version, presets: masked }, null, 2) }],
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
