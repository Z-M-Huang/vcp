import { spawnSync } from 'child_process';
import type { BackpressureResult } from './types.ts';

/**
 * Run backpressure commands as child processes via spawnSync.
 * Each command runs sequentially in the given cwd.
 * Returns one BackpressureResult per command with passed=true iff exitCode===0.
 */
export function runBackpressure(commands: string[], cwd: string): BackpressureResult[] {
  const results: BackpressureResult[] = [];
  for (const command of commands) {
    const result = spawnSync('sh', ['-c', command], {
      cwd,
      encoding: 'utf-8',
      timeout: 600_000,
    });
    results.push({
      command,
      exitCode: result.status ?? 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      passed: result.status === 0,
    });
  }
  return results;
}
