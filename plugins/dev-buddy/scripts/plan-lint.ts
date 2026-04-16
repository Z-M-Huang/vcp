#!/usr/bin/env bun
/**
 * Plan-lint — pre-build validation of unit plans (§5).
 *
 * For each unit, runs its first backpressure command against HEAD. A plan is
 * rejected if any unit's red tests pass (exit 0), meaning the feature already
 * exists and the unit would be wasted work.
 *
 * Usage:
 *   bun plan-lint.ts --plan <path> --cwd <dir>
 *
 * Output: JSON to stdout
 *   { event: 'pass', units: [...] }       — all units have red tests
 *   { event: 'reject', rejections: [...] } — one or more units failed lint
 *
 * Exit codes: 0 always (structured outcome in JSON)
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { extractBackpressureCommands } from './ralph/unit-file.ts';

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

export interface PlanLintResult {
  event: 'pass' | 'reject';
  units: UnitLintResult[];
  rejections: Array<{ unitId: number; reason: string }>;
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

/**
 * Run plan-lint: for each unit, execute its first backpressure command.
 * Units whose tests pass (exit 0) are rejected — the feature already exists.
 * Units without backpressure commands are skipped.
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
  const rejections: Array<{ unitId: number; reason: string }> = [];

  for (const f of unitFiles) {
    const unitId = parseInt(f.match(/unit-(\d+)\.md/)![1], 10);
    const content = fs.readFileSync(path.join(unitsDir, f), 'utf-8');
    const commands = extractBackpressureCommands(content);

    if (commands.length === 0) {
      units.push({ unitId, command: '(none)', exitCode: -1, passed: false, stderr: '' });
      continue;
    }

    // Run the first backpressure command — if it passes against HEAD, the
    // feature already exists and the unit plan is stale.
    const cmd = commands[0];
    const { exitCode, stderr } = execFn(cmd, cwd);
    const passed = exitCode === 0;

    units.push({ unitId, command: cmd, exitCode, passed, stderr });

    if (passed) {
      rejections.push({
        unitId,
        reason: `Unit ${unitId} backpressure command passes against HEAD (exit 0). ` +
          `The feature may already exist — the plan should be re-decomposed.`,
      });
    }
  }

  return {
    event: rejections.length === 0 ? 'pass' : 'reject',
    units,
    rejections,
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
    }));
  }
}
