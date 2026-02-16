/**
 * Integration tests for the VCP Security Context hook (SessionStart).
 *
 * Each test spawns the hook script and asserts on exit code and output.
 * This hook calls generateContext() which may make network requests.
 * Tests handle both network-available and network-unavailable scenarios.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const HOOK_PATH = join(import.meta.dir, "security-context.ts");

// --- Helpers ---

interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function runHook(env?: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
    env: { ...process.env, ...env },
  });
  const exitCode = await proc.exited;
  const [stderr, stdout] = await Promise.all([
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

// ---------------------------------------------------------------------------
// SessionStart hook tests
// ---------------------------------------------------------------------------
describe("security-context SessionStart hook", () => {
  test("outputs VCP context to stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vcp-test-"));
    try {
      const r = await runHook({ CLAUDE_PROJECT_DIR: dir });
      expect(r.stdout.length).toBeGreaterThan(0);
      expect(r.stdout).toContain("VCP");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("always exits 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vcp-test-"));
    try {
      const r = await runHook({ CLAUDE_PROJECT_DIR: dir });
      expect(r.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("outputs nothing to stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vcp-test-"));
    try {
      const r = await runHook({ CLAUDE_PROJECT_DIR: dir });
      expect(r.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
