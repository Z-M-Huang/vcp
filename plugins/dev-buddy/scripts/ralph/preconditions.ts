import * as fs from 'fs';
import * as path from 'path';
import type { PlanStatus, PlanFileData } from './types.ts';
import { readUnitState } from './unit-state.ts';

/**
 * Check stage-specific preconditions before entering a stage.
 * Returns null if preconditions pass, or a descriptive error string if they fail.
 *
 * Logic ported from ralph-stage-gate.ts (removed in v0.5.0):229-301, rewritten to use
 * structured PlanFileData instead of regex on raw content.
 */
export function checkPreconditions(
  status: PlanStatus,
  planData: PlanFileData,
  projectDir: string,
  slug: string,
): string | null {
  switch (status) {
    // Review gates have no additional preconditions — the prior stage already validated
    case 'discover-review':
    case 'requirements-review':
    case 'decompose-review':
      return null;

    case 'requirements':
      if (!planData.hasDiscovery) {
        return 'Discovery section is still pending. Complete discovery first.';
      }
      return null;

    case 'decompose':
      if (!planData.hasRequirements) {
        return 'Requirements section is still pending. Complete requirements first.';
      }
      if (!planData.hasACs) {
        return 'No acceptance criteria (AC-N) found in plan. Complete requirements first.';
      }
      if (!planData.hasUATs) {
        return 'No UAT scenarios (UAT-N) found in plan. Complete requirements first.';
      }
      return null;

    case 'build': {
      const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
      try {
        const units = fs.readdirSync(unitsDir).filter((f: string) => /^unit-\d+\.md$/.test(f));
        if (units.length === 0) {
          return `No unit plan files found in ${unitsDir}. Complete decompose first.`;
        }
        // Validate unit file structure — required sections must exist
        const requiredSections = [
          '### Entropy', '### Acceptance Criteria', '### Interface Contract',
          '### Test Stubs', '### What to Implement', '### Files to Touch',
          '### Backpressure', '### Done When',
        ];
        const missingSections: string[] = [];
        for (const f of units) {
          const content = fs.readFileSync(path.join(unitsDir, f), 'utf-8');
          for (const section of requiredSections) {
            // Accept both ### and ## heading levels
            const h3 = content.includes(section);
            const h2 = content.includes(section.replace('### ', '## '));
            if (!h3 && !h2) {
              missingSections.push(`${f}: missing "${section}"`);
            }
          }
        }
        if (missingSections.length > 0) {
          return `Unit plan files have missing required sections:\n` +
            missingSections.map(m => `  - ${m}`).join('\n') + '\n' +
            'Re-run decomposition to produce complete unit files.';
        }
      } catch {
        return `No unit plans directory found: ${unitsDir}. Complete decompose first.`;
      }
      return null;
    }

    case 'review': {
      // §10: unit-N.md is immutable post-decompose — runtime status lives in
      // .state/ralph-{slug}/units/unit-N.json. Read unit-state JSON, not markdown.
      const unitsDir = path.join(projectDir, '.vcp', 'plan', 'ralph', slug);
      let unitFiles: string[];
      try {
        unitFiles = fs.readdirSync(unitsDir).filter((f: string) => /^unit-\d+\.md$/.test(f));
      } catch {
        return null; // fail-open: units directory missing
      }
      const notDone: string[] = [];
      for (const f of unitFiles) {
        const idMatch = f.match(/^unit-(\d+)\.md$/);
        if (!idMatch) continue;
        const unitId = parseInt(idMatch[1], 10);
        const unitState = readUnitState(projectDir, slug, unitId);
        const unitStatus = unitState?.status ?? 'unknown';
        if (unitStatus !== 'done') {
          notDone.push(`${f}: ${unitStatus}`);
        }
      }
      if (notDone.length > 0) {
        return `Cannot start code review — ${notDone.length} unit(s) not done:\n` +
          notDone.map(u => `  - ${u}`).join('\n') + '\n' +
          'All units must reach status=done in units/unit-N.json.';
      }
      return null;
    }

    case 'uat':
      if (!planData.hasVerdict || planData.verdictValue !== 'approved') {
        return 'No code review approval found. Complete code review first.';
      }
      return null;

    default:
      return null;
  }
}
