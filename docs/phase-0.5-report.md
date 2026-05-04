# Phase 0.5 Report — Ralph MCP Vertical Slice

**Scaffold:** `tmp/dev-buddy-mcp-vertical/` (throwaway; not merged to main)
**Date:** 2026-04-24
**Precondition:** Phase 0 probes 10–16 closed with YES on 10/11/16.

---

## Purpose

Prove — end-to-end, in installed-plugin shape, before Phase 1 library extractions — that the MCP hybrid architecture for dev-buddy is viable: MCP server + state engine + subprocess LLM runner + run-level step lease + per-run mutation lock + atomic state writes + stdout isolation.

If this slice had failed on an architectural issue, Phase 1's library layout (designed to feed the MCP server) would be wrong; Phase 5 would have been a multi-week rebuild. The slice exists to take that risk early.

---

## What was built

```
tmp/dev-buddy-mcp-vertical/
├── .claude-plugin/plugin.json       # declares mcpServers with ${CLAUDE_PLUGIN_ROOT}/src/server.ts
├── .codex-plugin/plugin.json        # same content (probe 10 validated dual)
├── package.json                     # @modelcontextprotocol/sdk@^1.29.0
├── lib-bundled/
│   ├── logger.ts                    # file-only append; never touches stdout/stderr
│   └── llm-runner-stub.ts           # stub subprocess — emits JSON envelope to stdout
├── src/
│   ├── state-store.ts               # atomic I/O, run-level step lease, per-run mutation lock
│   └── server.ts                    # MCP server with two tools: ralph_discover, get_run_state
└── tests/
    ├── smoke.ts                     # 19 observables via MCP client round-trip
    └── move-test.sh                 # observable #8 — fresh-path install-shape check
```

**Deliberate scope cuts** (avoiding over-engineering):

- The subprocess is a **stub** (`lib-bundled/llm-runner-stub.ts`) — not the real `@vcp-lib/llm-runner`. The slice proves the runtime path, NOT the LLM integration. Vendoring the full Vercel AI SDK + agentool graph would add 60+ packages and prove nothing we can't prove with a 30-line stub that emits the same JSON envelope.
- No `ralph_next` / `ralph_abort` / resource URIs / prompts — those are Phase 5 deliverables. One tool is enough to exercise every primitive.
- No cross-process rate limiter or cancellation tree — those primitives are scoped to Phase 5 where multi-subprocess fanout actually matters. The slice has one subprocess per call.

---

## Exit observables — 29/29 PASS on install AND on move-to-fresh-path

First pass ran 19 observables; Codex review flagged false-assurance (stdout cleanliness never went through a tool call, reclaim claim was comment-only, lock orphan recovery untested, failure branch untested). Second pass adds 10 observables covering the gaps.

| # | Observable | Result |
|---|---|---|
| **Happy path (MCP round-trip + state + subprocess + logs)** | | |
| 1a | server lists `ralph_discover` | PASS |
| 1b | tool result has `run_id` | PASS |
| 2a | subprocess exits cleanly (status=complete) | PASS |
| 2b | subprocess stderr captured to a per-invocation file under `subprocess-stderr/` | PASS |
| 2c | `events.jsonl` appended (run_created, run_completed, lease_acquired, lease_released) | PASS |
| 3a | state file exists at `.vcp/ralph/<run-id>/state.json` | PASS |
| 3b | schema version matches `STATE_SCHEMA_VERSION = 1` | PASS |
| 3c | status persisted as `complete` | PASS |
| 3d | subprocess PID recorded on state | PASS |
| 4a | lease released after completion (`lease.json` absent) | PASS |
| 4b | mutation lock released after completion (`.lock` absent) | PASS |
| **Failure branch (new — Codex review)** | | |
| F1 | force-fail returns status=failed via tool response | PASS |
| F2 | failure state persisted to disk | PASS |
| F3 | lease released after failure (no leak on the error path) | PASS |
| **Lease primitives** | | |
| 4c | `releaseLease` cleans the lease file | PASS |
| 5a | first `tryAcquireLease` on a fresh run succeeds | PASS |
| 5b | second acquire on same run returns `{ok: false, reason: 'busy'}` | PASS |
| 5c | short-TTL caller cannot early-steal a fresh holder's lease (stored-TTL semantics — Codex review) | PASS |
| 6a | stale-test first acquire succeeds | PASS |
| 6b | after stored `ttl*2` elapsed, reclaim succeeds and reports `reclaimed_from` | PASS |
| 6c | reclaim marks prior state as `interrupted` (previously comment-only — Codex review) | PASS |
| **Stale lock recovery (new — Codex review)** | | |
| SL0 | found a dead PID to impersonate | PASS |
| SL1 | stale `.lock` with dead-PID holder is reclaimed (not wedged forever) | PASS |
| SL2 | `.lock` file removed after the critical section exits | PASS |
| **Orphan subprocess kill (new — Codex review)** | | |
| O1 | orphan subprocess is alive after detached spawn | PASS |
| O2 | stale lease with live PID is reclaimed | PASS |
| O3 | orphan actually dies via reclaim SIGTERM (not just the code-path firing) | PASS |
| **Stdio discipline** | | |
| 7a | every line on server stdout parses as JSON-RPC framing — now exercised via `ralph_discover` tool call (Codex review) | PASS |
| 7b | at least one MCP tool response observed on stdout | PASS |

