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
 * Drive the pipeline from init to show_status.
 * Init now directly emits show_status (no task chain creation).
 * If descriptionFile is provided, passes --description-file to init.
 */
export function driveToShowStatusWithDescription(pipeline: 'feature' | 'bugfix', descriptionFile: string): any {
  return driveToShowStatus(pipeline, descriptionFile);
}

export function driveToShowStatus(pipeline: 'feature' | 'bugfix' = 'feature', descriptionFile?: string): any {
  const descFlag = descriptionFile ? ` --description-file "${descriptionFile}"` : '';
  const cmd = run(`init --pipeline ${pipeline} --cwd "${ctx.testDir}"${descFlag}`);
  expect(cmd.action).toBe('show_status');
  return cmd;
}

/**
 * Drive from init through the init phase transition (noop).
 * Returns the noop command. After reporting it, next() enters requirements or main_loop.
 */
export function driveToInitTransition(pipeline: 'feature' | 'bugfix' = 'feature', descriptionFile?: string): any {
  const showStatus = driveToShowStatus(pipeline, descriptionFile);
  report(showStatus.command_id);
  const cmd = next();
  expect(cmd.action).toBe('noop');
  return cmd;
}
