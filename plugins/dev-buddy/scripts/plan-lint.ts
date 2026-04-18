#!/usr/bin/env bun
/**
 * Plan-lint — pre-build validation of unit plans (§5).
 *
 * Two checks run together; either failing causes the plan to be rejected:
 *
 *   1. **Red-test check.** For each unit, runs its first backpressure command
 *      against HEAD. A plan is rejected if any unit's red tests pass (exit 0),
 *      meaning the feature already exists and the unit would be wasted work.
 *
 *   2. **Wiring check.** For each unit, parses the Contract Manifest JSON
 *      block under `### Contract Manifest`. Validates:
 *        - Manifest JSON parses and matches the {exports[], consumes[]} shape.
 *        - Each `consumes[]` entry resolves to an earlier unit's `exports[]`
 *          entry with the same (symbol, module) pair (strict mode) — or is
 *          flagged as a warning when at least one earlier unit lacks a
 *          manifest (degraded/legacy mode).
 *        - No two units claim the same (symbol, module) export (conflict).
 *
 *      Units missing the manifest entirely run in legacy mode: they emit a
 *      warning (not a rejection) so existing free-form plans like the openhive
 *      v0.5.1 alignment plan continue to work without re-decomposition.
 *
 * Usage:
 *   bun plan-lint.ts --plan <path> --cwd <dir>
 *
 * Output: JSON to stdout
 *   { event: 'pass', units: [...], rejections: [], warnings: [...] }
 *   { event: 'reject', units: [...], rejections: [...], warnings: [...] }
 *
 * Exit codes: 0 always (structured outcome in JSON)
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { extractBackpressureCommands, extractContractManifest } from './ralph/unit-file.ts';
import type { ContractManifest } from './ralph/types.ts';

export interface PlanLintArgs {
  planPath: string;
  cwd: string;
}

export interface UnitLintResult {
  unitId: number;
  command: string;
  exitCode: number;
  passed: boolean;
  stderr: string;
}

export interface PlanLintIssue {
  unitId: number;
  reason: string;
}

export interface PlanLintResult {
  event: 'pass' | 'reject';
  units: UnitLintResult[];
  rejections: PlanLintIssue[];
  warnings: PlanLintIssue[];
}

export function parsePlanLintArgs(argv: string[]): PlanLintArgs {
  const planIdx = argv.indexOf('--plan');
  if (planIdx === -1 || planIdx + 1 >= argv.length) {
    throw new Error('Missing required flag: --plan <plan-file-path>');
  }
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx === -1 || cwdIdx + 1 >= argv.length) {
    throw new Error('Missing required flag: --cwd <project-dir>');
  }
  return { planPath: argv[planIdx + 1], cwd: argv[cwdIdx + 1] };
}

interface ParsedUnit {
  unitId: number;
  content: string;
  manifest: ContractManifest | null;
  manifestError: string | null;
}

interface ProducerEntry {
  unitId: number;
  kind: 'named' | 'type' | 'default';
}

/**
 * Run plan-lint: red-test check + wiring check.
 * Both checks contribute to the same rejections/warnings arrays.
 * Units without backpressure commands skip the red-test check (not a failure).
 */
