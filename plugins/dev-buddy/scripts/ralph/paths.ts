// ─── RALPH PATH HELPERS ─────────────────────────────────────────────────────
// Shared helpers for deriving Ralph plan paths (slug, unit file) from a plan
// file path. BLR and stage-runner both import from here so the convention —
// plan at `<projectDir>/.vcp/plan/ralph-<slug>.md`, unit at
// `<projectDir>/.vcp/plan/ralph/<slug>/unit-<id>.md` — lives in one place.

import * as path from 'path';

/**
 * Extract the plan slug from a plan file path.
 * Plan filename must match `ralph-<slug>.md`.
 *
 * Throws when the basename does not match — callers that can tolerate a null
 * (e.g. progress-file scoping for one-shot callers) should catch the error.
 */
export function resolveRalphSlug(planPath: string): string {
  const basename = path.basename(planPath);
  const match = basename.match(/^ralph-(.+)\.md$/);
  if (!match) {
    throw new Error(`Cannot extract slug from plan filename: ${basename}`);
  }
  return match[1];
}

/**
 * Resolve the per-unit plan file path.
 * Unit layout: `<plan-dir>/ralph/<slug>/unit-<id>.md`.
 */
export function resolveUnitPath(planPath: string, unitId: number): { unitPath: string; slug: string } {
  const slug = resolveRalphSlug(planPath);
  const unitPath = path.join(path.dirname(planPath), 'ralph', slug, `unit-${unitId}.md`);
  return { unitPath, slug };
}
