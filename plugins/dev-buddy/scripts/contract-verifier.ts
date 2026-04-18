#!/usr/bin/env bun
/**
 * Contract Verifier — proves promised exports actually carry the `export`
 * keyword (and resolve under the project's tsconfig) by synthesizing a
 * probe TypeScript file that imports every symbol from the unit's
 * Contract Manifest and asking the TypeScript compiler to typecheck it.
 *
 * Catches the Class-A failure mode where a producer unit declares a symbol
 * but forgets the `export` keyword. The producer's own `tsc` passes because
 * no file in the tree imports it yet (the consumer is a not-yet-built
 * later unit). A later unit then imports it, its `tsc` fails, and blame
 * lands on the wrong unit.
 *
 * Usage:
 *   bun contract-verifier.ts --unit-file <path/to/unit-N.md> --project-dir <dir>
 *
 * Output (JSON to stdout):
 *   { event: 'pass', unitId: N }
 *   { event: 'skip', unitId: N, skipReason: '...' }
 *   { event: 'fail', unitId: N, failures: [...] }
 *   { event: 'error', unitId: N, error: '...' }
 *
 * Exit code: 0 always (structured outcome in JSON).
 *
 * Approach (Option C from the v0.5.7 plan):
 *   1. Read the unit file, extract Contract Manifest JSON
 *   2. Generate probe file with `import` statements for every export
 *   3. Load the project's tsconfig.json, build a Program containing
 *      original files + probe
 *   4. Run semantic + syntactic diagnostics on the probe file
 *   5. Map diagnostics (TS2305 / TS2613 / TS2307) back to manifest entries
 *      via the line number of the failing import statement
 *   6. Clean up the probe file unless --keep-probe is set
 */
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { extractContractManifest } from './ralph/unit-file.ts';
import type { ContractExport, ContractManifest } from './ralph/types.ts';

export interface VerifyArgs {
  unitFile: string;
  projectDir: string;
  unitId?: number;
  keepProbe?: boolean;
}

export interface ContractVerifyFailure {
  symbol: string;
  module: string;
  kind: 'named' | 'type' | 'default';
  /** TypeScript diagnostic code: 2305 (no exported member), 2613 (no default), 2307 (cannot find module). */
  tsCode: number;
  /** Human-readable diagnostic message from the TypeScript checker. */
  message: string;
}

export type ContractVerifyResult =
  | { event: 'pass'; unitId: number }
  | { event: 'skip'; unitId: number; skipReason: string }
  | { event: 'fail'; unitId: number; failures: ContractVerifyFailure[] }
  | { event: 'error'; unitId: number; error: string };

export function parseArgs(argv: string[]): VerifyArgs {
  const findValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const unitFile = findValue('--unit-file');
  const projectDir = findValue('--project-dir');
  if (!unitFile) throw new Error('Missing required flag: --unit-file <path>');
  if (!projectDir) throw new Error('Missing required flag: --project-dir <dir>');
  const unitIdRaw = findValue('--unit-id');
  const unitId = unitIdRaw ? parseInt(unitIdRaw, 10) : undefined;
  const keepProbe = argv.includes('--keep-probe');
  return { unitFile, projectDir, unitId, keepProbe };
}

/**
 * Derive the unit ID from a unit file path like `unit-22.md` when not
 * passed explicitly via --unit-id.
 */
function deriveUnitId(unitFile: string, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const match = path.basename(unitFile).match(/unit-(\d+)\.md/);
  if (match) return parseInt(match[1], 10);
  return 0;
}

/**
 * Compute the import specifier the probe should use for a given module.
 * Returns a project-root-relative path (with leading './') from the probe
 * file's directory to the module file with its extension stripped.
 *
 * For NodeNext / Node16 module resolution, ESM forces explicit extensions
 * — we append `.js` so the probe import matches what the project's own
 * source files would write.
 */
function computeImportSpecifier(
  modulePath: string,
  probeAbsPath: string,
  projectDir: string,
  options: ts.CompilerOptions,
): string {
  const moduleAbs = path.resolve(projectDir, modulePath);
  const moduleNoExt = moduleAbs.replace(/\.tsx?$/, '');
  let rel = path.relative(path.dirname(probeAbsPath), moduleNoExt);
  if (!rel.startsWith('.')) rel = './' + rel;
  rel = rel.split(path.sep).join('/');

  const needsJs =
    options.moduleResolution === ts.ModuleResolutionKind.NodeNext ||
    options.moduleResolution === ts.ModuleResolutionKind.Node16;
  return needsJs ? rel + '.js' : rel;
}

