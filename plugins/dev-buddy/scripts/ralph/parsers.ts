import * as fs from 'fs';
import * as path from 'path';
import type { PlanStatus, PlanFileData, UnitPlanData, UnitListEntry } from './types.ts';

// ─── PLAN FILE PARSING ─────────────────────────────────────────────────────

/**
 * Parse plan file content and extract all needed data in a single pass.
 * Regex patterns originally ported from hooks/ralph-stage-gate.ts and hooks/uat-completion-gate.ts (removed in v0.5.0).
 */
export function parsePlanFile(content: string): PlanFileData {
  // Status: ralph-stage-gate.ts (removed in v0.5.0):84-87
  const statusMatch = content.match(/\*\*Status:\*\*\s*(\S+)/);
  const status = statusMatch ? statusMatch[1].toLowerCase() as PlanStatus : null;

  // Discovery: present and not "(pending)" — ralph-stage-gate.ts (removed in v0.5.0):234
  const hasDiscovery = /## Discovery/.test(content) && !/## Discovery\n\(pending\)/.test(content);

  // Requirements: present and not "(pending)"
  const hasRequirements = /## Requirements/.test(content) && !/## Requirements\n\(pending\)/.test(content);

  // ACs and UATs: ralph-stage-gate.ts (removed in v0.5.0):243-249
  const hasACs = /### AC-\d+:/.test(content);
  const hasUATs = /### UAT-\d+:/.test(content);

  // Verdict: ralph-stage-gate.ts (removed in v0.5.0):292
  const verdictMatch = content.match(/\*\*Verdict:\*\*\s*(\S+)/i);
  const hasVerdict = verdictMatch !== null;
  const verdictValue = verdictMatch ? verdictMatch[1].toLowerCase() : null;

  // Unit count: rows in markdown table under ## Units of Work
  // Table rows start with | followed by a digit (skip header/separator rows)
  let unitCount = 0;
  const unitsSection = content.split(/^## Units of Work$/m);
  if (unitsSection.length > 1) {
    const tableContent = unitsSection[1].split(/^## /m)[0]; // up to next h2
    const rowMatches = tableContent.match(/^\|\s*\d+\s*\|/gm);
    unitCount = rowMatches ? rowMatches.length : 0;
  }

  // Defined UAT IDs: hooks/uat-completion-gate.ts:117-121
  const definedUATIds: string[] = [];
  const uatDefRegex = /^### UAT-(\d+):/gm;
  let match: RegExpExecArray | null;
  while ((match = uatDefRegex.exec(content)) !== null) {
    definedUATIds.push(match[1]);
  }

  // Passed UAT IDs from LAST ## UAT Results section: hooks/uat-completion-gate.ts:127-137
  const passedUATIds: string[] = [];
  const uatResultsSections = content.split(/^## UAT Results/gm);
  const lastResultsSection =
    uatResultsSections.length > 1
      ? uatResultsSections[uatResultsSections.length - 1]
      : '';
  const uatPassRegex = /^- UAT-(\d+):\s*PASS/gm;
  while ((match = uatPassRegex.exec(lastResultsSection)) !== null) {
    passedUATIds.push(match[1]);
  }

  return {
    status,
    hasDiscovery,
    hasRequirements,
    hasACs,
    hasUATs,
    hasVerdict,
    verdictValue,
    unitCount,
    definedUATIds,
    passedUATIds,
  };
}

// ─── UNIT PLAN PARSING ────────────────────────────────────────────────────────

/**
 * Parse a unit plan markdown file and extract structured data.
 * Returns sensible defaults when fields are missing or content is empty.
 */
export function parseUnitPlan(content: string, unitId: number): UnitPlanData {
  // Status: **Status:** <value>
  const statusMatch = content.match(/\*\*Status:\*\*\s*(\S+)/);
  const rawStatus = statusMatch ? statusMatch[1].toLowerCase() : 'pending';
  const status = (rawStatus === 'done' || rawStatus === 'failed') ? rawStatus : 'pending';

  // Attempts: **Attempts:** <number>
  const attemptsMatch = content.match(/\*\*Attempts:\*\*\s*(\d+)/);
  const attempts = attemptsMatch ? parseInt(attemptsMatch[1], 10) : 0;

  // Max Attempts: **Max Attempts:** <number>
  const maxAttemptsMatch = content.match(/\*\*Max Attempts:\*\*\s*(\d+)/);
  const maxAttempts = maxAttemptsMatch ? parseInt(maxAttemptsMatch[1], 10) : 5;

  // Dependencies: "- Depends on: Unit 1, Unit 2" or "- Depends on: none"
  const dependsOn: number[] = [];
  const depsMatch = content.match(/- Depends on:\s*(.+)/);
  if (depsMatch) {
    const depsStr = depsMatch[1].trim();
    if (depsStr.toLowerCase() !== 'none') {
      const unitRefs = depsStr.match(/Unit\s+(\d+)/gi);
      if (unitRefs) {
        for (const ref of unitRefs) {
          const numMatch = ref.match(/(\d+)/);
          if (numMatch) dependsOn.push(parseInt(numMatch[1], 10));
        }
      }
    }
  }

  // Backpressure commands: lines with inline code under ## or ### Backpressure
  const backpressureCommands: string[] = [];
  const bpSections = content.split(/^#{2,3} Backpressure$/m);
  if (bpSections.length > 1) {
    const bpContent = bpSections[1].split(/^#{2,3} /m)[0]; // up to next h2/h3
    const cmdMatches = bpContent.match(/`([^`]+)`/g);
    if (cmdMatches) {
      for (const m of cmdMatches) {
        backpressureCommands.push(m.slice(1, -1)); // strip backticks
      }
    }
  }

  return { id: unitId, status, attempts, maxAttempts, dependsOn, backpressureCommands };
}

/**
 * Find the next unit eligible for building.
 * Returns the first unit where status='pending' and all dependsOn units are 'done'.
 * Returns null if no unit is eligible (all done, all failed, or unmet dependencies).
 */
export function getNextBuildUnit(units: UnitPlanData[]): UnitPlanData | null {
  const statusById = new Map(units.map(u => [u.id, u.status]));
  for (const unit of units) {
    if (unit.status !== 'pending') continue;
    const depsReady = unit.dependsOn.every(depId => statusById.get(depId) === 'done');
    if (depsReady) return unit;
  }
  return null;
}

// ─── UNIT LISTING WITH VALIDATION ───────────────────────────────────────────

/**
 * List all unit plan files with structured data for task creation.
 * Validates structure: rejects duplicate IDs, detects dependency cycles,
 * warns on missing dependency targets. Falls back to "Unit {id}" for
 * missing titles.
 *
 * @throws Error on duplicate unit IDs or dependency cycles
 * @returns Empty array if units directory does not exist
 */
export function listUnits(projectDir: string, slug: string): UnitListEntry[] {
  const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
  let files: string[];
  try {
    files = fs.readdirSync(unitsDir).filter((f: string) => /^unit-\d+\.md$/.test(f));
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const entries: UnitListEntry[] = [];
  const seenIds = new Set<number>();

  for (const f of files) {
    const id = parseInt(f.match(/unit-(\d+)\.md/)![1], 10);
    if (seenIds.has(id)) {
      throw new Error(`Duplicate unit ID ${id} in ${unitsDir}`);
    }
    seenIds.add(id);

    const content = fs.readFileSync(path.join(unitsDir, f), 'utf-8');
    const parsed = parseUnitPlan(content, id);

    // Title: match both # and ## heading levels
    const titleMatch = content.match(/^#{1,2} Unit \d+:\s*(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : `Unit ${id}`;

    entries.push({
      id,
      title,
      status: parsed.status,
      dependsOn: parsed.dependsOn,
    });
  }

  entries.sort((a, b) => a.id - b.id);

  // Validate: warn on missing dependency targets
  for (const entry of entries) {
    for (const depId of entry.dependsOn) {
      if (!seenIds.has(depId)) {
        console.error(`[listUnits] Warning: Unit ${entry.id} depends on nonexistent Unit ${depId}`);
      }
    }
  }

  // Validate: detect dependency cycles via topological sort
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const depsMap = new Map(entries.map(e => [e.id, e.dependsOn]));

  function visit(id: number): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Dependency cycle detected involving Unit ${id}`);
    }
    visiting.add(id);
    for (const dep of depsMap.get(id) || []) {
      if (seenIds.has(dep)) visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const entry of entries) {
    visit(entry.id);
  }

  return entries;
}
