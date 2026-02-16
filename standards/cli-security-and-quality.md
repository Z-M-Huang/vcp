---
id: cli-security-and-quality
title: CLI Security and Quality
scope: cli
severity: high
tags: [cli, security, shell-injection, argument-injection, exit-codes, signals, cwe]
references:
  - title: "CWE-78 — OS Command Injection"
    url: https://cwe.mitre.org/data/definitions/78.html
  - title: "CWE-88 — Improper Neutralization of Argument Delimiters"
    url: https://cwe.mitre.org/data/definitions/88.html
  - title: "CWE-377 — Insecure Temporary File"
    url: https://cwe.mitre.org/data/definitions/377.html
  - title: "CWE-367 — TOCTOU Race Condition"
    url: https://cwe.mitre.org/data/definitions/367.html
  - title: "12-Factor App — Config"
    url: https://12factor.net/config
  - title: "XDG Base Directory Specification"
    url: https://specifications.freedesktop.org/basedir-spec/latest/
---

## Principle

CLI tools are automation building blocks. They run in pipelines, CI systems, cron jobs, and shell scripts where there is no human to notice a silent failure or catch a security mistake. A CLI that exits 0 on failure breaks every pipeline that trusts it. A CLI that passes user input through a shell invites command injection. Security and correctness in CLI tools are not optional polish — they are the difference between a tool that can be trusted in production and one that cannot.

## Rules

### Security

1. **Never use shell=True (or equivalent) with external input.** Use `subprocess.run(["cmd", arg1, arg2])` (list form) instead of `subprocess.run(cmd_string, shell=True)`. In Node.js, use `execFile` not `exec`. Shell mode enables command injection via metacharacters (`;`, `|`, `$()`, backticks). (CWE-78)

2. **Use double-dash `--` to terminate option parsing before positional arguments.** When passing user-supplied values to subcommands, insert `--` to prevent argument injection. A filename starting with `-` can be interpreted as a flag (e.g., `rm` treating `--no-preserve-root` as an option). (CWE-88)

3. **Never pass credentials via command-line arguments.** Command-line arguments are visible in `ps`, `/proc`, shell history, and process monitoring. Use environment variables, stdin piping, config files with restricted permissions (0600), or credential helpers. (CWE-214)

4. **Create temporary files securely.** Use `mkstemp()` (Python), `fs.mkdtemp()` (Node.js), or equivalent. Never use predictable names in `/tmp`. Set restrictive permissions (0600). Clean up temp files in a `finally` block or signal handler. (CWE-377)

5. **Avoid TOCTOU race conditions in file operations.** Do not check-then-act on files (e.g., `if exists then open`). Use atomic operations: open with `O_CREAT|O_EXCL`, use file locks (`flock`), or operate on file descriptors not paths. (CWE-367)

6. **Validate and sanitize all file path arguments.** Resolve paths to canonical form and verify they fall within expected directories. Block `../` traversal. Handle symlink attacks — use `O_NOFOLLOW` or check `lstat()`. (CWE-22)

7. **Validate all external input.** CLI args, stdin, environment variables, and config files are all untrusted input. Validate types, ranges, and formats. Reject unexpected input rather than guessing intent.

### Quality

8. **Use meaningful exit codes.** 0 = success. 1 = general error. 2 = usage error (bad arguments). Follow platform conventions. Never exit 0 on failure — this breaks shell pipelines and CI. Document non-standard exit codes.

9. **Separate stdout and stderr.** Regular output goes to stdout (parseable by other tools). Errors, warnings, and progress indicators go to stderr. This enables piping: `mycli process file.txt | jq .`

10. **Provide helpful error messages.** Error messages must include: what went wrong, which input caused it, and what the user can do about it. Include the file path and line number when relevant. Never print a raw stack trace as the primary error output.

11. **Implement --help and --version.** Every CLI must support `--help` (usage, options, examples) and `--version`. Follow GNU conventions for option syntax. Provide man pages or markdown docs for complex tools.

12. **Handle signals gracefully.** Catch SIGINT (Ctrl+C) and SIGTERM for cleanup. Release locks, close files, remove temp files. On second SIGINT, exit immediately. Do not ignore SIGTERM.

13. **Support machine-readable output.** Provide `--json` or `--format=json` for structured output. This enables integration with `jq`, CI pipelines, and monitoring tools. When in a pipe (stdout is not a TTY), default to plain unformatted output — no colors, no progress bars.

