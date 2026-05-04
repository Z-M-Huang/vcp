import { describe, expect, test } from "bun:test";
import { devBuddyHostInstructions } from "../src/host-instructions.ts";

describe("devBuddyHostInstructions", () => {
  test("returns Codex-specific tool guidance", () => {
    const text = devBuddyHostInstructions({
      host: "codex",
      command: "ralph",
      pluginRoot: "/tmp/dev-buddy",
    });

    expect(text).toContain("Host: Codex CLI");
    expect(text).toContain("Pass `host: \"codex\"`");
    expect(text).toContain("Do not rely on MCP resources being automatically injected");
    expect(text).toContain("ralph_start");
  });

  test("returns Claude-specific setup guidance", () => {
    const text = devBuddyHostInstructions({
      host: "claude",
      command: "legacy-stages",
      pluginRoot: "/tmp/dev-buddy",
    });

    expect(text).toContain("Host: Claude Code");
    expect(text).toContain("/mcp restart dev-buddy");
    expect(text).toContain("legacy/transition paths");
  });
});
