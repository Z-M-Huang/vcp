/**
 * Unit-file markdown surgery. Shared by the build runner, parsers, and the
 * state machine — anything that reads or rewrites `unit-<id>.md`.
 *
 * The unit file is dual-purpose today: an immutable LLM-authored static plan
 * (acceptance criteria, interface contract, done-when) **plus** a mutable
 * runner-owned tail (review feedback, latest build attempt). This module
 * keeps the markdown surgery that preserves that boundary in one place:
 *   - metadata upsert (`**Status:**`, `**Attempts:**`)
 *   - fence-aware heading detection (so code-block `## Done When` doesn't
 *     trigger the tail anchor)
 *   - runner-owned tail read/write (`writeRunnerTail`, `extractReviewFeedback`)
 *   - static/runtime split (`splitUnitFile`)
 *   - atomic file write (`writeUnitStatus`)
 */

import * as fs from 'fs';
import type { UnitStatusPatch } from './types.ts';

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
 * orphaned content when the body itself contains H2/H3 subsections (the
 * dense-mem unit-12.md feedback-duplication bug). Use {@link writeRunnerTail}
 * for the runner-owned tail region instead. Kept exported for tests only.
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

// ─── RUNNER-OWNED TAIL ──────────────────────────────────────────────────────

/** Sentinel marker that anchors the runner-owned tail region (start to EOF). */
export const RUNNER_TAIL_MARKER = '<!-- RUNNER_TAIL_START -->';

/** Where the tail boundary was found, for telemetry. */
export type RunnerTailPath = 'marker' | 'legacy_done_when' | 'append_eof';

export interface RunnerTailResult {
  content: string;
  path: RunnerTailPath;
  /** True when caller passed `reviewFeedback: undefined` and we re-read existing feedback. */
  preservedFeedback: boolean;
  /** Length of the feedback body actually written (post-demotion, post-trim). */
  feedbackChars: number;
  /** Byte length of the input content (pre-write). */
  bytesBefore: number;
  /** Byte length of the returned content (post-write). */
  bytesAfter: number;
  /** True when prior `## Review Feedback` body was non-empty in the input (pre-write). */
  hadExistingFeedback: boolean;
  /**
   * Only set when `preservedFeedback` is true:
   * - `'undefined_input'` → caller passed undefined AND prior body was found
   * - `'missing_from_content'` → caller passed undefined AND no prior body existed
   */
  preservedFeedbackReason?: 'undefined_input' | 'missing_from_content';
}

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
 * List all `## Done When` / `### Done When` heading positions outside fenced
 * code blocks. Used only by the debug-only `runner_tail.anchor_candidates`
 * event to help diagnose unexpected truncation.
 */
