---
name: vcp-init
description: >
  Initialize VCP configuration for this project. Detects frameworks, scopes, and
  creates .vcp.json so all VCP skills know what standards to enforce.
  Run this once when setting up VCP for a new project.
user-invocable: true
allowed-tools: Read, Write, Glob, Grep, Bash, WebFetch, AskUserQuestion
argument-hint: ""
---

# VCP Project Initialization

Create a `.vcp.json` configuration file for this project. This config is read by all VCP skills to determine which standards to enforce.

## Step 1: Check for Existing Config

Read `.vcp.json` from the project root. If it already exists, show its contents and ask the user if they want to reconfigure or keep it. If they want to keep it, stop here.

## Step 2: Scan the Project

Examine the project to understand what frameworks, languages, and tools are in use. Read dependency manifests (package.json, requirements.txt, pyproject.toml, pom.xml, build.gradle, Gemfile, go.mod, Cargo.toml, etc.), browse the directory structure, and look at file types present.

Based on what you find, determine:
1. **Frameworks** — which specific frameworks and tools the project uses (e.g. react, express, postgresql, django)
2. **Scopes** — which VCP scopes apply:
   - `web-frontend`: the project has client-side web code
   - `web-backend`: the project has server-side web code
   - `database`: the project interacts with databases
3. **Exclude patterns** — which paths should be skipped during scanning (build output, vendored code, generated files)

Use your judgment. Do not rely on a fixed lookup table — understand the project and decide what applies.

## Step 3: Confirm with the User

**Always ask the user to confirm before writing the config.** Present your proposed configuration and ask for approval. Do not write `.vcp.json` until the user explicitly confirms.

Show the user:

1. **Scopes** — which scopes you detected and why. Let the user add, remove, or change them.
2. **Frameworks** — which frameworks you found. Let the user correct the list.
3. **Compliance** — ask if the project needs to comply with regulatory frameworks (GDPR, PCI DSS, HIPAA). Do not assume any are needed.
4. **Exclude patterns** — suggest reasonable defaults for the detected ecosystem. Let the user add or remove patterns.
5. **Severity threshold** — ask what minimum severity to report (critical, high, medium, low). Explain that the default `"medium"` reports medium, high, and critical findings.

Wait for the user to confirm or adjust before proceeding to Step 4.

## Step 4: Write `.vcp.json`

The config must conform to the JSON schema at:
```
https://raw.githubusercontent.com/Z-M-Huang/vcp/main/schemas/vcp.schema.json
```

Generate the config based on the user-confirmed answers and write it to the project root:

```json
{
  "$schema": "https://raw.githubusercontent.com/Z-M-Huang/vcp/main/schemas/vcp.schema.json",
  "version": "1.0",
  "scopes": {
    "web-frontend": true,
    "web-backend": true,
    "database": false
  },
  "compliance": [],
  "frameworks": ["react", "express", "postgresql"],
  "exclude": [
    "node_modules/**",
    "dist/**",
    "build/**"
  ],
  "severity": "medium"
}
```

## Step 5: Confirm

Show a summary:
```
VCP initialized for this project.

Scopes:     web-frontend, web-backend
Compliance: none
Frameworks: react, express, postgresql
Exclude:    node_modules/**, dist/**, build/**
Severity:   medium+

Config written to .vcp.json
Run /vcp-security-check, /vcp-quality-check, or /vcp-dependency-check to start.
```
