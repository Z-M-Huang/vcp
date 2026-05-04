import { describe, expect, test } from "bun:test";
import { mcpDocHostInstructions } from "../mcp-server/src/host-instructions.ts";

describe("mcpDocHostInstructions", () => {
  test("returns Codex re-invocation guidance", () => {
    const text = mcpDocHostInstructions({
      host: "codex",
      command: "generate",
      pluginRoot: "/tmp/mcp-doc",
    });

    expect(text).toContain("Host: Codex CLI");
    expect(text).toContain("Pass `host: \"codex\"`");
    expect(text).toContain("re-invocation flags");
    expect(text).toContain("--apply");
  });

  test("returns Claude interactive guidance", () => {
    const text = mcpDocHostInstructions({
      host: "claude",
      command: "init",
      pluginRoot: "/tmp/mcp-doc",
    });

    expect(text).toContain("Host: Claude Code");
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("Large projects require a scope decision");
  });
});
