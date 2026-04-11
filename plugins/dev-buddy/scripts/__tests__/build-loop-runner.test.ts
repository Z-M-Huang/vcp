import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  parseBuildLoopArgs,
  upsertMetadataLine,
  replaceOrAppendSection,
  writeUnitStatus,
  extractBackpressureCommands,
  findBuildInvokeAction,
  findErrorAction,
  findBlockedAction,
  collectTaskOps,
  applyWritePlanActions,
  runBuildLoop,
} from '../build-loop-runner.ts';
import type { StateMachineOutput, SkillAction, ErrorAction, BlockedAction, TaskAction, WritePlanAction } from '../ralph/types.ts';

// ─── Temp directory management ─────────────────────────────────────────────

const tmpDirs: string[] = [];
afterAll(() => { tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true })); });

function makeTmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'blr-test-'));
  tmpDirs.push(d);
  return d;
}

// ─── parseBuildLoopArgs ────────────────────────────────────────────────────

describe('parseBuildLoopArgs', () => {
  test('parses --plan and --cwd', () => {
    const result = parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a/b.md', '--cwd', '/c/d']);
    expect(result.planPath).toBe('/a/b.md');
    expect(result.cwd).toBe('/c/d');
  });

  test('throws when --plan missing', () => {
    expect(() => parseBuildLoopArgs(['node', 'script.ts', '--cwd', '/c'])).toThrow('--plan');
  });

  test('throws when --cwd missing', () => {
    expect(() => parseBuildLoopArgs(['node', 'script.ts', '--plan', '/a'])).toThrow('--cwd');
  });
});

// ─── upsertMetadataLine ───────────────────────────────────────────────────

describe('upsertMetadataLine', () => {
  test('replaces existing field', () => {
    const content = '# Unit 1: Test\n**Status:** pending\nSome text';
    const result = upsertMetadataLine(content, 'Status', 'done');
    expect(result).toContain('**Status:** done');
    expect(result).not.toContain('pending');
  });

  test('inserts after title when field absent', () => {
    const content = '# Unit 1: Test\nSome text';
    const result = upsertMetadataLine(content, 'Status', 'done');
    expect(result).toContain('**Status:** done');
    // Should be between title and body
    const lines = result.split('\n');
    expect(lines[0]).toBe('# Unit 1: Test');
    expect(lines[1]).toBe('**Status:** done');
  });

  test('prepends when no title exists', () => {
    const content = 'Just text';
    const result = upsertMetadataLine(content, 'Status', 'done');
    expect(result.startsWith('**Status:** done')).toBe(true);
  });

  test('replaces Attempts field', () => {
    const content = '# Unit 1\n**Status:** pending\n**Attempts:** 1';
    const result = upsertMetadataLine(content, 'Attempts', '2');
    expect(result).toContain('**Attempts:** 2');
    expect(result).not.toContain('**Attempts:** 1');
  });
});

// ─── replaceOrAppendSection ───────────────────────────────────────────────

describe('replaceOrAppendSection', () => {
  test('appends section when absent', () => {
    const content = '# Unit 1: Test\nSome text';
    const result = replaceOrAppendSection(content, '## Latest Build Attempt', 'Attempt 1 result');
    expect(result).toContain('## Latest Build Attempt');
    expect(result).toContain('Attempt 1 result');
  });

  test('replaces existing section body', () => {
    const content = '# Unit 1\n\n## Latest Build Attempt\n\nOld result\n\n## Done When\nAll pass.';
    const result = replaceOrAppendSection(content, '## Latest Build Attempt', 'New result');
    expect(result).toContain('New result');
    expect(result).not.toContain('Old result');
    expect(result).toContain('## Done When');
  });
});

// ─── writeUnitStatus ──────────────────────────────────────────────────────

