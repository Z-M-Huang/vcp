/**
 * VCP Test Quality Warning — PostToolUse hook for Write|Edit
 *
 * Warns when AI-generated test code contains mock-abuse patterns.
 * Reads JSON from stdin, checks if the written/edited file is a test file,
 * then scans content for 3 common anti-patterns.
 *
 * Always exits 0. PostToolUse hooks can signal issues via JSON stdout with systemMessage.
 * Warnings output as JSON to stdout for user visibility.
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import { loadGlobalConfig } from "../lib/global-config";
import { vcpLog } from "../lib/vcp-logger";

const [input, globalConfig] = await Promise.all([
  Bun.stdin.text(),
  loadGlobalConfig(),
]);
const debug = globalConfig?.debug ?? false;

let toolName: string = "";
let filePath: string = "";
let content: string = "";

try {
  const json = JSON.parse(input);
  toolName = json.tool_name ?? "";
  const toolInput = json.tool_input ?? json;
  filePath = toolInput.file_path ?? "";
  content = toolInput.content ?? toolInput.new_string ?? "";
} catch {
  process.exit(0);
}

// Only check Write and Edit tool calls
if (toolName !== "Write" && toolName !== "Edit") {
  process.exit(0);
}

if (!filePath || !content) {
  process.exit(0);
}

// Check if the file is a test file (cross-platform path separators)
const testPatterns = [
  /\.test\.[^/\\]+$/,
  /\.spec\.[^/\\]+$/,
  /(^|[/\\])test_[^/\\]+$/,
  /[/\\]__tests__[/\\]/,
  /_test\.go$/,
  /Test\.java$/,
  /_test\.rb$/,
  /_spec\.rb$/,
  /_test\.rs$/,
];

const isTestFile = testPatterns.some((p) => p.test(filePath));
if (!isTestFile) {
  process.exit(0);
}

const warnings: string[] = [];

// Pattern 1: Excessive mocking (more than 3 mock/stub setup calls)
const mockSetupPatterns = [
  /\bmock\s*\(/gi,
  /\bMock\s*\(/gi,
  /\.mock\s*\(/gi,
  /\bpatch\s*\(/gi,
  /\bstub\s*\(/gi,
  /\bspyOn\s*\(/gi,
  /\bjest\.fn\s*\(/gi,
  /\bvi\.fn\s*\(/gi,
  /\bsinon\.(stub|mock|fake)\s*\(/gi,
  /\.mockReturnValue\s*\(/gi,
  /\.mockResolvedValue\s*\(/gi,
  /\.mockImplementation\s*\(/gi,
  /\.return_value\s*=/gi,
];

let mockCount = 0;
for (const pattern of mockSetupPatterns) {
  const matches = content.match(pattern);
  if (matches) {
    mockCount += matches.length;
  }
}

if (mockCount > 3) {
  warnings.push(
    `Excessive mocking: ${mockCount} mock setup calls detected. VCP standard core-testing Rule 4: "Mock external services, not internal logic." Consider reducing mocks to external boundaries only.`,
  );
}

// Pattern 2: Mock-only assertions (assertions only on mock calls, no value assertions)
const mockAssertions = [
  /\.assert_called/g,
  /\.assert_any_call/g,
  /\.toHaveBeenCalled/g,
  /\.toHaveBeenCalledWith/g,
  /\.toHaveBeenCalledTimes/g,
  /\.calledWith/g,
  /\.calledOnce/g,
  /\.called\b/g,
  /expect\([^)]*\)\.toHaveBeenCalled/g,
];

const valueAssertions = [
  /\.toEqual\s*\(/g,
  /\.toBe\s*\(/g,
  /\.toContain\s*\(/g,
  /\.toMatch\s*\(/g,
  /\.toThrow\s*\(/g,
  /\.toStrictEqual\s*\(/g,
  /\.toBeTruthy\s*\(/g,
  /\.toBeFalsy\s*\(/g,
  /\.toBeNull\s*\(/g,
  /\.toBeDefined\s*\(/g,
  /\.toBeGreaterThan\s*\(/g,
  /\.toBeLessThan\s*\(/g,
  /\.toHaveLength\s*\(/g,
  /\.toHaveProperty\s*\(/g,
  /\bassert\s+\w/g,
  /\bassertEqual/g,
  /\bassertTrue/g,
  /\bassertFalse/g,
  /\bassertRaises/g,
  /\bassertIn/g,
];

let mockAssertCount = 0;
for (const pattern of mockAssertions) {
  const matches = content.match(pattern);
  if (matches) {
    mockAssertCount += matches.length;
  }
}

let valueAssertCount = 0;
for (const pattern of valueAssertions) {
  const matches = content.match(pattern);
  if (matches) {
    valueAssertCount += matches.length;
  }
}

if (mockAssertCount > 0 && valueAssertCount === 0) {
  warnings.push(
    `Mock-only assertions: ${mockAssertCount} mock assertion(s) found but no value assertions. VCP standard core-testing Rule 5: "When you mock, verify the contract — not the call." Add assertions on return values or state changes.`,
  );
}

// Pattern 3: Tautological mock assertions (asserting that a mock returns what it was set up to return)
const tautologyPatterns = [
  /\.return_value\s*=\s*(.+)\n[\s\S]{0,200}assert.*==\s*\1/g,
  /mockReturnValue\(([^)]+)\)[\s\S]{0,200}toEqual\(\1\)/g,
  /mockResolvedValue\(([^)]+)\)[\s\S]{0,200}toEqual\(\1\)/g,
];

let hasTautology = false;
for (const pattern of tautologyPatterns) {
  if (pattern.test(content)) {
    hasTautology = true;
    break;
  }
}

if (hasTautology) {
  warnings.push(
    `Tautological assertion: Test appears to assert that a mock returns what it was configured to return. VCP standard core-testing Rule 3: "Avoid tautological tests." The test should verify real logic, not mock wiring.`,
  );
}

const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();

if (warnings.length > 0) {
  const header = `VCP Test Quality Warning — ${warnings.length} issue(s) in ${filePath}:`;
  const body = warnings.map((w) => `  - ${w}`).join("\n");
  const output = {
    systemMessage: `${header}\n${body}`,
  };
  console.log(JSON.stringify(output));
  await vcpLog(projectRoot, {
    source: "test-quality-warning",
    event: "PostToolUse",
    decision: "warn",
    details: `${warnings.length} issue(s) in ${filePath}`,
  }, debug);
} else {
  await vcpLog(projectRoot, {
    source: "test-quality-warning",
    event: "PostToolUse",
    decision: "allow",
    details: "No issues",
  }, debug);
}

process.exit(0);
