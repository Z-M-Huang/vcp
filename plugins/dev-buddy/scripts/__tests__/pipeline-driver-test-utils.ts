/**
 * Shared test infrastructure for pipeline-driver tests.
 *
 * These tests exercise the pipeline-driver CLI as an integration test.
 * All inputs to execSync are test-controlled constants (no untrusted data).
 */

import { expect } from 'bun:test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const DRIVER = path.resolve(__dirname, '../pipeline-driver.ts');
export const EXEC_CWD = path.resolve(__dirname, '../../../..'); // /app/vcp root

/** Mutable test context shared across test files. */
export const ctx = { testDir: '' };

export function setup(): void {
  ctx.testDir = fs.mkdtempSync(path.join('/tmp', 'pd-test-'));
}

export function teardown(): void {
  if (ctx.testDir && fs.existsSync(ctx.testDir)) {
    fs.rmSync(ctx.testDir, { recursive: true, force: true });
  }
}

/** Run a driver CLI command and parse JSON output. All args are test constants. */
export function run(args: string): any {
  const out = execSync(`bun "${DRIVER}" ${args}`, {
    encoding: 'utf-8',
    cwd: EXEC_CWD,
    timeout: 15000,
  }).trim();
  return JSON.parse(out);
}

/** Report a command result via the driver CLI. All args are test constants. */
export function report(cmdId: string, extra: Record<string, any> = {}): void {
  const rpt = { command_id: cmdId, ok: true, ...extra };
  const rptFile = path.join(ctx.testDir, 'rpt.json');
  fs.writeFileSync(rptFile, JSON.stringify(rpt));
  execSync(
    `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmdId}" --result-file "${rptFile}"`,
    { cwd: EXEC_CWD, timeout: 15000 },
  );
}

export function readState(): any {
  return JSON.parse(
    fs.readFileSync(path.join(ctx.testDir, '.vcp/task/pipeline-state.json'), 'utf-8'),
  );
}

export function readPipelineTasks(): any {
  return JSON.parse(
    fs.readFileSync(path.join(ctx.testDir, '.vcp/task/pipeline-tasks.json'), 'utf-8'),
  );
}

export function next(): any {
  return run(`next --cwd "${ctx.testDir}"`);
}

/**
 * Drive the pipeline from init through dependency wiring, returning the
 * final command (show_status after transition).
 */
export function driveToShowStatus(pipeline: 'feature' | 'bugfix' = 'feature'): any {
  // Init
  let cmd = run(`init --pipeline ${pipeline} --cwd "${ctx.testDir}"`);
  expect(cmd.action).toBe('create_team');

  // create_team → list_tasks
  report(cmd.command_id);
  cmd = next();
  expect(cmd.action).toBe('list_tasks');

  // list_tasks → first create_task
  report(cmd.command_id, { tasks: [] });
  cmd = next();
  expect(cmd.action).toBe('create_task');

  // Create all tasks
  let taskNum = 1;
  while (cmd.action === 'create_task') {
    report(cmd.command_id, { taskId: `task-${taskNum}` });
    cmd = next();
    taskNum++;
    if (taskNum > 25) throw new Error('Too many create_task commands');
  }

  // Wire dependencies
  let wireCount = 0;
  while (cmd.action === 'update_task' || cmd.action === 'noop') {
    report(cmd.command_id);
    cmd = next();
    wireCount++;
    if (wireCount > 35) throw new Error('Too many dependency wiring steps');
  }

  // Should be show_status
  expect(cmd.action).toBe('show_status');
  return cmd;
}
