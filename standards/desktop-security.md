---
id: desktop-security
title: Desktop Application Security
scope: desktop
severity: critical
tags: [security, electron, tauri, context-isolation, ipc, csp, desktop, owasp, cwe]
references:
  - title: "Electron — Security Best Practices"
    url: https://www.electronjs.org/docs/latest/tutorial/security
  - title: "Tauri — Security"
    url: https://tauri.app/security/
  - title: "CWE-94 — Improper Control of Generation of Code"
    url: https://cwe.mitre.org/data/definitions/94.html
---

## Principle

Desktop applications run with full operating system access. A vulnerability in the renderer process — an XSS, a malicious deep link, a crafted IPC message — can escalate to arbitrary code execution on the user's machine. Unlike web applications where the browser sandbox limits damage, desktop frameworks must construct their own security boundaries. Context isolation, IPC validation, and the principle of least privilege are not optional hardening — they are the walls between the user's operating system and untrusted content.

## Rules

### Electron

1. **Enable context isolation and disable nodeIntegration.** Set `contextIsolation: true` and `nodeIntegration: false` in every BrowserWindow. Without context isolation, scripts in the renderer process can access Node.js APIs — an XSS vulnerability becomes Remote Code Execution (RCE). This is the single most important Electron security setting. (CWE-94)

2. **Use the contextBridge preload pattern.** Expose specific APIs from the preload script to the renderer via `contextBridge.exposeInMainWorld()`. Expose only the minimum required functions. Never expose raw Node.js modules (fs, child_process, electron). Validate all arguments in the preload script. (CWE-94)

3. **Enable sandbox mode.** Set `sandbox: true` in BrowserWindow webPreferences. Sandboxed renderers run in a Chromium sandbox — even if context isolation is bypassed, the attacker cannot access the operating system directly. (CWE-265)

4. **Set a strict Content Security Policy (CSP).** Set CSP in the HTML meta tag or via response headers. Minimum: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`. Never use `script-src 'unsafe-eval'` or `script-src 'unsafe-inline'` in production. (CWE-79)

5. **Validate all IPC messages in the main process.** The main process has full Node.js access. Every `ipcMain.handle()` and `ipcMain.on()` handler must validate the channel name, sender identity, and all arguments. Never pass IPC arguments directly to shell commands, file system operations, or database queries. (CWE-20)

6. **Restrict shell.openExternal to validated URLs.** `shell.openExternal()` can open any URL or execute any protocol handler. Validate URLs against an allowlist of schemes (`https://`) and domains. Never pass user-controlled strings directly to `shell.openExternal()`. (CWE-601)

7. **Do not use the remote module.** The `@electron/remote` module exposes the entire main process API to the renderer. Any XSS vulnerability in the renderer becomes full main process access. Use IPC instead. (CWE-94)

### Tauri

8. **Configure minimal capabilities, permissions, and scopes.** Tauri v2 uses a capabilities system. Define explicit permissions for each window — file system access, shell commands, HTTP requests. Use path scopes to restrict file access to specific directories. Never grant blanket permissions. (CWE-250)

9. **Validate all IPC commands from the frontend.** Tauri commands (`#[tauri::command]`) receive arguments from the frontend (WebView). Validate all inputs — types, ranges, paths. Use Tauri's built-in path scope validation for file operations. (CWE-20)

### Framework-Agnostic

10. **Verify auto-update signatures and sources.** Auto-update mechanisms must verify the cryptographic signature of updates before applying them. Use code signing (macOS notarization, Windows Authenticode). Updates must be fetched over HTTPS from a controlled domain. Never allow update URLs to be configured by the user. (CWE-494)

## Patterns

### Electron BrowserWindow Secure Configuration

#### Do This

```javascript
// main.js — Secure BrowserWindow configuration
const { BrowserWindow } = require("electron");

const mainWindow = new BrowserWindow({
  width: 1200,
  height: 800,
  webPreferences: {
    contextIsolation: true,   // Isolate renderer from Node.js
    nodeIntegration: false,   // No Node.js in renderer scripts
    sandbox: true,            // Chromium sandbox for renderer
    preload: path.join(__dirname, "preload.js"),
  },
});
```

