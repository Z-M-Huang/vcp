/**
 * Integration tests for the VCP Security Gate hook.
 *
 * Each test spawns the hook script with controlled stdin JSON,
 * then asserts on exit code (0 = allow, 2 = block), stderr output,
 * and stdout JSON output.
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
const DB_CONN_STRING = P('const url = "mongo', 'db://admin:s3cret@prod-db.example.com:27017/mydb"');
const BEARER_TOKEN = P('"Bearer ', 'eyJhbGciOiJIUzI1NiIsInR5cCI6', 'IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3', 'ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"');
const GOOGLE_API_KEY = P("const key = 'AIza", "SyCnEtHiSiSaFaKeKeY0123456789abcdef';");
const GITHUB_PAT = P("const token = 'ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';");
const XPATH_INJECTION = P('.xpa', 'th(f"/users/user[@name=\'{username}\']")');
const PROTO_POLLUTION = P('obj["__prot', 'o__"] = malicious');
const PROTO_POLLUTION_DOT = P('obj.constr', 'uctor.prototype.isAdmin = true');

// --- Helpers ---

interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
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
  const [stderr, stdout] = await Promise.all([
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

function parseOutput(stdout: string): any {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function writeInput(content: string, cwd?: string, filePath?: string) {
  return {
    tool_name: "Write",
    tool_input: { content, ...(filePath ? { file_path: filePath } : {}) },
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
// New pattern detection (CWE-798 extras, CWE-643, CWE-1321)
// ---------------------------------------------------------------------------
describe("new pattern detection", () => {
  test("blocks database connection string with credentials — CWE-798", async () => {
    const r = await runHook(writeInput(DB_CONN_STRING));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-798");
  });

  test("blocks hardcoded Bearer token — CWE-798", async () => {
    const r = await runHook(writeInput(BEARER_TOKEN));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-798");
  });

  test("blocks Google API key — CWE-798", async () => {
    const r = await runHook(writeInput(GOOGLE_API_KEY));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-798");
  });

  test("blocks GitHub PAT — CWE-798", async () => {
    const r = await runHook(writeInput(GITHUB_PAT));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-798");
  });

  test("blocks XPath injection — CWE-643", async () => {
    const r = await runHook(writeInput(XPATH_INJECTION));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-643");
  });

  test("blocks prototype pollution via bracket notation — CWE-1321", async () => {
    const r = await runHook(writeInput(PROTO_POLLUTION));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-1321");
  });

  test("blocks prototype pollution via dot notation — CWE-1321", async () => {
    const r = await runHook(writeInput(PROTO_POLLUTION_DOT));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-1321");
  });

  // False-positive avoidance tests
  test("allows defensive __proto__ check in condition", async () => {
    const r = await runHook(writeInput(P('if (key === "__prot', 'o__") throw new Error("blocked")')));
    expect(r.exitCode).toBe(0);
  });

  test("allows safe database URL without credentials", async () => {
    const r = await runHook(writeInput('const url = "mongodb://prod-db.example.com:27017/mydb"'));
    expect(r.exitCode).toBe(0);
  });

  test("allows short Bearer placeholder", async () => {
    const r = await runHook(writeInput('"Bearer ${token}"'));
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Documentation file bypass
// ---------------------------------------------------------------------------
describe("documentation file bypass", () => {
  test("allows .md file containing patterns that block code files", async () => {
    const r = await runHook(writeInput(SQL_TEMPLATE, undefined, "/tmp/standards/web-backend-security.md"));
    expect(r.exitCode).toBe(0);
  });

  test("allows .mdx file containing patterns that block code files", async () => {
    const r = await runHook(writeInput(EVAL_USER, undefined, "/docs/guide.mdx"));
    expect(r.exitCode).toBe(0);
  });

  test("allows .txt file containing patterns that block code files", async () => {
    const r = await runHook(writeInput(HARDCODED_SECRET, undefined, "/tmp/issue-body.txt"));
    expect(r.exitCode).toBe(0);
  });

  test("allows .rst file containing patterns that block code files", async () => {
    const r = await runHook(writeInput(PICKLE_LOAD, undefined, "/docs/security.rst"));
    expect(r.exitCode).toBe(0);
  });

  test("still blocks .ts file with the same content", async () => {
    const r = await runHook(writeInput(SQL_TEMPLATE, undefined, "/src/db/users.ts"));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-89");
  });

  test("still blocks when no file_path is provided", async () => {
    const r = await runHook(writeInput(SQL_TEMPLATE));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("CWE-89");
  });

  test("extension check is case-insensitive", async () => {
    const r = await runHook(writeInput(SQL_TEMPLATE, undefined, "/docs/README.MD"));
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CWE ignore via .vcp.json
// ---------------------------------------------------------------------------
describe("CWE ignore", () => {
  test("suppresses ignored CWE and emits warning via stdout JSON", async () => {
    await withTmpDir(async (dir) => {
      await writeConfig(dir, ["CWE-798"]);
      const r = await runHook(writeInput(HARDCODED_SECRET), {
        CLAUDE_PROJECT_DIR: dir,
      });
      expect(r.exitCode).toBe(0);
      const output = parseOutput(r.stdout);
      expect(output).not.toBeNull();
      expect(output.systemMessage).toContain("WARNING");
      expect(output.systemMessage).toContain("Suppressed");
      expect(output.systemMessage).toContain("CWE-798");
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
      // Suppression notice on stdout
      const output = parseOutput(r.stdout);
      expect(output).not.toBeNull();
      expect(output.systemMessage).toContain("WARNING");
      expect(output.systemMessage).toContain("CWE-798");
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
      const output = parseOutput(r.stdout);
      expect(output).not.toBeNull();
      expect(output.systemMessage).toContain("Suppressed 2");
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
      const output = parseOutput(r.stdout);
      expect(output).not.toBeNull();
      expect(output.systemMessage).toContain("WARNING");
    });
  });

  test("no project root and no cwd — still blocks", async () => {
    const r = await runHook(writeInput(HARDCODED_SECRET), {
      CLAUDE_PROJECT_DIR: "",
    });
    expect(r.exitCode).toBe(2);
  });
});