14. **Follow XDG Base Directory Specification and 12-Factor config.** Store config in `$XDG_CONFIG_HOME` (default `~/.config/`), data in `$XDG_DATA_HOME`, cache in `$XDG_CACHE_HOME`. Use environment variables for deployment configuration. Support `--config` flag for explicit config file paths.

## Patterns

### Subprocess Without Shell Injection

#### Do This

```python
import subprocess

# List form — each argument is a separate element, no shell interpretation
filename = get_filename_from_args()
result = subprocess.run(["grep", "-r", "pattern", "--", filename], capture_output=True, text=True)
```

```javascript
// execFile — no shell interpretation, arguments passed directly to the process
const { execFile } = require("child_process");

execFile("grep", ["-r", "pattern", "--", filename], (error, stdout, stderr) => {
  if (error) {
    console.error(`Search failed: ${error.message}`);
    process.exit(1);
  }
  process.stdout.write(stdout);
});
```

#### Not This

```python
import subprocess

# shell=True — metacharacters in filename enable command injection (CWE-78)
# A filename like "file.txt; rm -rf /" would execute the rm command
filename = get_filename_from_args()
subprocess.run(f"grep -r pattern {filename}", shell=True)
```

```javascript
// exec() spawns a shell — same injection risk as shell=True (CWE-78)
const { exec } = require("child_process");

exec(`grep -r pattern ${filename}`, (error, stdout, stderr) => {
  process.stdout.write(stdout);
});
```

**Why it's wrong:** When `shell=True` (Python) or `exec` (Node.js) is used, the command string is interpreted by the shell. If `filename` contains `;`, `|`, `$()`, or backticks, the shell executes them as commands. List form passes each argument directly to the OS without shell interpretation, preventing injection entirely.

### Double-Dash Argument Termination

#### Do This

```python
import subprocess

# Double-dash prevents filenames starting with "-" from being parsed as options
target_path = get_path_from_args()
subprocess.run(["rm", "--", target_path])
```

```python
import subprocess

# Works for any command that accepts positional arguments
search_term = get_search_term()
subprocess.run(["grep", "--", search_term, "logfile.txt"])
```

#### Not This

```python
import subprocess

# Without --, a path like "--no-preserve-root" is treated as a flag (CWE-88)
target_path = get_path_from_args()
subprocess.run(["rm", target_path])
```

**Why it's wrong:** Without `--`, a user-supplied value like `--no-preserve-root` or `-rf /` is interpreted as a flag, not a filename. The `--` delimiter tells the command that everything following it is a positional argument, regardless of whether it starts with `-`.

### Secure Temporary File Creation

#### Do This

```python
import tempfile
import os

# mkstemp creates a file with a unique name and restrictive permissions
fd, temp_path = tempfile.mkstemp(suffix=".dat", prefix="mycli_")
try:
    with os.fdopen(fd, "w") as f:
        f.write(processed_content)
    # Use temp_path for further processing
finally:
    os.unlink(temp_path)  # Clean up even on error
```

```javascript
const fs = require("fs");
const os = require("os");
const path = require("path");

// mkdtemp creates a directory with a unique name
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycli-"));
const tmpFile = path.join(tmpDir, "output.dat");
try {
  fs.writeFileSync(tmpFile, processedContent, { mode: 0o600 });
  // Use tmpFile for further processing
} finally {
  fs.unlinkSync(tmpFile);
  fs.rmdirSync(tmpDir);
}
```

#### Not This

```python
import os

# Predictable temp path — another process can create this file first (CWE-377)
temp_path = "/tmp/mycli_output.dat"
with open(temp_path, "w") as f:
    f.write(processed_content)
```

**Why it's wrong:** A predictable path in `/tmp` allows a symlink attack: an attacker creates `/tmp/mycli_output.dat` as a symlink to `/etc/crontab` (or any target file), and your CLI overwrites the target. `mkstemp()` generates an unpredictable name and opens the file atomically, preventing this race condition.

### Exit Code Handling

#### Do This

```python
import sys

def main():
    try:
        args = parse_args()
    except UsageError as e:
        print(f"Error: {e}", file=sys.stderr)
        print("Run 'mycli --help' for usage information.", file=sys.stderr)
        sys.exit(2)  # Usage error

    try:
        result = process(args)
        print(result)
        sys.exit(0)  # Explicit success
    except FileNotFoundError as e:
        print(f"Error: File not found: {e.filename}", file=sys.stderr)
        sys.exit(1)  # General error
    except PermissionError as e:
        print(f"Error: Permission denied: {e.filename}", file=sys.stderr)
        sys.exit(1)
```