#### Not This

```javascript
// INSECURE — every setting here opens an attack surface
const mainWindow = new BrowserWindow({
  webPreferences: {
    contextIsolation: false,  // Renderer can access Node.js globals
    nodeIntegration: true,    // Full Node.js available to page scripts
    sandbox: false,           // No OS-level sandboxing
    // No preload — exposing Node directly to renderer
  },
});
// With these settings, any XSS in the renderer can:
//   require("child_process").exec("rm -rf /")
// This turns a browser-level XSS into full RCE.
```

**Why it's wrong:** With `nodeIntegration: true` and `contextIsolation: false`, any script running in the renderer — including injected XSS payloads, malicious ads, or compromised third-party scripts — can call `require("child_process")` and execute arbitrary OS commands. The browser-level XSS becomes a full Remote Code Execution vulnerability.

### contextBridge Preload Pattern

#### Do This

```javascript
// preload.js — Expose only specific, validated APIs
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Expose a narrow, validated API surface
  readFile: (filePath) => {
    // Validate before forwarding to main process
    if (typeof filePath !== "string" || filePath.includes("..")) {
      throw new Error("Invalid file path");
    }
    return ipcRenderer.invoke("file:read", filePath);
  },
  getAppVersion: () => ipcRenderer.invoke("app:version"),
});

// Renderer code uses: window.electronAPI.readFile("/safe/path")
```

#### Not This

```javascript
// INSECURE — exposing raw Node.js modules to the renderer
const { contextBridge } = require("electron");
const fs = require("fs");
const { exec } = require("child_process");

contextBridge.exposeInMainWorld("nodeModules", {
  fs: fs,       // Full filesystem access from renderer
  exec: exec,   // Shell command execution from renderer
});
// Any XSS can now call window.nodeModules.exec("malicious command")
// or window.nodeModules.fs.readFileSync("/etc/passwd")
```

**Why it's wrong:** Exposing raw Node.js modules through the context bridge defeats the purpose of context isolation. The renderer — and any attacker who achieves XSS — gets direct access to the file system and shell. The preload script should be a narrow API gateway, not a passthrough for Node.js internals.

### IPC Message Validation in Main Process

#### Do This

```javascript
// main.js — Validate all IPC arguments before acting on them
const { ipcMain, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs/promises");

const ALLOWED_BASE_DIR = path.resolve("/home/user/documents");

ipcMain.handle("file:read", async (event, filePath) => {
  // 1. Validate sender identity
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) {
    throw new Error("Unknown sender");
  }

  // 2. Validate argument type
  if (typeof filePath !== "string") {
    throw new Error("File path must be a string");
  }

  // 3. Validate path — prevent traversal
  const resolved = path.resolve(ALLOWED_BASE_DIR, filePath);
  if (!resolved.startsWith(ALLOWED_BASE_DIR)) {
    throw new Error("Access denied — path outside allowed directory");
  }

  // 4. Now safe to use
  return fs.readFile(resolved, "utf-8");
});
```

#### Not This

```javascript
// INSECURE — no validation on IPC arguments
const { ipcMain } = require("electron");
const fs = require("fs/promises");

ipcMain.handle("file:read", async (_event, filePath) => {
  // Passes user-controlled path directly to filesystem
  // An attacker sending "../../etc/passwd" reads any file on the system
  return fs.readFile(filePath, "utf-8");
});

// Similarly dangerous: passing IPC args directly to shell execution
// ipcMain.handle("run", async (_event, cmd) => {
//   exec(cmd);  // Full RCE via IPC
// });
```

**Why it's wrong:** The main process has full Node.js and OS access. IPC messages come from the renderer, which may be compromised by XSS. Without validating the sender identity, argument types, and argument values (especially file paths and command strings), the main process becomes a proxy that executes attacker-controlled operations with full system privileges.

### shell.openExternal Validation

#### Do This

```javascript
// main.js — Validate URLs before opening externally
const { shell } = require("electron");

const ALLOWED_DOMAINS = new Set([
  "docs.example.com",
  "support.example.com",
  "github.com",
]);

function openExternalSafe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  // Only allow https
  if (parsed.protocol !== "https:") {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }

  // Only allow known domains
  if (!ALLOWED_DOMAINS.has(parsed.hostname)) {
    throw new Error(`Blocked domain: ${parsed.hostname}`);
  }

  return shell.openExternal(url);
}
```