describe('writeUnitStatus', () => {
  test('writes status and attempts to real file', () => {
    const tmp = makeTmpDir();
    const unitPath = path.join(tmp, 'unit-1.md');
    writeFileSync(unitPath, '# Unit 1: Test\n\n### Backpressure\n- `bun test`\n### Done When\nAll pass.');
    writeUnitStatus(unitPath, { status: 'done', attempts: 1, appendResult: 'All passed.' });
    const content = readFileSync(unitPath, 'utf-8');
    expect(content).toContain('**Status:** done');
    expect(content).toContain('**Attempts:** 1');
    expect(content).toContain('## Latest Build Attempt');
    expect(content).toContain('All passed.');
  });

  test('is idempotent — replaces on second write', () => {
    const tmp = makeTmpDir();
    const unitPath = path.join(tmp, 'unit-1.md');
    writeFileSync(unitPath, '# Unit 1: Test\n**Status:** pending\n**Attempts:** 0');
    writeUnitStatus(unitPath, { status: 'pending', attempts: 1, appendResult: 'Attempt 1 started.' });
    writeUnitStatus(unitPath, { status: 'done', attempts: 1, appendResult: 'Attempt 1 passed.' });
    const content = readFileSync(unitPath, 'utf-8');
    expect(content).toContain('**Status:** done');
    expect(content).toContain('**Attempts:** 1');
    expect(content).toContain('Attempt 1 passed.');
    // Should not contain the old attempt text as the main content
    expect(content).not.toContain('Attempt 1 started.');
  });
});

// ─── extractBackpressureCommands ──────────────────────────────────────────

describe('extractBackpressureCommands', () => {
  test('extracts from ## Backpressure', () => {
    const content = '# Unit 1\n## Backpressure\n- `bun test`\n- `bun run build`\n## Done When';
    expect(extractBackpressureCommands(content)).toEqual(['bun test', 'bun run build']);
  });

  test('extracts from ### Backpressure', () => {
    const content = '# Unit 1\n### Backpressure\n- `bun test src/foo.test.ts`\n### Done When';
    expect(extractBackpressureCommands(content)).toEqual(['bun test src/foo.test.ts']);
  });

  test('returns empty when no section', () => {
    expect(extractBackpressureCommands('# Unit 1\n## Done When\nAll pass.')).toEqual([]);
  });

  test('returns empty for empty section', () => {
    const content = '# Unit 1\n### Backpressure\n\n### Done When';
    expect(extractBackpressureCommands(content)).toEqual([]);
  });
});

// ─── Action inspection helpers ────────────────────────────────────────────

describe('findBuildInvokeAction', () => {
  test('returns build invoke action', () => {
    const sm: StateMachineOutput = {
      actions: [
        { type: 'update_tasks', operations: [{ action: 'update', ref: 'unit:1', status: 'in_progress' }] } as TaskAction,
        { type: 'invoke_skill', skill: 'dev-buddy-build', stageType: 'ralph-build', slug: 'test', unitId: 1, unitPath: '/a/b.md' } as SkillAction,
      ],
      state: { slug: 'test', status: 'build', outerIteration: 0, reviewIteration: 0, units: [], lastAction: 'next', lastTimestamp: '', taskIds: {} },
    };
    const result = findBuildInvokeAction(sm);
    expect(result).not.toBeNull();
    expect(result!.unitId).toBe(1);
  });

  test('returns null for non-build action', () => {
    const sm: StateMachineOutput = {
      actions: [{ type: 'invoke_skill', skill: 'dev-buddy-discover', stageType: 'discovery', slug: 'test' } as SkillAction],
      state: { slug: 'test', status: 'discover', outerIteration: 0, reviewIteration: 0, units: [], lastAction: 'next', lastTimestamp: '', taskIds: {} },
    };
    expect(findBuildInvokeAction(sm)).toBeNull();
  });
});

describe('findErrorAction / findBlockedAction', () => {
  test('finds error action', () => {
    const sm: StateMachineOutput = {
      actions: [{ type: 'error', message: 'boom' } as ErrorAction],
      state: { slug: 'test', status: 'build', outerIteration: 0, reviewIteration: 0, units: [], lastAction: 'next', lastTimestamp: '', taskIds: {} },
    };
    expect(findErrorAction(sm)!.message).toBe('boom');
  });

  test('returns null when no error', () => {
    const sm: StateMachineOutput = {
      actions: [{ type: 'done', summary: 'ok' }],
      state: { slug: 'test', status: 'done', outerIteration: 0, reviewIteration: 0, units: [], lastAction: 'next', lastTimestamp: '', taskIds: {} },
    };
    expect(findErrorAction(sm)).toBeNull();
    expect(findBlockedAction(sm)).toBeNull();
  });
});