interface GeneratedProbe {
  content: string;
  /** 1-indexed line → manifest entry the probe imports on that line. */
  lineToEntry: Map<number, ContractExport>;
}

/**
 * Build the probe TypeScript source. Each export entry produces an import
 * line plus a non-executing usage that forces the checker to resolve the
 * symbol. Usage form depends on `kind`:
 *   - type:    `import type { X }; type _ = X`  (purely type-level, no value)
 *   - default: `import X from '…'; const _: typeof X = null as any`
 *   - named:   `import { X }; const _: typeof X = null as any`
 *
 * The `null as any` cast prevents constructor invocation at runtime —
 * tsc --noEmit never executes the probe, but keeping it inert means a
 * misconfigured runner that accidentally imports it cannot crash.
 */
function generateProbe(
  manifest: ContractManifest,
  probeAbsPath: string,
  projectDir: string,
  options: ts.CompilerOptions,
): GeneratedProbe {
  const lines: string[] = [
    '// Auto-generated probe file for Contract Manifest verification.',
    '// Created by /app/vcp/plugins/dev-buddy/scripts/contract-verifier.ts',
    '// Safe to delete — recreated on every verifier run.',
    '/* eslint-disable */',
    '',
  ];
  const lineToEntry = new Map<number, ContractExport>();

  for (let i = 0; i < manifest.exports.length; i++) {
    const e = manifest.exports[i];
    const spec = computeImportSpecifier(e.module, probeAbsPath, projectDir, options);
    const lineNum = lines.length + 1;

    if (e.kind === 'type') {
      lines.push(`import type { ${e.symbol} as _t${i} } from '${spec}';`);
      lines.push(`type _ProbeT${i} = _t${i};`);
    } else if (e.kind === 'default') {
      lines.push(`import _d${i} from '${spec}';`);
      lines.push(`const _probeD${i}: typeof _d${i} = null as any;`);
    } else {
      lines.push(`import { ${e.symbol} as _n${i} } from '${spec}';`);
      lines.push(`const _probeN${i}: typeof _n${i} = null as any;`);
    }
    lineToEntry.set(lineNum, e);
  }

  return { content: lines.join('\n') + '\n', lineToEntry };
}

/**
 * TS error codes the verifier treats as a contract violation. Each fires
 * when a probe import cannot be satisfied by the producer file:
 *   1192 — Module 'X' has no default export. (the modern code)
 *   2305 — Module 'X' has no exported member 'Y'. (named symbol absent)
 *   2306 — File 'X' is not a module. (no top-level imports/exports — e.g.,
 *          `class Foo {}` with no `export` keyword)
 *   2307 — Cannot find module 'X'. (the producer file is missing entirely)
 *   2459 — Module declares 'X' locally, but it is not exported. (the symbol
 *          exists in the file but is missing the `export` keyword while
 *          other symbols ARE exported)
 *   2613 — Module 'X' has no default export. (legacy variant of 1192)
 *   2614 — Module 'X' has no exported member 'Y'. Did you mean … (variant)
 *   2724 — Module 'X' has no exported member 'Y'. Did you mean 'Z'? (typo)
 */
const VERIFY_FAILURE_CODES = new Set([1192, 2305, 2306, 2307, 2459, 2613, 2614, 2724]);

/**
 * Map a single TypeScript diagnostic to a ContractVerifyFailure by
 * matching the diagnostic's line number to the line of the import that
 * produced it. Returns null when the diagnostic cannot be attributed
 * (line outside the import map, or unrecognized error code).
 */
function mapDiagnostic(
  d: ts.Diagnostic,
  lineToEntry: Map<number, ContractExport>,
): ContractVerifyFailure | null {
  if (!d.file || d.start === undefined) return null;
  if (!VERIFY_FAILURE_CODES.has(d.code)) return null;

  const { line } = d.file.getLineAndCharacterOfPosition(d.start);
  const lineNum = line + 1;
  let entry = lineToEntry.get(lineNum);
  if (!entry) {
    const lines = [...lineToEntry.keys()].filter(n => n <= lineNum).sort((a, b) => b - a);
    if (lines.length === 0) return null;
    entry = lineToEntry.get(lines[0]);
    if (!entry) return null;
  }

  return {
    symbol: entry.symbol,
    module: entry.module,
    kind: entry.kind,
    tsCode: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  };
}

/**
 * Run the contract verifier end-to-end. Reads the unit file, parses the
 * manifest, generates and typechecks the probe, returns a structured
 * outcome. Exceptions during tsconfig parsing or program creation are
 * caught and returned as `event: 'error'` so the caller never sees a
 * stack trace.
 */