**Observable #8 — install-shape / fresh-path test:** `tests/move-test.sh` copies the slice (including `node_modules/`) to `/tmp/dbmv-move-*/installed-plugin/` and re-runs `tests/smoke.ts` from there. All 29 observables PASS from the moved location, proving the slice has no monorepo-relative imports and resolves `lib-bundled/` + `node_modules/` from wherever it is installed.

---

## What worked (less noteworthy than you'd expect)

- **MCP SDK `registerTool` with zod schema** — direct, minimal. Input validation handled by the SDK; handler just receives typed args.
- **`StdioServerTransport`** — owns stdio framing; no manual JSON-RPC parsing needed. As long as nothing else in the process writes to stdout, the channel stays clean.
- **Atomic state writes** via temp-file + same-filesystem rename — POSIX rename atomicity is load-bearing; `fs.renameSync` delivers it.
- **Step lease with owner_id + heartbeat_at + TTL** — the primitive works as designed. Reclaim-on-stale fires when heartbeat is older than `ttl * 2`, logs `lease_expired`, SIGTERMs owned PIDs, then proceeds. Tested via direct state-store calls; covered observables #5b and #6b.

## Surprises

- **None substantial.** No MCP SDK version mismatch, no Bun stdout buffering weirdness, no stdio contamination from imports. The first end-to-end run passed all 19 observables.
- One minor: MCP SDK's `StdioClientTransport` takes `{command, args}` (the client spawns the server itself). This is what makes smoke tests trivially scriptable.

## What was NOT tested (honest scope, after Codex review)