describe('collectTaskOps', () => {
  test('extracts operations from update_tasks actions', () => {
    const actions = [
      { type: 'update_tasks', operations: [{ action: 'update', ref: 'unit:1', status: 'in_progress' }] } as TaskAction,
      { type: 'invoke_skill', skill: 'x', stageType: 'y', slug: 'z' } as SkillAction,
      { type: 'update_tasks', operations: [{ action: 'update', ref: 'stage:build', status: 'completed' }] } as TaskAction,
    ];
    const ops = collectTaskOps(actions);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ ref: 'unit:1', status: 'in_progress' });
    expect(ops[1]).toEqual({ ref: 'stage:build', status: 'completed' });
  });
});

// ─── applyWritePlanActions ────────────────────────────────────────────────

describe('applyWritePlanActions', () => {
  test('applies edit pairs to plan file', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, '# Plan\n**Status:** build\nSome content');
    const actions = [
      { type: 'write_plan', edits: [{ old_string: '**Status:** build', new_string: '**Status:** review' }] } as WritePlanAction,
    ];
    applyWritePlanActions(planPath, actions);
    expect(readFileSync(planPath, 'utf-8')).toContain('**Status:** review');
  });

  test('skips edit when old_string not found', () => {
    const tmp = makeTmpDir();
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, '# Plan\n**Status:** build');
    const actions = [
      { type: 'write_plan', edits: [{ old_string: '**Status:** uat', new_string: '**Status:** done' }] } as WritePlanAction,
    ];
    applyWritePlanActions(planPath, actions);
    // Original preserved
    expect(readFileSync(planPath, 'utf-8')).toContain('**Status:** build');
  });
});

// ─── runBuildLoop integration tests ───────────────────────────────────────

/** Create a minimal valid unit plan file. */
function makeUnitPlan(id: number, opts: {
  status?: string; dependsOn?: string; attempts?: number; maxAttempts?: number;
  backpressureCommands?: string[];
} = {}): string {
  const status = opts.status ?? 'pending';
  const deps = opts.dependsOn ?? 'none';
  const attempts = opts.attempts ?? 0;
  const maxAttempts = opts.maxAttempts ?? 3;
  const bpCmds = opts.backpressureCommands ?? ['bun test'];
  return [
    `# Unit ${id}: Test Unit ${id}`,
    '',
    `**Status:** ${status}`,
    `**Attempts:** ${attempts}`,
    `**Max Attempts:** ${maxAttempts}`,
    `**Depends On:** ${deps}`,
    '',
    '### Entropy', 'Low', '',
    '### Acceptance Criteria', '- AC-1: Test', '',
    '### Interface Contract', '```typescript\nfunction test(): void\n```', '',
    '### Test Stubs', '```typescript\ntest("works", () => {})\n```', '',
    '### What to Implement', 'Implement the thing.', '',
    '### Files to Touch', '- `src/test.ts` -- existing | modify', '',
    '### Backpressure',
    ...bpCmds.map(c => `- \`${c}\``),
    '',
    '### Done When', 'All backpressure commands pass.', '',
  ].join('\n');
}

