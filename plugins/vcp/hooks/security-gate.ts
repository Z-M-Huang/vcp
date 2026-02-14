/**
 * VCP Security Gate — PreToolUse hook for Write|Edit|Bash
 *
 * Blocks tool calls that contain known dangerous code patterns.
 * Reads JSON from stdin, checks content against 14 regex patterns across 6 CWEs.
 *
 * For Write|Edit: checks new_string/content fields.
 * For Bash: checks the command field + Bash-specific obfuscation patterns.
 *
 * Exit 0 = allow the tool call
 * Exit 2 = block the tool call (stderr shown to user)
 *
 * Known limitation: Regex cannot perform taint tracking (e.g., SQL query
 * built in a variable then passed to .query()). The /vcp-security-check and
 * /vcp-pre-commit-review skills handle this better via AI-driven data flow analysis.
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

const input = await Bun.stdin.text();

// Extract the content to check based on tool type
let content: string;
let toolName: string = "";
try {
  const json = JSON.parse(input);
  toolName = json.tool_name ?? "";
  const toolInput = json.tool_input ?? json;

  if (toolName === "Bash") {
    content = toolInput.command ?? "";
  } else {
    // Write or Edit
    content = toolInput.new_string ?? toolInput.content ?? "";
  }
} catch {
  console.error("VCP Security Gate — BLOCKED: Could not parse hook input. Refusing to allow unverified tool call.");
  process.exit(2);
}

if (!content) {
  process.exit(0);
}

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

if (findings.length > 0) {
  const lines = findings.map((f) => `  ${f.cwe}: ${f.message}`).join("\n");
  console.error(`VCP Security Gate — BLOCKED:\n${lines}`);
  process.exit(2);
}

process.exit(0);
