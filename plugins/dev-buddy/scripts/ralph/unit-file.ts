/**
 * Unit-file markdown utilities. Shared by the build runner, parsers,
 * prompt assembly, and the migration layer.
 *
 * Post-refactor the unit file is immutable after decompose (§10).
 * Runtime state lives in per-unit JSON files under `.state/ralph-{slug}/units/`.
 * This module provides read-only helpers:
 *   - metadata upsert (`**Status:**`, `**Attempts:**`)
 *   - fence-aware heading detection
 *   - static/runtime split (`splitUnitFile`)
 *   - backpressure extraction
 *   - heading demotion for feedback capture
 */

// ─── METADATA LINE UPSERT ──────────────────────────────────────────────────

/**
 * Find `**{label}:** value` in content and replace, or insert below the title if absent.
 * Idempotent: works whether the field exists or not.
 */
export function upsertMetadataLine(content: string, label: string, value: string): string {
  const pattern = new RegExp(`\\*\\*${label}:\\*\\*\\s*\\S+`);
  const replacement = `**${label}:** ${value}`;
  if (pattern.test(content)) {
    return content.replace(pattern, replacement);
  }
  // Insert after the first heading line (# Unit N: ...)
  const titleMatch = content.match(/^#.+$/m);
  if (titleMatch && titleMatch.index !== undefined) {
    const insertPos = titleMatch.index + titleMatch[0].length;
    return content.slice(0, insertPos) + '\n' + replacement + content.slice(insertPos);
  }
  // No title found — prepend
  return replacement + '\n' + content;
}

/**
 * Find a section by heading and replace its body, or append the section at end.
 * The section ends at the next heading of same or higher level, or EOF.
 *
 * @deprecated Naive boundary regex stops at the next H1/H2/H3, which causes
 * orphaned content when the body itself contains H2/H3 subsections.
 * Post-refactor, unit-N.md is immutable after decompose (§10) —
 * this function is retained for legacy compatibility only.
 */
export function replaceOrAppendSection(content: string, heading: string, body: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRegex = new RegExp(`(^${escapedHeading}\\s*$)([\\s\\S]*?)(?=^#{1,3} |$(?!\\n))`, 'm');
  const match = content.match(sectionRegex);
  if (match && match.index !== undefined) {
    const start = match.index;
    const end = start + match[0].length;
    return content.slice(0, start) + heading + '\n\n' + body + '\n\n' + content.slice(end);
  }
  // Append at end
  return content.trimEnd() + '\n\n' + heading + '\n\n' + body + '\n';
}

// ─── RUNNER-OWNED TAIL (legacy support) ─────────────────────────────────────

/** Sentinel marker that anchors the runner-owned tail region (start to EOF). */
export const RUNNER_TAIL_MARKER = '<!-- RUNNER_TAIL_START -->';

/**
 * Replace fenced code blocks (``` and ~~~) with same-length whitespace so
 * heading regexes don't match `## Done When` lines that live inside a code
 * fence. Position-preserving — indices in the result map to the original.
 */
function stripFencesPreservingPositions(content: string): string {
  return content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Find the LAST `## Done When` / `### Done When` heading outside fenced code
 * blocks. Returns the heading's start index and length in the original
 * content, or null if no such heading exists.
 */
function findLastDoneWhenAnchor(content: string): { idx: number; len: number } | null {
  const stripped = stripFencesPreservingPositions(content);
  const matches = [...stripped.matchAll(/^(#{2,3})\s+Done When\b.*$/gm)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { idx: last.index!, len: last[0].length };
}


/**
 * Extract the body of `## Review Feedback` from existing content. Searches
 * inside the runner tail (after RUNNER_TAIL_MARKER) when present; otherwise
 * scans the whole document. Returns '' when no heading found.
 */
function extractReviewFeedback(content: string): string {
  const markerIdx = content.indexOf(RUNNER_TAIL_MARKER);
  const searchSpace = markerIdx >= 0 ? content.slice(markerIdx) : content;
  const headingMatch = searchSpace.match(/^##\s+Review Feedback\s*$/m);
  if (!headingMatch || headingMatch.index === undefined) return '';
  const afterHeading = searchSpace.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingMatch = afterHeading.match(/^##\s/m);
  const body = nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;
  return body.trim();
}

/**
 * Demote H1/H2 lines to H3 so feedback can never break out of the runner tail
 * region. Pre-store normalization — the captured-from-LLM feedback may contain
 * its own `## Executive Summary` etc. that would otherwise match the tail's
 * H2 boundary regex.
 */
export function demoteFeedbackHeadings(s: string): string {
  return s
    .replace(/^#\s+/gm, '### ')
    .replace(/^##\s+/gm, '### ');
}

// ─── BACKPRESSURE EXTRACTION ────────────────────────────────────────────────

/**
 * Extract backpressure commands from unit file content.
 * Matches both ## Backpressure and ### Backpressure headings.
 */
export function extractBackpressureCommands(content: string): string[] {
  const match = content.match(/^#{2,3} Backpressure\s*$/m);
  if (!match || match.index === undefined) return [];
  const after = content.slice(match.index + match[0].length);
  const nextHeading = after.search(/\n#{2,3} /);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
  return [...section.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(Boolean);
}

// ─── CONTRACT MANIFEST EXTRACTION ───────────────────────────────────────────

import type { ContractManifest, ContractManifestExtractResult } from './types.ts';

/**
 * Extract the Contract Manifest JSON block from a unit-N.md file.
 *
 * Looks for `## Contract Manifest` or `### Contract Manifest`, then the next
 * ```json fenced block within that section (bounded by the next heading of any
 * level). Returns:
 *   - `{ kind: 'missing' }` when the heading is absent (legacy unit)
 *   - `{ kind: 'malformed', error }` when JSON parse fails or shape is wrong
 *   - `{ kind: 'ok', manifest }` when the block parses cleanly
 *
 * The manifest is the source of truth for the mechanical contract verifier and
 * cross-unit wiring validation in plan-lint.
 */
export function extractContractManifest(content: string): ContractManifestExtractResult {
  const headingMatch = content.match(/^#{2,3}\s+Contract Manifest\s*$/m);
  if (!headingMatch || headingMatch.index === undefined) {
    return { kind: 'missing' };
  }

  const after = content.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingMatch = after.match(/^#{1,3}\s/m);
  const sectionEnd = nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? nextHeadingMatch.index
    : after.length;
  const section = after.slice(0, sectionEnd);

  const fenceMatch = section.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    return {
      kind: 'malformed',
      error: 'Contract Manifest heading present but no ```json fenced block found in the section',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch (e) {
    return { kind: 'malformed', error: `Contract Manifest JSON parse failed: ${(e as Error).message}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', error: 'Contract Manifest must be a JSON object with `exports` and `consumes` arrays' };
  }
  const obj = parsed as { exports?: unknown; consumes?: unknown };
  if (!Array.isArray(obj.exports)) {
    return { kind: 'malformed', error: 'Contract Manifest must have an `exports` array (use [] for empty)' };
  }
  if (!Array.isArray(obj.consumes)) {
    return { kind: 'malformed', error: 'Contract Manifest must have a `consumes` array (use [] for empty)' };
  }

  const exports: ContractManifest['exports'] = [];
  for (let i = 0; i < obj.exports.length; i++) {
    const e = obj.exports[i] as { symbol?: unknown; module?: unknown; kind?: unknown };
    if (typeof e !== 'object' || e === null) {
      return { kind: 'malformed', error: `exports[${i}] must be an object` };
    }
    if (typeof e.symbol !== 'string' || !e.symbol) {
      return { kind: 'malformed', error: `exports[${i}].symbol must be a non-empty string` };
    }
    if (typeof e.module !== 'string' || !e.module) {
      return { kind: 'malformed', error: `exports[${i}].module must be a non-empty string` };
    }
    if (e.kind !== undefined && e.kind !== 'named' && e.kind !== 'type' && e.kind !== 'default') {
      return { kind: 'malformed', error: `exports[${i}].kind must be one of 'named' | 'type' | 'default' (omit for 'named')` };
    }
    exports.push({
      symbol: e.symbol,
      module: e.module,
      kind: (e.kind as 'named' | 'type' | 'default' | undefined) ?? 'named',
    });
  }

  const consumes: ContractManifest['consumes'] = [];
  for (let i = 0; i < obj.consumes.length; i++) {
    const c = obj.consumes[i] as { symbol?: unknown; from?: unknown };
    if (typeof c !== 'object' || c === null) {
      return { kind: 'malformed', error: `consumes[${i}] must be an object` };
    }
    if (typeof c.symbol !== 'string' || !c.symbol) {
      return { kind: 'malformed', error: `consumes[${i}].symbol must be a non-empty string` };
    }
    if (typeof c.from !== 'string' || !c.from) {
      return { kind: 'malformed', error: `consumes[${i}].from must be a non-empty string` };
    }
    consumes.push({ symbol: c.symbol, from: c.from });
  }

  return { kind: 'ok', manifest: { exports, consumes } };
}

// ─── STATIC / RUNTIME SPLIT ─────────────────────────────────────────────────

/**
 * Split a unit file into its static plan (decomposition output) and the
 * runner-owned `## Review Feedback` body. Boundary detection:
 * marker first, last `Done When` heading second, whole-file fallback last.
 * Used by prompt-assembly.ts and migrate.ts to extract review feedback
 * from legacy markdown-tail unit files.
 */
export function splitUnitFile(content: string): { staticPlan: string; reviewFeedback: string } {
  const markerIdx = content.indexOf(RUNNER_TAIL_MARKER);
  if (markerIdx >= 0) {
    return {
      staticPlan: content.slice(0, markerIdx).trimEnd(),
      reviewFeedback: extractReviewFeedback(content),
    };
  }
  const anchor = findLastDoneWhenAnchor(content);
  if (anchor) {
    const stripped = stripFencesPreservingPositions(content);
    const afterAnchor = stripped.slice(anchor.idx + anchor.len);
    const nextHeadingMatch = afterAnchor.match(/^#{1,3}\s/m);
    const sectionEnd = nextHeadingMatch && nextHeadingMatch.index !== undefined
      ? anchor.idx + anchor.len + nextHeadingMatch.index
      : content.length;
    return {
      staticPlan: content.slice(0, sectionEnd).trimEnd(),
      reviewFeedback: extractReviewFeedback(content),
    };
  }
  // No marker, no Done When — degraded: whole file as static plan, no feedback
  return { staticPlan: content.trimEnd(), reviewFeedback: '' };
}