export function runPlanLint(
  planPath: string,
  cwd: string,
  opts?: { execFn?: (cmd: string, execCwd: string) => { exitCode: number; stderr: string } },
): PlanLintResult {
  const planBasename = path.basename(planPath);
  const slugMatch = planBasename.match(/^ralph-(.+)\.md$/);
  if (!slugMatch) {
    return {
      event: 'reject',
      units: [],
      rejections: [{ unitId: 0, reason: `Cannot extract slug from plan filename: ${planBasename}` }],
      warnings: [],
    };
  }
  const slug = slugMatch[1];
  const unitsDir = path.join(path.dirname(planPath), 'ralph', slug);

  let unitFiles: string[];
  try {
    unitFiles = fs.readdirSync(unitsDir)
      .filter((f: string) => /^unit-\d+\.md$/.test(f))
      .sort((a: string, b: string) => {
        const idA = parseInt(a.match(/unit-(\d+)\.md/)![1], 10);
        const idB = parseInt(b.match(/unit-(\d+)\.md/)![1], 10);
        return idA - idB;
      });
  } catch {
    return {
      event: 'reject',
      units: [],
      rejections: [{ unitId: 0, reason: `Cannot read units directory: ${unitsDir}` }],
      warnings: [],
    };
  }

  const execFn = opts?.execFn ?? ((cmd: string, execCwd: string) => {
    const result = spawnSync('sh', ['-c', cmd], {
      cwd: execCwd,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return { exitCode: result.status ?? 1, stderr: result.stderr || '' };
  });

  const units: UnitLintResult[] = [];
  const rejections: PlanLintIssue[] = [];
  const warnings: PlanLintIssue[] = [];

  // Pass 1: parse every unit's Contract Manifest. Manifest issues collect into
  // rejections (malformed) or warnings (missing). Producer map gets populated
  // in unit-id order so consumes-resolution can enforce "earlier unit only".
  const parsedUnits: ParsedUnit[] = [];
  for (const f of unitFiles) {
    const unitId = parseInt(f.match(/unit-(\d+)\.md/)![1], 10);
    const content = fs.readFileSync(path.join(unitsDir, f), 'utf-8');
    const result = extractContractManifest(content);
    if (result.kind === 'ok') {
      parsedUnits.push({ unitId, content, manifest: result.manifest, manifestError: null });
    } else if (result.kind === 'malformed') {
      parsedUnits.push({ unitId, content, manifest: null, manifestError: result.error });
      rejections.push({ unitId, reason: `Unit ${unitId}: ${result.error}` });
    } else {
      parsedUnits.push({ unitId, content, manifest: null, manifestError: null });
      warnings.push({
        unitId,
        reason: `Unit ${unitId}: no Contract Manifest — running in legacy mode (mechanical contract verifier will skip this unit)`,
      });
    }
  }

  // Pass 2: build producer map and detect conflicts. Two units MUST NOT export
  // the same (symbol, module) pair. Walk in unit-id order so the first writer
  // wins and later collisions are rejected with a clear pointer.
  const producerMap = new Map<string, ProducerEntry>();
  const anyLegacy = parsedUnits.some(u => u.manifest === null && u.manifestError === null);

  for (const u of parsedUnits) {
    if (!u.manifest) continue;
    for (const e of u.manifest.exports) {
      const key = `${e.symbol}::${e.module}`;
      const existing = producerMap.get(key);
      if (existing) {
        rejections.push({
          unitId: u.unitId,
          reason:
            `Unit ${u.unitId} exports \`${e.symbol}\` from \`${e.module}\`, ` +
            `but Unit ${existing.unitId} already claims that export. ` +
            `Each (symbol, module) pair may have only one owning unit.`,
        });
        continue;
      }
      producerMap.set(key, { unitId: u.unitId, kind: e.kind });
    }
  }

  // Pass 3: validate every consumes entry resolves to an earlier producer.
  // Strict mode (no legacy units) → unresolved = REJECT.
  // Degraded mode (any legacy unit) → unresolved = WARNING (might be a legacy
  // producer the parser can't see; conservative to avoid false positives).
  for (const u of parsedUnits) {
    if (!u.manifest) continue;
    for (const c of u.manifest.consumes) {
      const key = `${c.symbol}::${c.from}`;
      const producer = producerMap.get(key);
      if (!producer) {
        const issue: PlanLintIssue = {
          unitId: u.unitId,
          reason:
            `Unit ${u.unitId} consumes \`${c.symbol}\` from \`${c.from}\`, ` +
            `but no earlier unit's Contract Manifest declares that export. ` +
            `Either add it to the producer's exports[] or remove the consumes entry.`,
        };
        if (anyLegacy) warnings.push(issue);
        else rejections.push(issue);
        continue;
      }
      if (producer.unitId >= u.unitId) {
        rejections.push({
          unitId: u.unitId,
          reason:
            `Unit ${u.unitId} consumes \`${c.symbol}\` from \`${c.from}\`, ` +
            `but the producer is Unit ${producer.unitId} (not earlier). ` +
            `consumes entries must resolve to an earlier-numbered unit.`,
        });
      }
    }
  }

  // Pass 4: red-test check — run each unit's first backpressure command.
  // Independent of wiring: failures here always reject (not warning).
  for (const u of parsedUnits) {
    const commands = extractBackpressureCommands(u.content);

    if (commands.length === 0) {
      units.push({ unitId: u.unitId, command: '(none)', exitCode: -1, passed: false, stderr: '' });
      continue;
    }

    const cmd = commands[0];
    const { exitCode, stderr } = execFn(cmd, cwd);
    const passed = exitCode === 0;

    units.push({ unitId: u.unitId, command: cmd, exitCode, passed, stderr });

    if (passed) {
      rejections.push({
        unitId: u.unitId,
        reason: `Unit ${u.unitId} backpressure command passes against HEAD (exit 0). ` +
          `The feature may already exist — the plan should be re-decomposed.`,
      });
    }
  }

  return {
    event: rejections.length === 0 ? 'pass' : 'reject',
    units,
    rejections,
    warnings,
  };
}

if (import.meta.main) {
  try {
    const args = parsePlanLintArgs(process.argv);
    const result = runPlanLint(args.planPath, args.cwd);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.log(JSON.stringify({
      event: 'reject',
      units: [],
      rejections: [{ unitId: 0, reason: (err as Error).message }],
      warnings: [],
    }));
  }
}