- **Cross-process lease contention at the tool surface.** Our `ralph_discover` tool generates a fresh `run_id` per call, so two concurrent tool calls can't collide by design. The lease's busy/reclaim behavior is exercised in-process via direct state-store calls (obs #5a/b/c, #6a/b/c, #SL1, #O2/O3). True cross-process collision lands in Phase 5 when `ralph_next(run_id)` takes a caller-supplied run_id.
- **Fsync durability of atomic writes.** `atomicWrite` uses temp-file + rename for atomicity of visibility, not crash durability. A power loss between rename and fsync could lose the write. Phase 5 will add `fsync(fd)` on temp file + `fsync(dir)` on the directory before returning.
- **Process-group / subprocess-tree kill.** `tryAcquireLease` sends SIGTERM to each owned PID individually. If the real `@vcp-lib/llm-runner` subprocess spawns grandchildren (e.g. a shim that execs a provider CLI), those aren't reached. Phase 5 should launch subprocesses with their own process group (`detached: true` on POSIX) and kill the group.
- **Clock jumps.** Lease heartbeat uses `Date.now()` wall clock. A system clock jump forward can produce false-stale reclaim; a jump backward can produce immortal-seeming leases. Phase 5 should use monotonic time for age calculations (Node doesn't expose a raw monotonic API at that granularity; `performance.now()` relative to a per-lease baseline plus a tolerance band works).
- **Real runner stdout contamination.** The stub writes exactly one JSON object. The real Vercel AI SDK + agentool stack can emit provider warnings, deprecation notices, unhandled rejection dumps. Phase 5 must run a real-runner probe before freezing the `@vcp-lib/llm-runner` contract; the server's stdio discipline (stderr-to-file, stdout-never-inherited) protects the MCP channel but can't silence a runner that writes to its own stdout pre-JSON.
- **Provider auth env propagation.** The stub needs no credentials; the real runner does. `server.ts` currently inherits no explicit env. Phase 5 needs a deliberate env-allowlist (which provider keys to pass through) and a test that confirms a missing preset credential surfaces the right error.
- **MCP client disconnect mid-tool-call.** `runDiscover` awaits `child.close()` synchronously; if the MCP client disconnects, the subprocess continues and state commits regardless. Phase 5 should add an AbortController tied to the MCP request lifecycle that kills the subprocess and marks state `interrupted` on disconnect.
- **Windows.** Tested on Linux (WSL2). POSIX `openSync(path, 'wx')`, `fs.renameSync`, `process.kill`, and `detached: true` semantics all work here. Windows verification is Phase 5 scope; risk #30 already tracks it.
- **Real Codex CLI invocation of the slice.** Codex's own sandbox can't create user namespaces on this WSL kernel (bubblewrap limitation surfaced during Phase 0 probes). The slice's MCP client/server round-trip uses the same MCP SDK Codex uses. Installing the slice into `~/.codex/config.toml` as an `[mcp_servers.*]` block is Phase 5e territory, not Phase 0.5.

---

## Decisions locked in for Phase 5 (proven here)

Every one of these is a direct lift from code that passed the 29-observable suite — no redesign needed in Phase 5.

1. **Lease shape.** `{owner_id, step_name, acquired_at, heartbeat_at, lease_ttl_ms, owned_subprocess_pids[]}`. Phase 5 may extend but shouldn't re-shape these fields.
2. **Stored-TTL semantics.** Staleness is evaluated against the holder's stored `lease_ttl_ms`, not the caller's. A new caller with a shorter TTL cannot shrink the holder's grace period.
3. **Reclaim writes interrupted state.** When reclaim fires, the prior run's `state.json` is updated to `status: 'interrupted'` with a summary that names the prior owner. This matches the primitive's contract and is observable by the next caller (obs #6c).
4. **Mutation lock has stale detection.** `.lock` contains the holder's PID; on EEXIST, the waiting caller checks if the PID is alive and unlinks the lock if not. No more permanent wedge on holder crash (obs #SL1, #SL2).
5. **Orphan-kill on reclaim.** Each owned PID receives SIGTERM during reclaim. Proven end-to-end with a live subprocess (obs #O3), not just a code-path walk.
6. **Atomic state writes** via temp-file + rename on the same filesystem. Schema-versioned, fail-fast on mismatch. (Durability — fsync — deferred to Phase 5.)
7. **Subprocess stderr goes to `subprocess-stderr/<step>-<timestamp>.log`**, never inherited. stdio: `['ignore', 'pipe', <fd>]`.
8. **Failure-path discipline.** Non-zero exit AND invalid JSON both result in `status: 'failed'` with lease released (obs #F1/F2/F3). Phase 5 should keep this shape when swapping the real runner in.
9. **Structured events** to `events.jsonl` via `logger.ts` (file-only logger). Logger never writes to stdout/stderr — that's the invariant that keeps the MCP channel clean through tool calls (obs #7a).
10. **`${CLAUDE_PLUGIN_ROOT}` in plugin.json + `import.meta.url` inside server.ts for resolving the runner path** — no env var hacks, no monorepo-relative paths. This is exactly the packaging shape `scripts/bundle-plugin.ts` must produce.

## Phase 5 risk list additions (from Codex review)

To be appended to the plan's Phase 5 risk enumeration:

- **Real runner stdout contamination.** Pre-JSON provider warnings / deprecation notices / unhandled rejections. Mitigation: a real-runner probe before freezing `@vcp-lib/llm-runner` contract; tool handler parses only the final JSON line, treats any preceding non-JSON as stderr-equivalent (logged, not in tool response).
- **Provider auth env propagation.** Phase 5 must define an env-allowlist per preset; a missing credential must surface with a specific error, not a silent subprocess failure.
- **MCP client disconnect cleanup.** Tie subprocess lifecycle to the MCP request's AbortController.
- **Process-group / subprocess-tree kill.** `detached: true` launch + `kill(-pgid)` on POSIX; documented Windows fallback.
- **Atomic-write durability.** Add fsync on temp-file + parent-directory before rename.
- **Clock jump resilience.** Monotonic time for lease-age calculation.
- **Same-run-id tool-level collision** (new in Phase 5 when tools take caller-supplied `run_id`).

---

## Phase 1 green light

Slice WORKS. Phase 1 library extractions can proceed with a proven consumer shape:

- `@vcp-lib/logging` must provide a file-only event log (no stdout writes); Phase 0.5's `logger.ts` is the reference implementation.
- `@vcp-lib/runtime-adapter` must resolve plugin root from `import.meta.url` when env var is absent; Phase 0.5 proves this works install-shape.
- `@vcp-lib/llm-runner` must spawn as subprocess with configurable stdio and emit a JSON envelope on stdout; Phase 0.5's stub shows the contract.
- `@vcp-lib/prompt-assets` is split from `@vcp-lib/llm-runner` because MCP prompt registration (Phase 5f) will consume prompt content WITHOUT the runner — the slice doesn't prove this consumer yet but the split is defensible on design grounds.

No architectural change needed. Proceed to Phase 1a.