```javascript
const { parseArgs } = require("util");

try {
  const config = parseArgs({ options: cliOptions, strict: true });
  const result = await process(config.values);
  console.log(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    console.error(`Error: ${err.message}`);
    console.error("Run 'mycli --help' for usage information.");
    process.exit(2);
  }
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
```

#### Not This

```python
def main():
    try:
        result = process(parse_args())
        print(result)
    except Exception:
        print("Something went wrong")
        # Exits 0 — caller thinks this succeeded

# Breaks pipelines: mycli generate | mycli deploy
# deploy receives "Something went wrong" as input and processes it as valid data
```

**Why it's wrong:** Without an explicit non-zero exit code, the process exits 0 (success) even when it failed. Every downstream tool — shell scripts (`set -e`), CI systems, pipelines — treats exit 0 as "everything worked." The error message goes to stdout where it is parsed as valid output by the next command in the pipe.

### Stdout/Stderr Separation

#### Do This

```python
import sys
import json

def main():
    # Progress and diagnostics go to stderr (visible to the user, not captured by pipes)
    print("Processing 42 files...", file=sys.stderr)

    results = process_files()

    # Structured output goes to stdout (captured by pipes, consumed by other tools)
    json.dump(results, sys.stdout)

# Enables: mycli process ./src | jq '.errors[] | .file'
```

```javascript
// stderr for human-readable progress
process.stderr.write("Processing 42 files...\n");

const results = processFiles();

// stdout for machine-readable output
process.stdout.write(JSON.stringify(results));

// Enables: mycli process ./src | jq '.errors[] | .file'
```

#### Not This

```python
import json

def main():
    # Everything goes to stdout — progress mixed with data output
    print("Processing 42 files...")
    results = process_files()
    print(json.dumps(results))

# Breaks: mycli process ./src | jq .
# jq receives "Processing 42 files..." as the first line and fails to parse JSON
```

**Why it's wrong:** When progress messages and data output both go to stdout, piping breaks. `jq` tries to parse "Processing 42 files..." as JSON and fails. `grep` matches progress lines as results. Any tool consuming the output gets a mix of human-readable messages and structured data that cannot be parsed reliably.

### Signal Handling

#### Do This

```python
import signal
import sys
import os

temp_files = []

def cleanup(signum, frame):
    for path in temp_files:
        try:
            os.unlink(path)
        except OSError:
            pass
    sys.exit(128 + signum)  # Convention: 128 + signal number

# Register cleanup for SIGINT (Ctrl+C) and SIGTERM
signal.signal(signal.SIGINT, cleanup)
signal.signal(signal.SIGTERM, cleanup)
```

```javascript
const cleanupFiles = [];

function cleanup(signal) {
  for (const filePath of cleanupFiles) {
    try { fs.unlinkSync(filePath); } catch {}
  }
  process.exit(128 + (signal === "SIGINT" ? 2 : 15));
}

process.on("SIGINT", () => cleanup("SIGINT"));
process.on("SIGTERM", () => cleanup("SIGTERM"));
```

#### Not This

```python
import signal

# Ignoring SIGTERM means 'kill' and container orchestrators cannot stop this process
signal.signal(signal.SIGTERM, signal.SIG_IGN)

# No cleanup — temp files, locks, and open connections are leaked on Ctrl+C
```

**Why it's wrong:** Ignoring SIGTERM means `docker stop`, `systemctl stop`, Kubernetes pod termination, and `kill <pid>` all fail to stop the process gracefully. The orchestrator eventually sends SIGKILL, which gives the process no chance to clean up temp files, release locks, flush buffers, or close connections.

## Exceptions

- **Interactive CLIs** (REPLs, TUIs) may use different exit code conventions. A REPL that exits 0 on user-requested quit and 1 on crash is acceptable, even if individual commands within the REPL encountered errors.
- **Shell wrapper scripts** that compose other tools may need `shell=True` for pipe chains — document the security implications and ensure no user-controlled values flow into the shell string.
- **System-level tools** that must run as root (system installers, init scripts) should drop privileges after initialization and run the main logic with minimum required permissions.

## Cross-References

- [Security](core-security) — Input validation (R1), shell injection (R3), secrets management (R4)
- [Backend Security](web-backend-security) — Path traversal prevention (R16)
- [Error Handling](core-error-handling) — Structured error patterns
