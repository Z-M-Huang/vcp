/**
 * One-shot migration from the legacy monolithic state layout to the v2
 * per-unit-file layout.
 *
 * Legacy (v1):  .vcp/plan/.state/ralph-{slug}.json    (a single StateMachineState)
 * New     (v2): .vcp/plan/.state/ralph-{slug}/plan.json + units/unit-N.json
 *
 * Protocol (see plan §Migration):
 *
 *   1. Detect         — new dir absent AND legacy monolith present ⇒ migrate
 *   2. Stage          — build the full target tree under .state/.migrate/<txnId>/
 *   3. Commit         — single atomic rename publishes the result into .state/
 *   4. Retire         — sideline the legacy monolith to .state/.legacy/ (never delete)
 *   5. Orphan recovery — older-than-15-min staging dirs with no finished_at are
 *                        logged + removed; sources are untouched
 *
 * Crash safety:
 *
 *   • Pre-stage crash  → legacy monolith intact, no migration started
 *   • Mid-stage crash  → staging dir left behind, legacy monolith intact;
 *                        orphan recovery removes the staging dir and the next
 *                        ensureStateMigrated call retries fresh
 *   • Post-commit, pre-retire crash → both layouts coexist; ensureStateMigrated
 *                                      detects the new dir first and retires
 *                                      the dangling legacy monolith
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  PlanState,
  StateMachineState,
  UnitState,
} from './types.ts';
import {
  planJsonPath,
  planRoot,
  progressDirPath,
  sha1Hex,
  unitJsonPath,
  unitsDirPath,
} from './unit-state.ts';
import { parseUnitPlan } from './parsers.ts';
import { splitUnitFile } from './unit-file.ts';

// ─── TUNABLES ───────────────────────────────────────────────────────────────

/** How long a staging dir may sit without finished_at before being treated as orphaned. */
export const MAX_MIGRATE_MS = 15 * 60 * 1000; // 15 min

/** Progress-file attribution window: match files whose started_at falls within ± this of the plan's startedAt. */
const PROGRESS_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000; // 10 min

// ─── PATH HELPERS ───────────────────────────────────────────────────────────

function stateRootDir(projectDir: string): string {
  return path.join(projectDir, '.vcp', 'plan', '.state');
}

function legacyMonolithPath(projectDir: string, slug: string): string {
  return path.join(stateRootDir(projectDir), `ralph-${slug}.json`);
}

function migrateStagingRoot(projectDir: string): string {
  return path.join(stateRootDir(projectDir), '.migrate');
}

function legacyArchiveDir(projectDir: string): string {
  return path.join(stateRootDir(projectDir), '.legacy');
}

function unitsDirSrc(projectDir: string, slug: string): string {
  return path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
}

// ─── ID HELPERS ─────────────────────────────────────────────────────────────

/**
 * Time-ordered id. Not a spec ULID — we don't need cross-system sortability,
 * just lexicographic ordering by creation time within the .state tree.
 */
function txnId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(6).toString('hex');
  return `${ts}-${rand}`;
}

export function decomposeRunId(): string {
  return txnId();
}

// ─── MANIFEST ───────────────────────────────────────────────────────────────

interface MigrationManifest {
  txnId: string;
  slug: string;
  sources: {
    legacyMonolith: string;
    unitsDir: string;
  };
  started_at: string;
  finished_at: string | null;
  units: Array<{ id: number; sourceFile: string; targetFile: string }>;
  progressFilesAttributed: Array<{ source: string; target: string }>;
  notes: string[];
}