export function listDoneWhenCandidates(content: string): number[] {
  const stripped = stripFencesPreservingPositions(content);
  return [...stripped.matchAll(/^(#{2,3})\s+Done When\b.*$/gm)].map(m => m.index!);
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

/**
 * Rewrite the runner-owned tail of a unit file. The tail consists of two H2
 * sections — `## Review Feedback` and `## Latest Build Attempt` — sitting
 * after the `<!-- RUNNER_TAIL_START -->` marker through EOF.
 *
 * **Three-way `reviewFeedback` semantics:**
 * - `undefined` → preserve whatever `## Review Feedback` body is currently in
 *   the file (re-read from the input content).
 * - `''`        → explicitly clear the block (write an empty body).
 * - `'<text>'`  → replace the block body with the given text.
 *
 * **Path selection:**
 * - `marker`    → marker present; truncate from marker to EOF and re-emit.
 * - `legacy_done_when` → no marker; splice in tail right after the LAST
 *   `## Done When` / `### Done When` section (fence-aware).
 * - `append_eof` → no marker, no Done When; preserve existing content and
 *   prepend the marker at EOF. Next write hits the `marker` path.
 */
export function writeRunnerTail(
  content: string,
  opts: { reviewFeedback?: string; latestAttempt: string },
): RunnerTailResult {
  const preservedFeedback = opts.reviewFeedback === undefined;
  const existingFeedback = extractReviewFeedback(content);
  const hadExistingFeedback = existingFeedback.length > 0;
  const feedback = preservedFeedback ? existingFeedback : opts.reviewFeedback!;
  const preservedFeedbackReason: RunnerTailResult['preservedFeedbackReason'] = preservedFeedback
    ? (hadExistingFeedback ? 'undefined_input' : 'missing_from_content')
    : undefined;

  const tail = `${RUNNER_TAIL_MARKER}\n## Review Feedback\n${feedback}\n\n## Latest Build Attempt\n${opts.latestAttempt}\n`;
  const feedbackChars = feedback.length;
  const bytesBefore = content.length;

  // Path 1: marker exists — truncate from marker to EOF
  const markerIdx = content.indexOf(RUNNER_TAIL_MARKER);
  if (markerIdx >= 0) {
    const before = content.slice(0, markerIdx).trimEnd();
    const out = before + '\n\n' + tail;
    return {
      content: out,
      path: 'marker',
      preservedFeedback,
      preservedFeedbackReason,
      feedbackChars,
      bytesBefore,
      bytesAfter: out.length,
      hadExistingFeedback,
    };
  }

  // Path 2: no marker — find last Done When (fence-aware)
  const anchor = findLastDoneWhenAnchor(content);
  if (anchor) {
    // Find where the Done When section's body ends: next heading at H1/H2/H3
    // in the stripped (fence-aware) view, or EOF.
    const stripped = stripFencesPreservingPositions(content);
    const afterAnchor = stripped.slice(anchor.idx + anchor.len);
    const nextHeadingMatch = afterAnchor.match(/^#{1,3}\s/m);
    const sectionEnd = nextHeadingMatch && nextHeadingMatch.index !== undefined
      ? anchor.idx + anchor.len + nextHeadingMatch.index
      : content.length;
    const before = content.slice(0, sectionEnd).trimEnd();
    const out = before + '\n\n' + tail;
    return {
      content: out,
      path: 'legacy_done_when',
      preservedFeedback,
      preservedFeedbackReason,
      feedbackChars,
      bytesBefore,
      bytesAfter: out.length,
      hadExistingFeedback,
    };
  }

  // Path 3: no marker, no Done When — prepend marker at EOF, preserve existing content
  const out = content.trimEnd() + '\n\n' + tail;
  return {
    content: out,
    path: 'append_eof',
    preservedFeedback,
    preservedFeedbackReason,
    feedbackChars,
    bytesBefore,
    bytesAfter: out.length,
    hadExistingFeedback,
  };
}

/**
 * Write unit status, attempts, and runner-owned tail to a unit plan file.
 * Atomic temp-file + rename to prevent partial writes.
 *
 * `reviewFeedback` semantics: see {@link UnitStatusPatch.reviewFeedback}.
 */
export function writeUnitStatus(
  unitPath: string,
  patch: UnitStatusPatch,
): RunnerTailResult & { preWriteContent: string } {
  let content = fs.readFileSync(unitPath, 'utf-8');
  content = upsertMetadataLine(content, 'Status', patch.status);
  content = upsertMetadataLine(content, 'Attempts', String(patch.attempts));
  const preWriteContent = content;

  const result = writeRunnerTail(content, {
    reviewFeedback: patch.reviewFeedback,
    latestAttempt: patch.appendResult,
  });

  const tempPath = `${unitPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, result.content, 'utf-8');
    fs.renameSync(tempPath, unitPath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }

  return { ...result, preWriteContent };
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

// ─── STATIC / RUNTIME SPLIT ─────────────────────────────────────────────────

/**
 * Split a unit file into its static plan (decomposition output) and the
 * runner-owned `## Review Feedback` body. Boundary detection mirrors
 * {@link writeRunnerTail}: marker first, last `Done When` heading second,
 * whole-file fallback last.
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
