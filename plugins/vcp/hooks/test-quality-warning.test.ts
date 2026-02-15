/**
 * Integration tests for the VCP Test Quality Warning hook.
 *
 * Each test spawns the hook script with controlled stdin JSON,
 * then asserts on exit code (always 0) and stderr output.
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";

const HOOK_PATH = join(import.meta.dir, "test-quality-warning.ts");

// --- Helpers ---

interface RunResult {
  exitCode: number;
  stderr: string;
}

async function runHook(stdinJson: object): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
    stdin: new Blob([JSON.stringify(stdinJson)]),
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

function writePayload(filePath: string, content: string) {
  return { tool_name: "Write", tool_input: { file_path: filePath, content } };
}

function editPayload(filePath: string, newString: string) {
  return {
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "old", new_string: newString },
  };
}

// --- Test file path detection ---

describe("test file detection", () => {
  const cleanContent = 'test("works", () => { expect(1).toBe(1); });';

  test("detects .test.ts files", async () => {
    const result = await runHook(writePayload("/src/foo.test.ts", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("detects .spec.js files", async () => {
    const result = await runHook(writePayload("/src/foo.spec.js", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("detects Python test_*.py files at root", async () => {
    const result = await runHook(writePayload("test_user.py", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("detects Python test_*.py files in subdirectory", async () => {
    const result = await runHook(writePayload("/tests/test_user.py", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("detects __tests__ directory (Unix paths)", async () => {
    const result = await runHook(writePayload("/src/__tests__/foo.ts", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("detects __tests__ directory (Windows paths)", async () => {
    const result = await runHook(
      writePayload("C:\\repo\\__tests__\\foo.ts", cleanContent),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("detects Go *_test.go files", async () => {
    const result = await runHook(writePayload("/src/handler_test.go", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("detects Java *Test.java files", async () => {
    const result = await runHook(writePayload("/src/UserTest.java", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("detects Ruby *_spec.rb files", async () => {
    const result = await runHook(writePayload("/spec/user_spec.rb", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("detects Rust *_test.rs files", async () => {
    const result = await runHook(writePayload("/src/handler_test.rs", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("ignores non-test files", async () => {
    const result = await runHook(writePayload("/src/app.ts", cleanContent));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("ignores non-test files even with mock content", async () => {
    const content =
      'jest.fn(); jest.fn(); jest.fn(); jest.fn(); mock.assert_called_once();';
    const result = await runHook(writePayload("/src/service.ts", content));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

// --- Tool type handling ---

describe("tool type handling", () => {
  const mockHeavy =
    'jest.fn(); jest.fn(); jest.fn(); jest.fn(); jest.fn(); mock.assert_called_once();';

  test("processes Write tool calls", async () => {
    const result = await runHook(writePayload("/src/foo.test.ts", mockHeavy));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("VCP Test Quality Warning");
  });

  test("processes Edit tool calls", async () => {
    const result = await runHook(editPayload("/src/foo.test.ts", mockHeavy));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("VCP Test Quality Warning");
  });

  test("ignores Bash tool calls", async () => {
    const result = await runHook({
      tool_name: "Bash",
      tool_input: { command: "echo test" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("ignores Read tool calls", async () => {
    const result = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/src/foo.test.ts" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

// --- Always exits 0 ---

describe("exit code", () => {
  test("exits 0 for clean test file", async () => {
    const result = await runHook(
      writePayload(
        "/src/foo.test.ts",
        'test("adds numbers", () => { expect(add(1,2)).toBe(3); });',
      ),
    );
    expect(result.exitCode).toBe(0);
  });

  test("exits 0 even with warnings", async () => {
    const result = await runHook(
      writePayload(
        "/src/foo.test.ts",
        'jest.fn(); jest.fn(); jest.fn(); jest.fn(); jest.fn();',
      ),
    );
    expect(result.exitCode).toBe(0);
  });

  test("exits 0 for invalid JSON", async () => {
    const proc = Bun.spawn(["bun", "run", HOOK_PATH], {
      stdin: new Blob(["not json"]),
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(0);
  });

  test("exits 0 for empty content", async () => {
    const result = await runHook(writePayload("/src/foo.test.ts", ""));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

// --- Pattern 1: Excessive mocking ---

describe("excessive mocking detection", () => {
  test("warns when more than 3 mock setup calls", async () => {
    const content = [
      'const mockA = jest.fn();',
      'const mockB = jest.fn();',
      'const mockC = jest.fn();',
      'const mockD = jest.fn();',
      'expect(mockA).toHaveBeenCalled();',
    ].join("\n");
    const result = await runHook(writePayload("/src/foo.test.ts", content));
    expect(result.stderr).toContain("Excessive mocking");
    expect(result.stderr).toContain("Rule 4");
  });

  test("does not warn with 3 or fewer mock setup calls", async () => {
    const content = [
      'const mockA = jest.fn();',
      'const mockB = jest.fn();',
      'const mockC = jest.fn();',
      'expect(result).toBe(42);',
    ].join("\n");
    const result = await runHook(writePayload("/src/foo.test.ts", content));
    expect(result.stderr).not.toContain("Excessive mocking");
  });

  test("counts various mock setup patterns", async () => {
    const content = [
      'const a = jest.fn();',
      'const b = vi.fn();',
      'spyOn(obj, "method");',
      'sinon.stub(obj, "method");',
      'expect(result).toBe(1);',
    ].join("\n");
    const result = await runHook(writePayload("/src/foo.test.ts", content));
    expect(result.stderr).toContain("Excessive mocking");
  });

  test("counts Python mock patterns", async () => {
    const content = [
      'with patch("module.Class") as mock_a:',
      '    with patch("module.Other") as mock_b:',
      '        mock_a.return_value = 1',
      '        mock_b.return_value = 2',
      '        mock_c = Mock()',
      '        assert result == 42',
    ].join("\n");
    const result = await runHook(writePayload("/tests/test_service.py", content));
    expect(result.stderr).toContain("Excessive mocking");
  });
});

// --- Pattern 2: Mock-only assertions ---

describe("mock-only assertions detection", () => {
  test("warns when only mock assertions exist (no value assertions)", async () => {
    const content = [
      'const mockFn = jest.fn();',
      'service.process();',
      'expect(mockFn).toHaveBeenCalled();',
      'expect(mockFn).toHaveBeenCalledWith("arg");',
    ].join("\n");
    const result = await runHook(writePayload("/src/foo.test.ts", content));
    expect(result.stderr).toContain("Mock-only assertions");
    expect(result.stderr).toContain("Rule 5");
  });

  test("does not warn when value assertions exist alongside mock assertions", async () => {
    const content = [
      'const mockFn = jest.fn();',
      'const result = service.process();',
      'expect(mockFn).toHaveBeenCalled();',
      'expect(result).toBe(42);',
    ].join("\n");
    const result = await runHook(writePayload("/src/foo.test.ts", content));
    expect(result.stderr).not.toContain("Mock-only assertions");
  });

  test("does not warn when only value assertions exist", async () => {
    const content = [
      'const result = add(1, 2);',
      'expect(result).toBe(3);',
      'expect(result).toEqual(3);',
    ].join("\n");
    const result = await runHook(writePayload("/src/foo.test.ts", content));
    expect(result.stderr).not.toContain("Mock-only assertions");
  });

  test("detects Python mock-only assertions", async () => {
    const content = [
      'mock_service.process()',
      'mock_service.do_work.assert_called_once()',
      'mock_service.do_work.assert_called_with("arg")',
    ].join("\n");
    const result = await runHook(writePayload("/tests/test_service.py", content));
    expect(result.stderr).toContain("Mock-only assertions");
  });
});

// --- Pattern 3: Tautological assertions ---

describe("tautological assertion detection", () => {
  test("detects mockReturnValue followed by toEqual with same value", async () => {
    const content = [
      'const mock = jest.fn();',
      'mock.mockReturnValue(42);',
      'const result = mock();',
      'expect(result).toEqual(42);',
    ].join("\n");
    const result = await runHook(writePayload("/src/foo.test.ts", content));
    expect(result.stderr).toContain("Tautological assertion");
    expect(result.stderr).toContain("Rule 3");
  });

  test("does not flag when asserting a different value", async () => {
    const content = [
      'const mock = jest.fn();',
      'mock.mockReturnValue(42);',
      'const result = transform(mock());',
      'expect(result).toEqual(84);',
    ].join("\n");
    const result = await runHook(writePayload("/src/foo.test.ts", content));
    expect(result.stderr).not.toContain("Tautological assertion");
  });
});

// --- Multiple warnings ---

describe("multiple warnings", () => {
  test("reports multiple issues in a single file", async () => {
    const content = [
      'const mockA = jest.fn();',
      'const mockB = jest.fn();',
      'const mockC = jest.fn();',
      'const mockD = jest.fn();',
      'const mockE = jest.fn();',
      'service.process();',
      'expect(mockA).toHaveBeenCalled();',
      'expect(mockB).toHaveBeenCalledWith("x");',
    ].join("\n");
    const result = await runHook(writePayload("/src/foo.test.ts", content));
    expect(result.stderr).toContain("Excessive mocking");
    expect(result.stderr).toContain("Mock-only assertions");
    expect(result.stderr).toContain("2 issue(s)");
  });
});
