import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vcp-standalone-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function copyStandalonePlugin(pluginPath: string, dest: string): Promise<void> {
  await cp(join(REPO_ROOT, pluginPath), dest, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const rel = source.slice(join(REPO_ROOT, pluginPath).length + 1);
      const parts = rel.split(/[\\/]/);
      return !parts.includes("node_modules") && !parts.includes(".vcp");
    },
  });
}

async function run(args: string[], options: { cwd: string; stdin?: string }): Promise<RunResult> {
  const proc = Bun.spawn(args, {
    cwd: options.cwd,
    stdin: options.stdin ? new Blob([options.stdin]) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("standalone plugin vendor resolution", () => {
  test("vcp security-gate resolves vendored libraries without repo root or node_modules", async () => {
    await withTmpDir(async (dir) => {
      const pluginRoot = join(dir, "vcp");
      const projectRoot = join(dir, "project");
      await mkdir(projectRoot);
      await copyStandalonePlugin("plugins/vcp", pluginRoot);

      const result = await run(
        ["bun", join(pluginRoot, "hooks", "security-gate.ts")],
        {
          cwd: projectRoot,
          stdin: JSON.stringify({
            tool_name: "Write",
            tool_input: {
              file_path: join(projectRoot, "index.ts"),
              content: "const x = 1;",
            },
            cwd: projectRoot,
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Cannot find module");
    });
  });

  test("dev-buddy shims resolve vendored libraries without repo root or node_modules", async () => {
    await withTmpDir(async (dir) => {
      const pluginRoot = join(dir, "dev-buddy");
      const projectRoot = join(dir, "project");
      await mkdir(projectRoot);
      await copyStandalonePlugin("plugins/dev-buddy", pluginRoot);

      const result = await run(
        [
          "bun",
          "-e",
          [
            "await import('./types/stage-definitions.ts');",
            "await import('./scripts/preset-utils.ts');",
            "console.log('ok');",
          ].join(" "),
        ],
        { cwd: pluginRoot },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
      expect(result.stderr).not.toContain("Cannot find module");
    });
  });
});
