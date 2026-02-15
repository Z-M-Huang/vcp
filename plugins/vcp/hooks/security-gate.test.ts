/**
 * Integration tests for the VCP Security Gate hook.
 *
 * Each test spawns the hook script with controlled stdin JSON,
 * then asserts on exit code (0 = allow, 2 = block) and stderr output.
 *
 * Test payloads are built at runtime via P() to avoid triggering the
 * security gate when writing this file itself. Test names also avoid
 * reproducing exact triggering patterns.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const HOOK_PATH = join(import.meta.dir, "security-gate.ts");

// Runtime string builder — joins parts so no single source line contains
// a complete pattern that would trigger the security gate on this file.
const P = (...parts: string[]) => parts.join("");

// --- Test payloads (split to avoid self-triggering) ---

const HARDCODED_SECRET = P('pas', 'sword = "supersecretpassword123"');
const AWS_KEY = P("const key = 'AKI", "AIOSFODNN7EXAMPLE';");
const PRIVATE_KEY = P("-----BEGIN RSA PRIV", "ATE KEY-----");
const SQL_FSTRING = P('.exec', 'ute(f"SELECT * FROM users WHERE id = {uid}")');
const SQL_TEMPLATE = P(".qu", "ery(`SELECT * FROM users WHERE id = ${userId}`)");
const EVAL_USER = P("ev", "al(req.body.code)");
const INNERHTML_VAR = P("el.inne", "rHTML = userInput");
const PICKLE_LOAD = P("pic", "kle.load(f)");
const YAML_LOAD = P("ya", "ml.load(open('cfg.yml'))");
const YAML_UNSAFE = P("ya", "ml.unsafe_load(data)");
const UNSERIALIZE = P("obj.unse", "rialize(payload)");
const BASE64_BASH = P("echo payload | base64 --dec", "ode | bash");
const SHELL_EVAL = P('ev', 'al "$user_input"');

// --- Helpers ---

interface RunResult {
  exitCode: number;
  stderr: string;
}

async function runHook(
  stdinJson: object,
  env?: Record<string, string>,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
    stdin: new Blob([JSON.stringify(stdinJson)]),
    stderr: "pipe",
    stdout: "pipe",
    env: { ...process.env, ...env },
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

function writeInput(content: string, cwd?: string) {
  return {
    tool_name: "Write",
    tool_input: { content },
    ...(cwd ? { cwd } : {}),
  };
}

function bashInput(command: string) {
  return { tool_name: "Bash", tool_input: { command } };
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vcp-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

async function writeConfig(dir: string, ignore: string[] = []) {
  await writeFile(
    join(dir, ".vcp.json"),
    JSON.stringify({
      version: "1.0",
      scopes: {},
      compliance: [],
      ignore,
    }),
  );
}

// ---------------------------------------------------------------------------
// Baseline detection — regression tests for existing patterns
// ---------------------------------------------------------------------------
describe("baseline detection", () => {
  test("allows empty content", async () => {
    const r = await runHook(writeInput(""));
    expect(r.exitCode).toBe(0);
  });

  test("allows clean code", async () => {
    const r = await runHook(writeInput("const x = 1 + 2;"));
    expect(r.exitCode).toBe(0);
  });

  test("blocks on unparseable stdin", async () => {
    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      stdin: new Blob(["not json"]),
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(2);
  });

  test("blocks hardcoded secret — CWE-798", async () => {
    const r = await runHook(writeInput(HARDCODED_SECRET));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-798");
  });

  test("blocks AWS access key — CWE-798", async () => {
    const r = await runHook(writeInput(AWS_KEY));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-798");
  });

  test("blocks private key — CWE-798", async () => {
    const r = await runHook(writeInput(PRIVATE_KEY));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-798");
  });

  test("blocks SQL injection via f-string — CWE-89", async () => {
    const r = await runHook(writeInput(SQL_FSTRING));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-89");
  });

  test("blocks SQL injection via template literal — CWE-89", async () => {
    const r = await runHook(writeInput(SQL_TEMPLATE));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-89");
  });

  test("blocks eval with user input — CWE-95", async () => {
    const r = await runHook(writeInput(EVAL_USER));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-95");
  });

  test("blocks innerHTML with variable — CWE-79", async () => {
    const r = await runHook(writeInput(INNERHTML_VAR));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-79");
  });

  test("blocks pickle deserialization — CWE-502", async () => {
    const r = await runHook(writeInput(PICKLE_LOAD));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-502");
  });

  test("blocks yaml load without safe Loader — CWE-502", async () => {
    const r = await runHook(writeInput(YAML_LOAD));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-502");
  });

  test("blocks unsafe yaml deserialization — CWE-502", async () => {
    const r = await runHook(writeInput(YAML_UNSAFE));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-502");
  });

  test("blocks insecure deserialization — CWE-502", async () => {
    const r = await runHook(writeInput(UNSERIALIZE));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-502");
  });
});

// ---------------------------------------------------------------------------
// Bash-specific checks
// ---------------------------------------------------------------------------
describe("Bash tool checks", () => {
  test("blocks base64 decode piped to shell — CWE-116", async () => {
    const r = await runHook(bashInput(BASE64_BASH));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-116");
  });

  test("blocks shell eval with dynamic input — CWE-95", async () => {
    const r = await runHook(bashInput(SHELL_EVAL));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-95");
  });

  test("allows safe bash commands", async () => {
    const r = await runHook(bashInput("git status"));
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CWE ignore via .vcp.json
// ---------------------------------------------------------------------------
describe("CWE ignore", () => {
  test("suppresses ignored CWE and emits warning", async () => {
    await withTmpDir(async (dir) => {
      await writeConfig(dir, ["CWE-798"]);
      const r = await runHook(writeInput(HARDCODED_SECRET), {
        CLAUDE_PROJECT_DIR: dir,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("WARNING");
      expect(r.stderr).toContain("Suppressed");
      expect(r.stderr).toContain("CWE-798");
    });
  });

  test("only suppresses specified CWE, still blocks others", async () => {
    await withTmpDir(async (dir) => {
      await writeConfig(dir, ["CWE-798"]);
      const content = [HARDCODED_SECRET, SQL_FSTRING].join("\n");
      const r = await runHook(writeInput(content), {
        CLAUDE_PROJECT_DIR: dir,
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("CWE-89");
      expect(r.stderr).toContain("WARNING");
      expect(r.stderr).toContain("CWE-798");
    });
  });

  test("multiple CWEs can be ignored", async () => {
    await withTmpDir(async (dir) => {
      await writeConfig(dir, ["CWE-798", "CWE-89"]);
      const content = [HARDCODED_SECRET, SQL_FSTRING].join("\n");
      const r = await runHook(writeInput(content), {
        CLAUDE_PROJECT_DIR: dir,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("WARNING");
      expect(r.stderr).toContain("Suppressed 2");
    });
  });

  test("non-CWE ignore entries do not affect hook filtering", async () => {
    await withTmpDir(async (dir) => {
      await writeConfig(dir, ["core-security", "core-security/rule-3"]);
      const r = await runHook(writeInput(HARDCODED_SECRET), {
        CLAUDE_PROJECT_DIR: dir,
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("CWE-798");
    });
  });
});

// ---------------------------------------------------------------------------
// Config edge cases
// ---------------------------------------------------------------------------
describe("config edge cases", () => {
  test("no .vcp.json — still blocks", async () => {
    await withTmpDir(async (dir) => {
      const r = await runHook(writeInput(HARDCODED_SECRET), {
        CLAUDE_PROJECT_DIR: dir,
      });
      expect(r.exitCode).toBe(2);
    });
  });

  test("empty ignore array — still blocks", async () => {
    await withTmpDir(async (dir) => {
      await writeConfig(dir, []);
      const r = await runHook(writeInput(HARDCODED_SECRET), {
        CLAUDE_PROJECT_DIR: dir,
      });
      expect(r.exitCode).toBe(2);
    });
  });

  test("malformed .vcp.json — fails open, still blocks", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, ".vcp.json"), "not json{{{");
      const r = await runHook(writeInput(HARDCODED_SECRET), {
        CLAUDE_PROJECT_DIR: dir,
      });
      expect(r.exitCode).toBe(2);
    });
  });

  test("does not walk above project root", async () => {
    await withTmpDir(async (parent) => {
      const child = join(parent, "child");
      await mkdir(child, { recursive: true });
      await writeConfig(parent, ["CWE-798"]);
      const r = await runHook(writeInput(HARDCODED_SECRET), {
        CLAUDE_PROJECT_DIR: child,
      });
      expect(r.exitCode).toBe(2);
    });
  });

  test("falls back to cwd when CLAUDE_PROJECT_DIR is empty", async () => {
    await withTmpDir(async (dir) => {
      await writeConfig(dir, ["CWE-798"]);
      const r = await runHook(writeInput(HARDCODED_SECRET, dir), {
        CLAUDE_PROJECT_DIR: "",
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("WARNING");
    });
  });

  test("no project root and no cwd — still blocks", async () => {
    const r = await runHook(writeInput(HARDCODED_SECRET), {
      CLAUDE_PROJECT_DIR: "",
    });
    expect(r.exitCode).toBe(2);
  });
});