function writeManifest(filePath: string, manifest: MigrationManifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readManifest(filePath: string): MigrationManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MigrationManifest;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// ─── DETECTION ──────────────────────────────────────────────────────────────

export function isMigrationNeeded(projectDir: string, slug: string): boolean {
  const newExists = fs.existsSync(planJsonPath(projectDir, slug));
  const legacyExists = fs.existsSync(legacyMonolithPath(projectDir, slug));
  return !newExists && legacyExists;
}

/**
 * List every slug that has a legacy monolith under .state/ (for bulk operations
 * or startup diagnostics).
 */
export function listLegacyMonolithSlugs(projectDir: string): string[] {
  const root = stateRootDir(projectDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const slugs: string[] = [];
  for (const name of entries) {
    const match = name.match(/^ralph-([^/]+)\.json$/);
    if (!match) continue;
    slugs.push(match[1]);
  }
  return slugs;
}

// ─── LEGACY STATE READ ──────────────────────────────────────────────────────

function readLegacyMonolith(projectDir: string, slug: string): StateMachineState | null {
  try {
    const raw = fs.readFileSync(legacyMonolithPath(projectDir, slug), 'utf-8');
    const parsed = JSON.parse(raw) as StateMachineState;
    if (!parsed.blockedBy) parsed.blockedBy = {};
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function listUnitFiles(projectDir: string, slug: string): Array<{ id: number; filename: string; fullPath: string }> {
  const dir = unitsDirSrc(projectDir, slug);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ id: number; filename: string; fullPath: string }> = [];
  for (const name of names) {
    const m = name.match(/^unit-(\d+)\.md$/);
    if (!m) continue;
    out.push({
      id: parseInt(m[1], 10),
      filename: name,
      fullPath: path.join(dir, name),
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

// ─── STAGING ────────────────────────────────────────────────────────────────

interface StagingPaths {
  root: string;        // .state/.migrate/<txnId>
  slugRoot: string;    // .state/.migrate/<txnId>/ralph-{slug}
  planJson: string;
  unitsDir: string;
  progressDir: string;
  manifest: string;
}

function stagingPaths(projectDir: string, slug: string, id: string): StagingPaths {
  const root = path.join(migrateStagingRoot(projectDir), id);
  const slugRoot = path.join(root, `ralph-${slug}`);
  return {
    root,
    slugRoot,
    planJson: path.join(slugRoot, 'plan.json'),
    unitsDir: path.join(slugRoot, 'units'),
    progressDir: path.join(slugRoot, 'progress'),
    manifest: path.join(root, '_manifest.json'),
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

function rmrfBestEffort(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ─── PROGRESS-FILE ATTRIBUTION (best-effort) ────────────────────────────────

const RALPH_STAGE_TYPES = new Set([
  'ralph-build',
  'ralph-code-review',
  'ralph-uat',
  'ralph-requirements',
  'discovery',
  'decomposition',
]);

interface ProgressAttribution {
  source: string;
  target: string;
}

function attributeProgressFiles(
  projectDir: string,
  stagedProgressDir: string,
  planStartedAt: string | undefined,
): ProgressAttribution[] {
  const stateRoot = stateRootDir(projectDir);
  let names: string[];
  try {
    names = fs.readdirSync(stateRoot);
  } catch {
    return [];
  }
  const candidates = names.filter(n => /^stage-progress-.+\.json$/.test(n));
  if (candidates.length === 0 || !planStartedAt) return [];

  const planMs = Date.parse(planStartedAt);
  if (Number.isNaN(planMs)) return [];

  fs.mkdirSync(stagedProgressDir, { recursive: true });
  const attributed: ProgressAttribution[] = [];

  for (const name of candidates) {
    const src = path.join(stateRoot, name);
    let body: { stage?: string; started_at?: string };
    try {
      body = JSON.parse(fs.readFileSync(src, 'utf-8'));
    } catch {
      continue; // unreadable — skip
    }
    if (!body.stage || !RALPH_STAGE_TYPES.has(body.stage)) continue;
    if (!body.started_at) continue;
    const startedMs = Date.parse(body.started_at);
    if (Number.isNaN(startedMs)) continue;
    if (Math.abs(startedMs - planMs) > PROGRESS_ATTRIBUTION_WINDOW_MS) continue;
    // Copy (not move) into staging — retirement step deletes originals only after commit.
    const target = path.join(stagedProgressDir, name);
    fs.copyFileSync(src, target);
    attributed.push({ source: src, target });
  }
  return attributed;
}

// ─── RESULT TYPES ───────────────────────────────────────────────────────────

export type MigrationStatus =
  | 'nothing_to_migrate'
  | 'already_migrated'
  | 'retired_dangling_legacy'
  | 'migrated';

export interface MigrationResult {
  slug: string;
  status: MigrationStatus;
  txnId?: string;
  unitsMigrated?: number;
  progressFilesAttributed?: number;
  legacyArchivedAt?: string;
  notes: string[];
}

// ─── STAGING STEP ───────────────────────────────────────────────────────────

function stageMigration(projectDir: string, slug: string): {
  paths: StagingPaths;
  manifest: MigrationManifest;
  planState: PlanState;
  unitStates: UnitState[];
} {
  const id = txnId();
  const paths = stagingPaths(projectDir, slug, id);
  const notes: string[] = [];

  const legacy = readLegacyMonolith(projectDir, slug);
  if (!legacy) {
    throw new Error(`stageMigration: legacy monolith missing for ${slug}`);
  }

  const unitFiles = listUnitFiles(projectDir, slug);
  const runId = decomposeRunId();

  const unitIds: number[] = [];
  const unitFileHashes: Record<number, string> = {};
  const unitStates: UnitState[] = [];

  for (const uf of unitFiles) {
    const content = fs.readFileSync(uf.fullPath, 'utf-8');
    const parsed = parseUnitPlan(content, uf.id);
    const { reviewFeedback } = splitUnitFile(content);
    const hash = sha1Hex(content);

    const state: UnitState = {
      id: uf.id,
      decomposeRunId: runId,
      generation: 0,
      status: parsed.status,
      attempts: parsed.attempts,
      maxAttempts: parsed.maxAttempts,
      attemptHistory: [],
      identicalFailureCount: 0,
    };
    if (reviewFeedback) {
      state.reviewFeedback = reviewFeedback;
      state.unitFileHashAtReview = hash;
    }

    unitIds.push(uf.id);
    unitFileHashes[uf.id] = hash;
    unitStates.push(state);
  }

  // Missing-dep + duplicate-dep checks are out of scope for migration — parsers.ts
  // listUnits() validates at runtime. We preserve whatever the legacy monolith had.
  const planState: PlanState = {
    slug,
    schemaVersion: 2,
    decomposeRunId: runId,
    status: legacy.status,
    outerIteration: legacy.outerIteration ?? 0,
    reviewIteration: legacy.reviewIteration ?? 0,
    taskIds: legacy.taskIds ?? {},
    blockedBy: legacy.blockedBy ?? {},
    unitIds,
    unitFileHashes,
    startedAt: legacy.lastTimestamp ?? new Date().toISOString(),
    lastAction: 'migrated-from-legacy',
    lastTimestamp: new Date().toISOString(),
  };

  if (unitFiles.length === 0) {
    notes.push('no unit-*.md files found in ralph/{slug}/');
  }

  // Stage: plan.json, units/unit-N.json, progress/ dir (empty or attributed).
  fs.mkdirSync(paths.slugRoot, { recursive: true });
  writeJsonAtomic(paths.planJson, planState);
  fs.mkdirSync(paths.unitsDir, { recursive: true });
  for (const st of unitStates) {
    writeJsonAtomic(path.join(paths.unitsDir, `unit-${st.id}.json`), st);
  }
  fs.mkdirSync(paths.progressDir, { recursive: true });
  const progressAttributions = attributeProgressFiles(projectDir, paths.progressDir, planState.startedAt);
  if (progressAttributions.length > 0) {
    notes.push(`attributed ${progressAttributions.length} stage-progress file(s) by stage+started_at window`);
  }

  const manifest: MigrationManifest = {
    txnId: id,
    slug,
    sources: {
      legacyMonolith: legacyMonolithPath(projectDir, slug),
      unitsDir: unitsDirSrc(projectDir, slug),
    },
    started_at: new Date().toISOString(),
    finished_at: null,
    units: unitStates.map(s => ({
      id: s.id,
      sourceFile: path.join(unitsDirSrc(projectDir, slug), `unit-${s.id}.md`),
      targetFile: path.join(unitsDirPath(projectDir, slug), `unit-${s.id}.json`),
    })),
    progressFilesAttributed: progressAttributions,
    notes,
  };
  writeManifest(paths.manifest, manifest);

  return { paths, manifest, planState, unitStates };
}

// ─── COMMIT + RETIRE ────────────────────────────────────────────────────────

function commitStaging(projectDir: string, slug: string, paths: StagingPaths): void {
  const targetRoot = planRoot(projectDir, slug);
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  // Single atomic rename — this is the publish step. A reader that lists
  // .state/ before this rename sees the legacy monolith only; after, sees the
  // new directory only.
  fs.renameSync(paths.slugRoot, targetRoot);
}

function retireLegacyMonolith(projectDir: string, slug: string, id: string): string {
  const legacyPath = legacyMonolithPath(projectDir, slug);
  if (!fs.existsSync(legacyPath)) return '';
  fs.mkdirSync(legacyArchiveDir(projectDir), { recursive: true });
  const archivePath = path.join(legacyArchiveDir(projectDir), `ralph-${slug}-${id}.json`);
  fs.renameSync(legacyPath, archivePath);
  return archivePath;
}

function retireAttributedProgressSources(manifest: MigrationManifest): void {
  for (const p of manifest.progressFilesAttributed) {
    try { fs.unlinkSync(p.source); } catch { /* already gone */ }
  }
}

function finalizeManifest(stagingManifestPath: string, committedManifestPath: string): void {
  const manifest = readManifest(stagingManifestPath);
  if (!manifest) return;
  manifest.finished_at = new Date().toISOString();
  // If the slug root was renamed out from under the staging dir, the manifest
  // lives next to the published tree (one level up from progress/). Write the
  // finalized version there and best-effort cleanup the staging shell.
  writeManifest(committedManifestPath, manifest);
}

// ─── ENTRY POINT ────────────────────────────────────────────────────────────

/**
 * Idempotent, crash-safe migration. Call this on --action next BEFORE any
 * other state access. Returns immediately for already-migrated slugs.
 */
export function ensureStateMigrated(
  projectDir: string,
  slug: string,
): MigrationResult {
  const notes: string[] = [];
  const newExists = fs.existsSync(planJsonPath(projectDir, slug));
  const legacyExists = fs.existsSync(legacyMonolithPath(projectDir, slug));

  // Case 1 — already migrated. If the legacy monolith also exists, we crashed
  // post-commit but pre-retire: retire it now.
  if (newExists) {
    if (legacyExists) {
      const archivedAt = retireLegacyMonolith(projectDir, slug, txnId());
      return {
        slug,
        status: 'retired_dangling_legacy',
        legacyArchivedAt: archivedAt,
        notes: ['retired legacy monolith after detecting new layout already committed'],
      };
    }
    return { slug, status: 'already_migrated', notes };
  }

  // Case 2 — no migration applicable.
  if (!legacyExists) {
    return { slug, status: 'nothing_to_migrate', notes };
  }

  // Case 3 — run the full migration.
  const { paths, manifest } = stageMigration(projectDir, slug);
  commitStaging(projectDir, slug, paths);
  // At this point .state/ralph-{slug}/ exists. The staging root at
  // .state/.migrate/<txnId>/ still has _manifest.json (the slug dir moved
  // out). Finalize the manifest alongside the published tree.
  const committedManifestPath = path.join(planRoot(projectDir, slug), '_migrate-manifest.json');
  finalizeManifest(paths.manifest, committedManifestPath);
  // Best-effort cleanup of the staging shell — source files are untouched by
  // the rename, so nothing is lost if this fails.
  rmrfBestEffort(paths.root);

  const archivedAt = retireLegacyMonolith(projectDir, slug, manifest.txnId);
  retireAttributedProgressSources(manifest);

  return {
    slug,
    status: 'migrated',
    txnId: manifest.txnId,
    unitsMigrated: manifest.units.length,
    progressFilesAttributed: manifest.progressFilesAttributed.length,
    legacyArchivedAt: archivedAt,
    notes: manifest.notes,
  };
}

// ─── ORPHAN RECOVERY ────────────────────────────────────────────────────────

export interface OrphanReport {
  txnId: string;
  slug?: string;
  stagingPath: string;
  manifest: MigrationManifest | null;
  ageMs: number;
  removed: boolean;
  reason: string;
}

/**
 * Scan .state/.migrate/ for staging dirs older than maxMs without a
 * finished_at timestamp. Returns a report of what was found; removes orphans
 * unless dryRun is set. Source files (legacy monolith, unit-*.md) are never
 * touched — only the staging shell is removed.
 */
export function scanOrphanStagingDirs(
  projectDir: string,
  opts: { maxMs?: number; dryRun?: boolean; nowMs?: number } = {},
): OrphanReport[] {
  const maxMs = opts.maxMs ?? MAX_MIGRATE_MS;
  const dryRun = opts.dryRun ?? false;
  const now = opts.nowMs ?? Date.now();
  const root = migrateStagingRoot(projectDir);

  let children: string[];
  try {
    children = fs.readdirSync(root);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const reports: OrphanReport[] = [];
  for (const name of children) {
    const stagingPath = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(stagingPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const manifestPath = path.join(stagingPath, '_manifest.json');
    const manifest = readManifest(manifestPath);

    let referenceMs: number;
    let reason: string;
    if (manifest && manifest.started_at) {
      referenceMs = Date.parse(manifest.started_at);
      if (manifest.finished_at) {
        // Finished — this is a stale committed staging that wasn't cleaned up.
        // Safe to remove regardless of age.
        reason = 'finished staging shell left behind';
      } else {
        reason = 'staging with no finished_at';
      }
    } else {
      referenceMs = stat.mtimeMs;
      reason = 'staging with no manifest';
    }

    const ageMs = now - referenceMs;
    const isOrphan = manifest?.finished_at ? true : ageMs > maxMs;
    if (!isOrphan) continue;

    if (!dryRun) rmrfBestEffort(stagingPath);
    reports.push({
      txnId: name,
      slug: manifest?.slug,
      stagingPath,
      manifest,
      ageMs,
      removed: !dryRun,
      reason,
    });
  }
  return reports;
}
