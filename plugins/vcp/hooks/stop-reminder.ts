/**
 * VCP Stop Reminder — Stop hook
 *
 * Reminds the user to run VCP checks before committing.
 * Always exits 0 (informational only, never blocks).
 *
 * Requires: bun (cross-platform TypeScript runtime)
 */

console.error(
  "Reminder: Run /vcp-security-check, /vcp-quality-check, or /vcp-pre-commit-review before committing."
);
process.exit(0);
