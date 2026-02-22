/**
 * Tests for the VCP Logger utility.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { vcpLog } from "./vcp-logger";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vcp-log-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe("vcpLog", () => {
  test("creates .vcp/vcp.log in project root", async () => {
    await withTmpDir(async (dir) => {
      await vcpLog(dir, {
        source: "test",
        event: "TestEvent",
        decision: "info",
        details: "hello",
      }, true);
      const content = await readFile(join(dir, ".vcp", "vcp.log"), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    });
  });

  test("appends log entries", async () => {
    await withTmpDir(async (dir) => {
      await vcpLog(dir, {
        source: "test",
        event: "Event1",
        decision: "info",
        details: "first",
      }, true);
      await vcpLog(dir, {
        source: "test",
        event: "Event2",
        decision: "warn",
        details: "second",
      }, true);
      const content = await readFile(join(dir, ".vcp", "vcp.log"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("first");
      expect(lines[1]).toContain("second");
    });
  });

  test("log entry format matches expected pattern", async () => {
    await withTmpDir(async (dir) => {
      await vcpLog(dir, {
        source: "security-gate",
        event: "PreToolUse",
        decision: "block",
        details: "CWE-798",
      }, true);
      const content = await readFile(join(dir, ".vcp", "vcp.log"), "utf-8");
      // Format: ISO_TIMESTAMP [event] source: decision — details
      expect(content).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[PreToolUse\] security-gate: block — CWE-798\n$/,
      );
    });
  });

  test("does not throw on write failure", async () => {
    // Pass a nonexistent directory — should silently fail
    await vcpLog("/nonexistent/path/that/does/not/exist", {
      source: "test",
      event: "TestEvent",
      decision: "info",
      details: "should not throw",
    }, true);
    // If we reach here without throwing, the test passes
  });

  test("skips logging when projectRoot is empty", async () => {
    // Should no-op silently, not create .vcp/vcp.log in CWD
    await vcpLog("", {
      source: "test",
      event: "TestEvent",
      decision: "info",
    }, true);
    // If we reach here without throwing, the test passes
  });

  test("skips logging when projectRoot is relative", async () => {
    await vcpLog("relative/path", {
      source: "test",
      event: "TestEvent",
      decision: "info",
    }, true);
    // If we reach here without throwing, the test passes
  });

  test("omits details when not provided", async () => {
    await withTmpDir(async (dir) => {
      await vcpLog(dir, {
        source: "test",
        event: "TestEvent",
        decision: "allow",
      }, true);
      const content = await readFile(join(dir, ".vcp", "vcp.log"), "utf-8");
      expect(content).not.toContain(" — ");
      expect(content).toMatch(/allow\n$/);
    });
  });

  test("skips logging when debug is false", async () => {
    await withTmpDir(async (dir) => {
      await vcpLog(dir, {
        source: "test",
        event: "TestEvent",
        decision: "info",
        details: "should not appear",
      }, false);
      const { access } = await import("fs/promises");
      let exists = true;
      try {
        await access(join(dir, ".vcp", "vcp.log"));
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });
  });

  test("skips logging when debug is omitted (defaults to false)", async () => {
    await withTmpDir(async (dir) => {
      await vcpLog(dir, {
        source: "test",
        event: "TestEvent",
        decision: "info",
      });
      const { access } = await import("fs/promises");
      let exists = true;
      try {
        await access(join(dir, ".vcp", "vcp.log"));
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });
  });
});
