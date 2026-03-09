/**
 * Pipeline driver — progress display helper.
 *
 * Builds a human-readable progress message from pipeline state.
 */

import type { PipelineState } from '../types/driver-state.ts';
import { deriveSubject, buildResolvedStageInfo } from './driver-state-io.ts';

export function buildProgressMessage(state: PipelineState): string {
  const completed = state.stages.filter(s => s.status === 'completed');
  const lines = [`Pipeline Progress: [${completed.length}/${state.stages.length} stages]`];
  let upcomingCount = 0;

  for (const s of state.stages) {
    const title = deriveSubject(buildResolvedStageInfo(s, state));
    if (s.status === 'completed') {
      lines.push(`  done: ${title}`);
    } else if (s.status === 'in_progress') {
      lines.push(`  current: ${title}`);
    } else if (upcomingCount < 5) {
      lines.push(`  pending: ${title}`);
      upcomingCount++;
    }
  }

  const totalPending = state.stages.filter(
    s => s.status !== 'completed' && s.status !== 'in_progress'
  ).length;
  if (totalPending > 5) lines.push(`  ... and ${totalPending - 5} more`);

  return lines.join('\n');
}
