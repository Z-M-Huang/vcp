#!/usr/bin/env bun
/**
 * MCP server entry point. The plugin manifest points at this file
 * (NOT server.ts) so that stdout discipline runs BEFORE any static
 * import evaluates.
 *
 * Why this exists: server.ts has top-level static imports (McpServer,
 * SDK transport, etc.) which run BEFORE any code in server.ts itself.
 * If any of those modules — or their transitive imports — write to
 * stdout during initialization, the bytes interleave with the MCP
 * framing protocol and the connection becomes unparseable.
 *
 * This bootstrap has zero static imports; the console redirections at
 * the top run first, and the dynamic import of server.ts inherits the
 * already-redirected console.
 */

// Marker so TypeScript treats this file as a module (top-level await
// requires module mode).
export {};

console.log = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(" ") + "\n");
console.info = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(" ") + "\n");
console.warn = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(" ") + "\n");

const mod = await import("./server.ts");
await mod.main();