/** Set up a project directory with plan file, state, and unit files. */
function setupProject(unitPlans: string[]): { projectDir: string; planPath: string; slug: string } {
  const projectDir = makeTmpDir();
  const slug = 'test-build';
  const planDir = path.join(projectDir, '.vcp', 'plan');
  const stateDir = path.join(planDir, '.state');
  const unitsDir = path.join(planDir, 'ralph', slug);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(unitsDir, { recursive: true });

  // Write plan file
  const planPath = path.join(planDir, `ralph-${slug}.md`);
  const unitTable = unitPlans.map((_, i) => `| ${i + 1} | Test Unit ${i + 1} | AC-1 | — | Low |`).join('\n');
  writeFileSync(planPath, [
    '# Test Feature',
    '**Status:** build',
    '## Discovery', 'Found things.',
    '## Requirements', '### AC-1: Test', '### UAT-1: Test',
    '## Units of Work',
    '| Unit | Title | ACs | Depends On | Entropy |',
    '|------|-------|-----|------------|---------|',
    unitTable,
  ].join('\n'));

  // Write unit files
  for (let i = 0; i < unitPlans.length; i++) {
    writeFileSync(path.join(unitsDir, `unit-${i + 1}.md`), unitPlans[i]);
  }

  // Write state file
  const state = {
    slug,
    status: 'build',
    outerIteration: 0,
    reviewIteration: 0,
    units: [],
    lastAction: 'next',
    lastTimestamp: new Date().toISOString(),
    taskIds: {},
  };
  writeFileSync(path.join(stateDir, `ralph-${slug}.json`), JSON.stringify(state, null, 2));

  return { projectDir, planPath, slug };
}

describe('runBuildLoop', () => {
  test('builds 2 units successfully and transitions to review', async () => {
    const { projectDir, planPath } = setupProject([
      makeUnitPlan(1),
      makeUnitPlan(2),
    ]);

    const result = await runBuildLoop(
      { planPath, cwd: projectDir },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Implemented.' }),
        backpressureFn: (cmds) => cmds.map(c => ({ command: c, exitCode: 0, stdout: '', stderr: '', passed: true })),
      },
    );

    expect(result.event).toBe('build_loop_complete');
    expect(result.units).toHaveLength(2);
    expect(result.units[0].outcome).toBe('done');
    expect(result.units[1].outcome).toBe('done');
    expect(result.taskOperations.some(op => op.ref === 'unit:1' && op.status === 'completed')).toBe(true);
    expect(result.taskOperations.some(op => op.ref === 'unit:2' && op.status === 'completed')).toBe(true);
  });

  test('fails unit after exhausting attempts', async () => {
    const { projectDir, planPath } = setupProject([
      makeUnitPlan(1, { maxAttempts: 2 }),
    ]);

    let callCount = 0;
    const result = await runBuildLoop(
      { planPath, cwd: projectDir },
      {
        dispatchFn: async () => {
          callCount++;
          return { event: 'complete', stage: 'ralph-build', synthesis: 'Implemented.' };
        },
        backpressureFn: () => [{ command: 'bun test', exitCode: 1, stdout: '', stderr: 'fail', passed: false }],
      },
    );

    // Should have attempted twice then the 3rd query sees it as failed
    expect(callCount).toBe(2);
    const failedUnit = result.units.find(u => u.outcome === 'failed');
    expect(failedUnit).toBeDefined();
    expect(failedUnit!.attempt).toBe(2);
  });

  test('treats zero backpressure commands as hard failure', async () => {
    const { projectDir, planPath } = setupProject([
      makeUnitPlan(1, { backpressureCommands: [], maxAttempts: 1 }),
    ]);

    const result = await runBuildLoop(
      { planPath, cwd: projectDir },
      {
        dispatchFn: async () => ({ event: 'complete', stage: 'ralph-build', synthesis: 'Done.' }),
        backpressureFn: () => [],
      },
    );

    // Unit should be failed, not done
    const unit = result.units.find(u => u.unitId === 1);
    expect(unit).toBeDefined();
    expect(unit!.outcome).toBe('failed');
  });

  test('handles dispatch failure gracefully', async () => {
    const { projectDir, planPath } = setupProject([
      makeUnitPlan(1, { maxAttempts: 1 }),
    ]);

    const result = await runBuildLoop(
      { planPath, cwd: projectDir },
      {
        dispatchFn: async () => ({
          event: 'error',
          stage: 'ralph-build',
          phase: 'dispatch_failed',
          error: 'stage-runner crashed',
        }),
        backpressureFn: () => [],
      },
    );

    const unit = result.units.find(u => u.unitId === 1);
    expect(unit).toBeDefined();
    expect(unit!.outcome).toBe('failed');
    expect(unit!.dispatch.event).toBe('error');
  });
});
