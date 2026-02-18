/**
 * VCP Security Gate — PreToolUse hook for Write|Edit|Bash
 *
 * Blocks tool calls that contain known dangerous code patterns.
 * Reads JSON from stdin, checks content against 19 regex patterns across 9 CWEs.
 *
 * For Write|Edit: checks new_string/content fields. Documentation files (.md, .mdx,
 * .txt, .rst) are exempt — they are never executed and routinely contain anti-pattern
 * examples that would cause false positives.
 * For Bash: checks the command field + Bash-specific obfuscation patterns.
 *
 * Exit 0 = allow the tool call
 * Exit 2 = block the tool call (stderr fed to Claude as error message)
 *
 * Known limitation: Regex cannot perform taint tracking (e.g., SQL query
 * built in a variable then passed to .query()). The /vcp-audit and
 * /vcp-pre-commit-review skills handle this better via AI-driven data flow analysis.
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

import { vcpLog } from "../lib/vcp-logger";
import { loadGlobalConfig, mergeIgnoreArrays } from "../lib/global-config";

const [input, globalConfig] = await Promise.all([
  Bun.stdin.text(),
  loadGlobalConfig(),
]);
const debug = globalConfig?.debug ?? false;

// Extract the content to check based on tool type
let content: string;
let toolName: string = "";
let cwd: string = "";
let filePath: string = "";
try {
  const json = JSON.parse(input);
  toolName = json.tool_name ?? "";
  cwd = json.cwd ?? "";
  const toolInput = json.tool_input ?? json;

  if (toolName === "Bash") {
    content = toolInput.command ?? "";
  } else {
    // Write or Edit
    filePath = toolInput.file_path ?? "";
    content = toolInput.new_string ?? toolInput.content ?? "";
  }
} catch {
  console.error("VCP Security Gate — BLOCKED: Could not parse hook input. Refusing to allow unverified tool call.");
  const fallbackRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  await vcpLog(fallbackRoot, {
    source: "security-gate",
    event: "PreToolUse",
    decision: "block",
    details: "Could not parse input",
  }, debug);
  process.exit(2);
}

const projectRoot = process.env.CLAUDE_PROJECT_DIR || cwd;

if (!content) {
  await vcpLog(projectRoot, {
    source: "security-gate",
    event: "PreToolUse",
    decision: "allow",
    details: "Empty content",
  }, debug);
  process.exit(0);
}

// Documentation files are never executed — patterns in them cannot cause harm.
// Skip scanning for .md, .mdx, .txt, .rst to avoid false positives on anti-pattern
// examples in standards, issue bodies, and other documentation.
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);
if (filePath) {
  const ext = filePath.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? "";
  if (DOC_EXTENSIONS.has(ext)) {
    await vcpLog(projectRoot, {
      source: "security-gate",
      event: "PreToolUse",
      decision: "allow",
      details: `Documentation file (${ext}) — scan skipped`,
    }, debug);
    process.exit(0);
  }
}

// Load .vcp.json and global config ignore lists for CWE suppression
let vcpConfig: any = null;
if (projectRoot) {
  try {
    vcpConfig = await Bun.file(`${projectRoot}/.vcp.json`).json();
  } catch {
    // No config found — proceed with empty ignore set
  }
}
const mergedIgnore = mergeIgnoreArrays(
  globalConfig?.defaults?.ignore ?? [],
  vcpConfig?.ignore ?? [],
);
const ignoredCWEs = new Set(mergedIgnore.filter((id: string) => /^CWE-\d+$/.test(id)));

interface Finding {
  cwe: string;
  message: string;
}

const findings: Finding[] = [];

// CWE-798: Hardcoded secrets (password/key/secret assigned a literal value 8+ chars)
if (/(password|secret|api_key|apikey|api_secret|private_key|secret_key)\s*[:=]\s*["'][^\s"']{8,}["']/i.test(content)) {
  findings.push({
    cwe: "CWE-798",
    message: "Hardcoded secret detected. Use environment variables or a secret manager.",
  });
}

// CWE-798: AWS access keys (officially documented prefixes)
if (/(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}/.test(content)) {
  findings.push({
    cwe: "CWE-798",
    message: "AWS access key detected. Use IAM roles or environment variables.",
  });
}

// CWE-798: Private keys (all PEM formats including PKCS#8)
if (/-----BEGIN [\w ]*PRIVATE KEY-----/.test(content)) {
  findings.push({
    cwe: "CWE-798",
    message: "Private key detected. Never commit private keys to source control.",
  });
}

// CWE-798: JWT tokens (eyJ base64url prefix with dot-separated segments)
if (/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(content)) {
  findings.push({
    cwe: "CWE-798",
    message: "JWT token detected. Use environment variables or a secret manager.",
  });
}

// CWE-89: SQL string concatenation (f-string, +, ${}, or % formatting in query call)
if (/(\.execute|\.query|\.raw|\.\$?queryRawUnsafe|\.\$?executeRawUnsafe|\.whereRaw|\.havingRaw|\.orderByRaw|\.joinRaw)\s*\(\s*(f["']|["'].*\+|["'].*\$\{|["'].*%\s*\()/.test(content)) {
  findings.push({
    cwe: "CWE-89",
    message: "SQL string concatenation detected. Use parameterized queries.",
  });
}

// CWE-89: SQL injection via template literal in query call
if (/\.\$?(execute|query|raw|queryRawUnsafe|executeRawUnsafe|whereRaw|havingRaw|orderByRaw|joinRaw)\s*\(\s*`[^`]*\$\{/.test(content)) {
  findings.push({
    cwe: "CWE-89",
    message: "SQL template literal with interpolation detected. Use parameterized queries.",
  });
}

// CWE-95: eval() with user-controlled input variable names
if (/\beval\s*\([^)]*\b(req|request|input|user|param|query|body|data)\b/.test(content)) {
  findings.push({
    cwe: "CWE-95",
    message: "eval() with user input detected. Never eval untrusted data.",
  });
}

// CWE-79: innerHTML assigned a variable (not a string literal or HTML tag)
if (/\.innerHTML\s*=\s*[^"'<\s]/.test(content)) {
  findings.push({
    cwe: "CWE-79",
    message: "innerHTML with variable detected. Use textContent or sanitize first.",
  });
}

// CWE-502: pickle (always unsafe with untrusted data)
if (/pickle\.loads?\(/.test(content)) {
  findings.push({
    cwe: "CWE-502",
    message: "pickle is never safe with untrusted data. Use json instead.",
  });
}

// CWE-502: yaml.load without safe Loader
if (/yaml\.load\s*\((?![^)]*Loader\s*=)[^)]*\)/.test(content)) {
  findings.push({
    cwe: "CWE-502",
    message: "yaml.load() without Loader= is unsafe. Use yaml.safe_load() instead.",
  });
}

// CWE-502: yaml explicitly unsafe methods
if (/yaml\.(unsafe_load|full_load)\s*\(/.test(content)) {
  findings.push({
    cwe: "CWE-502",
    message: "yaml.unsafe_load/full_load are dangerous. Use yaml.safe_load() instead.",
  });
}

// CWE-502: Node.js insecure deserialization (CVE-2017-5941)
if (/\.unserialize\s*\(/.test(content)) {
  findings.push({
    cwe: "CWE-502",
    message: "Insecure deserialization detected. node-serialize is never safe with untrusted data.",
  });
}

// CWE-798: Database connection strings with embedded credentials
if (/\b(mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^:\/\s]+:[^@\/\s]+@/i.test(content)) {
  findings.push({
    cwe: "CWE-798",
    message: "Database connection string with embedded credentials detected. Use environment variables for connection strings.",
  });
}

// CWE-798: Hardcoded Bearer/OAuth tokens (40+ char token values)
if (/["']Bearer\s+[A-Za-z0-9+\/=_-]{40,}["']/.test(content)) {
  findings.push({
    cwe: "CWE-798",
    message: "Hardcoded Bearer token detected. Use environment variables or a secret manager.",
  });
}

// CWE-798: Google/GitHub API key prefixes
if (/\b(AIza[0-9A-Za-z_-]{35}|ghp_[0-9A-Za-z]{36}|gho_[0-9A-Za-z]{36}|ghs_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{22,})/.test(content)) {
  findings.push({
    cwe: "CWE-798",
    message: "API key with known provider prefix detected. Use environment variables or a secret manager.",
  });
}

// CWE-643: XPath injection via string concatenation
if (/\.xpath\s*\(\s*(f["']|["'].*\+|["'].*\$\{|`[^`]*\$\{)/.test(content)) {
  findings.push({
    cwe: "CWE-643",
    message: "XPath query with string concatenation detected. Use parameterized XPath queries.",
  });
}

// CWE-1321: Prototype pollution via __proto__ or constructor.prototype assignment
if (/\["?__proto__"?\]\s*=|\.__proto__\s*=|constructor\s*\[\s*["']prototype["']\s*\]|constructor\.prototype\s*[.=]/.test(content)) {
  findings.push({
    cwe: "CWE-1321",
    message: "Prototype pollution pattern detected. Never assign to __proto__ or constructor.prototype.",
  });
}

// Bash-specific checks (encoding piped to execution, eval with dynamic input)
if (toolName === "Bash") {
  // CWE-116: Encoded data piped to shell execution
  const hasDecodeCmd = /\b(base64\s+(-d|--decode)|xxd\s+-r)\b/.test(content);
  if (hasDecodeCmd && (
    /\|\s*(bash|sh|zsh|dash|ksh|eval|\$SHELL|source)\b/.test(content) ||
    /\b(bash|sh|zsh|dash|ksh)\s+-c\b/.test(content)
  )) {
    findings.push({
      cwe: "CWE-116",
      message: "Encoded data with shell execution detected. Review manually.",
    });
  }
  // CWE-95: Shell eval with dynamic input
  if (/\beval\s+["'$]/.test(content)) {
    findings.push({
      cwe: "CWE-95",
      message: "Shell eval with dynamic input detected. Review manually.",
    });
  }
}

const filtered = findings.filter((f) => !ignoredCWEs.has(f.cwe));
const suppressed = findings.length - filtered.length;
if (suppressed > 0) {
  const suppressedCWEs = [...new Set(findings.filter((f) => ignoredCWEs.has(f.cwe)).map((f) => f.cwe))].join(", ");
  const output = {
    systemMessage: `VCP Security Gate — WARNING: Suppressed ${suppressed} finding(s) via .vcp.json ignore (${suppressedCWEs}).`,
  };
  console.log(JSON.stringify(output));
  await vcpLog(projectRoot, {
    source: "security-gate",
    event: "PreToolUse",
    decision: "warn",
    details: `Suppressed ${suppressed} finding(s) (${suppressedCWEs})`,
  }, debug);
}

if (filtered.length > 0) {
  const lines = filtered.map((f) => `  ${f.cwe}: ${f.message}`).join("\n");
  console.error(`VCP Security Gate — BLOCKED:\n${lines}`);
  const blockedCWEs = [...new Set(filtered.map((f) => f.cwe))].join(", ");
  await vcpLog(projectRoot, {
    source: "security-gate",
    event: "PreToolUse",
    decision: "block",
    details: blockedCWEs,
  }, debug);
  process.exit(2);
}

await vcpLog(projectRoot, {
  source: "security-gate",
  event: "PreToolUse",
  decision: "allow",
  details: "No findings",
}, debug);
process.exit(0);