export function verifyContract(args: VerifyArgs): ContractVerifyResult {
  const unitId = deriveUnitId(args.unitFile, args.unitId);

  let content: string;
  try {
    content = fs.readFileSync(args.unitFile, 'utf-8');
  } catch (err) {
    return { event: 'error', unitId, error: `Cannot read unit file: ${(err as Error).message}` };
  }

  const extracted = extractContractManifest(content);
  if (extracted.kind === 'missing') {
    return { event: 'skip', unitId, skipReason: 'no Contract Manifest in unit file (legacy mode)' };
  }
  if (extracted.kind === 'malformed') {
    return { event: 'error', unitId, error: extracted.error };
  }

  const manifest = extracted.manifest;
  if (manifest.exports.length === 0) {
    return { event: 'skip', unitId, skipReason: 'manifest has empty exports[] — nothing to verify' };
  }

  const tsconfigPath = ts.findConfigFile(args.projectDir, ts.sys.fileExists, 'tsconfig.json');
  if (!tsconfigPath) {
    return { event: 'error', unitId, error: `No tsconfig.json found at or above ${args.projectDir}` };
  }

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    return {
      event: 'error',
      unitId,
      error: `Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
    };
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  if (parsed.errors.length > 0) {
    const msgs = parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('; ');
    return { event: 'error', unitId, error: `tsconfig parse errors: ${msgs}` };
  }

  const probeAbsPath = path.join(args.projectDir, '.vcp', `.contract-probe-unit-${unitId}.ts`);
  fs.mkdirSync(path.dirname(probeAbsPath), { recursive: true });

  const probe = generateProbe(manifest, probeAbsPath, args.projectDir, parsed.options);
  fs.writeFileSync(probeAbsPath, probe.content);

  try {
    const program = ts.createProgram(
      [...parsed.fileNames, probeAbsPath],
      { ...parsed.options, noEmit: true },
    );

    const sourceFile = program.getSourceFile(probeAbsPath);
    if (!sourceFile) {
      return { event: 'error', unitId, error: 'Probe file did not load into the TypeScript program' };
    }

    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ];

    const failures: ContractVerifyFailure[] = [];
    for (const d of diagnostics) {
      const f = mapDiagnostic(d, probe.lineToEntry);
      if (f) failures.push(f);
    }

    if (failures.length === 0) return { event: 'pass', unitId };
    return { event: 'fail', unitId, failures };
  } finally {
    if (!args.keepProbe) {
      try { fs.unlinkSync(probeAbsPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Format a fail result as a human-readable mechanical-failure message
 * suitable for the BLR's mechanicalContext.stderr. Each failure becomes
 * one line that names the unit, the symbol, the module, and the actionable
 * fix.
 */
export function formatFailureMessage(result: Extract<ContractVerifyResult, { event: 'fail' }>): string {
  const lines = [
    `Contract verification failed for Unit ${result.unitId}: ${result.failures.length} symbol(s) could not be resolved.`,
    '',
  ];
  for (const f of result.failures) {
    if (f.tsCode === 2459) {
      lines.push(
        `  - Promised export \`${f.symbol}\` (${f.kind}) from \`${f.module}\` is declared locally ` +
        `but missing the \`export\` keyword (TS2459). Add \`export\` to the declaration. tsc: ${f.message}`,
      );
    } else if (f.tsCode === 2305 || f.tsCode === 2614 || f.tsCode === 2724) {
      lines.push(
        `  - Promised export \`${f.symbol}\` (${f.kind}) from \`${f.module}\` is not exported. ` +
        `Add the \`export\` keyword to the declaration. tsc: ${f.message}`,
      );
    } else if (f.tsCode === 2306) {
      lines.push(
        `  - Promised export \`${f.symbol}\` (${f.kind}) from \`${f.module}\`: the file has no top-level ` +
        `\`export\` at all (TS2306 "not a module"). Add \`export\` to the declaration. tsc: ${f.message}`,
      );
    } else if (f.tsCode === 1192 || f.tsCode === 2613) {
      lines.push(
        `  - Promised default export \`${f.symbol}\` from \`${f.module}\` is missing. ` +
        `Add \`export default\` to the declaration. tsc: ${f.message}`,
      );
    } else if (f.tsCode === 2307) {
      lines.push(
        `  - Module \`${f.module}\` cannot be resolved (TS2307). ` +
        `Either the file is missing or the import path is wrong. tsc: ${f.message}`,
      );
    } else {
      lines.push(`  - \`${f.symbol}\` from \`${f.module}\`: TS${f.tsCode} ${f.message}`);
    }
  }
  return lines.join('\n');
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv);
    const result = verifyContract(args);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.log(JSON.stringify({
      event: 'error',
      unitId: 0,
      error: (err as Error).message,
    }));
  }
}
