#!/usr/bin/env bun
/**
 * MCP server entry point. Keep stdout reserved for MCP framing before
 * any static imports can evaluate.
 */

export {};

console.log = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(" ") + "\n");
console.info = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(" ") + "\n");
console.warn = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(" ") + "\n");

const mod = await import("./server.ts");
await mod.main();
