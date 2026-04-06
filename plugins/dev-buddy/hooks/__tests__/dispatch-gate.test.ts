import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const hookPath = path.resolve(__dirname, '../dispatch-gate.ts');
const tempProjects: string[] = [];
const tempOutputFiles: string[] = [];
let outputCounter = 0;

function createProject(status: string): { root: string; planPath: string; slug: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dispatch-gate-'));
  tempProjects.push(root);

  const planDir = path.join(root, '.vcp', 'plan');
  mkdirSync(path.join(planDir, '.dispatch'), { recursive: true });

  const slug = 'feature';
  const planPath = path.join(planDir, `ralph-${slug}.md`);
  writeFileSync(planPath, `# Ralph: Feature\n\n**Status:** ${status}\n`);

  return { root, planPath, slug };
}

function createPlanOnlyRoot(): { root: string; planDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dispatch-gate-'));
  tempProjects.push(root);

  const planDir = path.join(root, '.vcp', 'plan');
  mkdirSync(planDir, { recursive: true });

  return { root, planDir };
}

function writeProof(root: string, slug: string, proof: Record<string, unknown>): void {
  const proofPath = path.join(root, '.vcp', 'plan', '.dispatch', `${slug}-proof.json`);
  writeFileSync(proofPath, JSON.stringify(proof));
}

function createOutputFile(): string {
  outputCounter += 1;
  const outputId = `dispatch-gate-${process.pid}-${outputCounter}`;
  const outputDir = path.join(os.tmpdir(), '.vcp', 'oneshot');
  mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${outputId}.json`);
  writeFileSync(outputPath, JSON.stringify({ event: 'complete', result: 'ok' }));
  tempOutputFiles.push(outputPath);

  return outputId;
}

function runHook(payload: Record<string, unknown>): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env },
  });

  return {
    status: result.status,
    stderr: result.stderr || '',
    stdout: result.stdout || '',
  };
}

afterAll(() => {
  for (const root of tempProjects) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const outputPath of tempOutputFiles) {
    rmSync(outputPath, { force: true });
  }
});

describe('dispatch-gate hook', () => {
  test('blocks checkpoint-stage plan edits without proof', () => {
    const { planPath } = createProject('requirements');

    const result = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: planPath,
        old_string: 'before',
        new_string: 'after',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Executor dispatch required');
  });

  test('allows checkpoint-stage edits with matching proof and executor output file', () => {
    const { root, planPath, slug } = createProject('requirements');
    const outputId = createOutputFile();

    writeProof(root, slug, {
      stage: 'requirements',
      executor_type: 'api',
      output_ids: [outputId],
    });

    const result = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: planPath,
        old_string: 'before',
        new_string: 'after',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('blocks stale proof when proof stage mismatches plan status', () => {
    const { root, planPath, slug } = createProject('requirements');
    const outputId = createOutputFile();

    writeProof(root, slug, {
      stage: 'discover',
      executor_type: 'api',
      output_ids: [outputId],
    });

    const result = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: planPath,
        old_string: 'before',
        new_string: 'after',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Stale executor dispatch proof');
  });

  test('blocks non-subscription proof when no executor output files exist', () => {
    const { root, planPath, slug } = createProject('discover');

    writeProof(root, slug, {
      stage: 'discover',
      executor_type: 'mixed',
      output_ids: ['missing-output-id'],
    });

    const result = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: planPath,
        old_string: 'before',
        new_string: 'after',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No executor output files found');
  });

  test('allows subscription proofs without executor output files', () => {
    const { root, planPath, slug } = createProject('discover');

    writeProof(root, slug, {
      stage: 'discover',
      executor_type: 'subscription',
      output_ids: [],
    });

    const result = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: planPath,
        old_string: 'before',
        new_string: 'after',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('allows new plan creation writes without proof', () => {
    const { planDir } = createPlanOnlyRoot();
    const planPath = path.join(planDir, 'ralph-new-feature.md');

    const result = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: planPath,
        content: '# Ralph: New Feature\n\n**Status:** discover\n',
      },
    });

    expect(result.status).toBe(0);
  });

  test('allows non-checkpoint stage plan edits without proof', () => {
    const { planPath } = createProject('build');

    const result = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: planPath,
        old_string: 'before',
        new_string: 'after',
      },
    });

    expect(result.status).toBe(0);
  });

  test('allows non-plan file edits without proof', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dispatch-gate-'));
    tempProjects.push(root);

    const filePath = path.join(root, 'notes.md');
    writeFileSync(filePath, 'notes');

    const result = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: filePath,
        old_string: 'notes',
        new_string: 'updated notes',
      },
    });

    expect(result.status).toBe(0);
  });
});
