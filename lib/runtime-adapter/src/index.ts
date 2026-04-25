/**
 * Runtime adapter — host-neutral access to environment-derived paths.
 *
 * Centralizes the `process.env.CLAUDE_PROJECT_DIR || <fallback>` pattern that
 * was previously inlined at every hook and script entry point. Callers that
 * parse a stdin `cwd` (like security-gate) pass it as the fallback; plain
 * callers get `process.cwd()`.
 */

export function projectDir(fallback?: string): string {
  return process.env.CLAUDE_PROJECT_DIR || fallback || process.cwd();
}