#### Not This

```javascript
// INSECURE — user-controlled URL passed directly to openExternal
const { shell } = require("electron");

function openLink(url) {
  // No validation — attacker can open any URL or protocol handler
  shell.openExternal(url);
}

// An attacker can pass:
//   "file:///etc/passwd"         — read local files
//   "smb://attacker.com/share"   — trigger SMB authentication (NTLM relay)
//   Custom protocol handlers     — launch other applications
```

**Why it's wrong:** `shell.openExternal()` delegates to the OS and can trigger any registered protocol handler. Without scheme and domain validation, an attacker who controls the URL can read local files, trigger network authentication flows (NTLM relay attacks on Windows), or launch arbitrary applications via custom protocol handlers.

### Tauri Capability Configuration

#### Do This

```json
{
  "identifier": "main-window",
  "description": "Capabilities for the main application window",
  "windows": ["main"],
  "permissions": [
    {
      "identifier": "fs:allow-read-text-file",
      "allow": [
        { "path": "$APPDATA/**" }
      ]
    },
    {
      "identifier": "fs:allow-write-text-file",
      "allow": [
        { "path": "$APPDATA/config.json" }
      ]
    },
    "http:default"
  ]
}
```

#### Not This

```json
{
  "identifier": "main-window",
  "windows": ["main"],
  "permissions": [
    "fs:default",
    "shell:default",
    "http:default",
    "process:default"
  ]
}
```

**Why it's wrong:** Default permission sets grant broad access — full file system read/write, shell command execution, unrestricted HTTP requests, and process spawning. A compromised WebView frontend can exercise all of these permissions. Capabilities should be scoped to specific paths, specific operations, and specific windows.

### Tauri IPC Command Validation

#### Do This

```rust
// src-tauri/src/commands.rs — Validate all arguments from the frontend
use std::path::{Path, PathBuf};
use tauri::command;

#[command]
fn read_document(app: tauri::AppHandle, name: String) -> Result<String, String> {
    // Validate argument type and format
    if name.is_empty() || name.len() > 255 {
        return Err("Invalid document name".into());
    }

    // Reject path traversal attempts
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("Invalid characters in document name".into());
    }

    // Construct safe path within the app data directory
    let base = app.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    let file_path = base.join("documents").join(&name);

    // Double-check resolved path is within allowed directory
    let canonical = file_path.canonicalize()
        .map_err(|_| "File not found".to_string())?;
    if !canonical.starts_with(base.join("documents")) {
        return Err("Access denied".into());
    }

    std::fs::read_to_string(canonical)
        .map_err(|e| format!("Read error: {}", e))
}
```

#### Not This

```rust
// INSECURE — no validation on frontend-supplied arguments
#[tauri::command]
fn read_file(file_path: String) -> Result<String, String> {
    // Directly reads whatever path the frontend sends
    // Frontend can request: "../../etc/passwd" or "/etc/shadow"
    std::fs::read_to_string(file_path)
        .map_err(|e| e.to_string())
}
```

**Why it's wrong:** Tauri commands receive arguments from the WebView frontend, which is a web context subject to XSS. Without validating the path argument — checking for traversal sequences, restricting to an allowed directory, and canonicalizing the resolved path — the Rust backend becomes a file-read oracle that an attacker can use to exfiltrate any file readable by the application process.

## Exceptions

- **Development mode** may disable some security features for debugging (e.g., DevTools CSP override, relaxed CORS). These must be gated behind `isDev` or `process.env.NODE_ENV === "development"` checks and must never be active in production builds.
- **Utility processes** in Electron may need specific Node.js access — use Electron's `utilityProcess` API with process-level sandboxing rather than granting renderer processes Node.js access.

## Cross-References

- [Frontend Security](web-frontend-security) — XSS prevention, CSP
- [Security](core-security) — Input validation, secrets management
- [Backend Security](web-backend-security) — Path traversal prevention (R16) applies to desktop file access
