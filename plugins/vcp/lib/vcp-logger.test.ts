/**
 * Tests for the VCP Logger utility.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, access } from "fs/promises";
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

async function fileExistsAt(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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
      expect(await fileExistsAt(join(dir, ".vcp", "vcp.log"))).toBe(false);
    });
  });

  test("skips logging when debug is omitted (defaults to false)", async () => {
    await withTmpDir(async (dir) => {
      await vcpLog(dir, {
        source: "test",
        event: "TestEvent",
        decision: "info",
      });
      expect(await fileExistsAt(join(dir, ".vcp", "vcp.log"))).toBe(false);
    });
  });
});

describe("log rotation", () => {
  test("rotates when file exceeds 2MB", async () => {
    await withTmpDir(async (dir) => {
      const logDir = join(dir, ".vcp");
      const { mkdir } = await import("fs/promises");
      await mkdir(logDir, { recursive: true });
      const logFile = join(logDir, "vcp.log");

      // Write a 2MB+ file to trigger rotation
      const bigContent = "x".repeat(2 * 1024 * 1024 + 1);
      await writeFile(logFile, bigContent);

      // This write should trigger rotation
      await vcpLog(dir, {
        source: "test",
        event: "AfterRotation",
        decision: "info",
        details: "new entry",
      }, true);

      // Original content should now be in .log.1
      expect(await fileExistsAt(logFile + ".1")).toBe(true);
      const rotatedContent = await readFile(logFile + ".1", "utf-8");
      expect(rotatedContent.length).toBeGreaterThan(2 * 1024 * 1024);

      // Current .log should have only the new entry
      const currentContent = await readFile(logFile, "utf-8");
      expect(currentContent).toContain("AfterRotation");
      expect(currentContent.length).toBeLessThan(200);
    });
  });

  test("keeps at most 3 versions", async () => {
    await withTmpDir(async (dir) => {
      const logDir = join(dir, ".vcp");
      const { mkdir } = await import("fs/promises");
      await mkdir(logDir, { recursive: true });
      const logFile = join(logDir, "vcp.log");

      // Pre-create .log.1 and .log.2
      await writeFile(logFile + ".1", "version-1-content\n");
      await writeFile(logFile + ".2", "version-2-content\n");

      // Write a 2MB+ file to trigger rotation
      const bigContent = "y".repeat(2 * 1024 * 1024 + 1);
      await writeFile(logFile, bigContent);

      await vcpLog(dir, {
        source: "test",
        event: "Rotate3",
        decision: "info",
      }, true);

      // .log.2 should now contain what was .log.1 (version-1-content)
      const v2 = await readFile(logFile + ".2", "utf-8");
      expect(v2).toContain("version-1-content");

      // .log.1 should contain the 2MB+ content
      const v1 = await readFile(logFile + ".1", "utf-8");
      expect(v1.length).toBeGreaterThan(2 * 1024 * 1024);

      // .log should have the new entry
      const current = await readFile(logFile, "utf-8");
      expect(current).toContain("Rotate3");

      // No .log.3 should exist
      expect(await fileExistsAt(logFile + ".3")).toBe(false);
    });
  });

  test("does not rotate when under 2MB", async () => {
    await withTmpDir(async (dir) => {
      const logDir = join(dir, ".vcp");
      const { mkdir } = await import("fs/promises");
      await mkdir(logDir, { recursive: true });
      const logFile = join(logDir, "vcp.log");

      // Write a small file (under 2MB)
      await writeFile(logFile, "small content\n");

      await vcpLog(dir, {
        source: "test",
        event: "NoRotation",
        decision: "info",
      }, true);

      // No rotation should have occurred
      expect(await fileExistsAt(logFile + ".1")).toBe(false);

      // Content should be appended
      const content = await readFile(logFile, "utf-8");
      expect(content).toContain("small content");
      expect(content).toContain("NoRotation");
    });
  });
});
