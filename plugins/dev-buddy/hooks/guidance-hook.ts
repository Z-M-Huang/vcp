#!/usr/bin/env bun
/**
 * Simplified Guidance Hook - Advisory Mode Orchestration
 *
 * This UserPromptSubmit hook provides guidance based on .vcp/task/*.json files.
 * State is implicit from which files exist.
 * Enforcement is handled by SubagentStop hook (review-validator.ts).
 *
 * Provides:
 * 1. Current phase detection from artifact files
 * 2. Advisory guidance for next task
 * 3. AC count reminder for reviews
 */

import fs from 'fs';
import path from 'path';
import {
  computeTaskDir,
  determinePhase,
  getProgress,
  discoverAnalysisFiles,
  type PhaseResult,
  type PipelineProgress,
} from '../scripts/pipeline-utils.ts';

// Get task directory from shared utility
export const TASK_DIR = computeTaskDir();

/**
 * Compute guidance message based on current progress
 */
export function computeGuidance(): { message: string; phase: string; isEmpty?: boolean; isComplete?: boolean } {
  // Check if .vcp/task directory exists
  if (!fs.existsSync(TASK_DIR)) {
    return {
      message: '',
      phase: 'idle',
      isEmpty: true
    };
  }

  const progress = getProgress(TASK_DIR);
  const { phase, message } = determinePhase(progress);
  const lines = [message];

  // Add AC reminder if user story exists with ACs
  // Multi-file manifest has ac_count (number); legacy single-file has acceptance_criteria (array)
  const acCount = (progress.userStory as Record<string, unknown> | null)?.ac_count as number | undefined
    ?? (Array.isArray(progress.userStory?.acceptance_criteria) ? (progress.userStory!.acceptance_criteria as unknown[]).length : 0);
  if (acCount > 0) {
    lines.push('');
    lines.push(`**Reminder**: ${acCount} acceptance criteria must be verified in all reviews.`);
    lines.push('Reviews MUST include acceptance_criteria_verification (code) or requirements_coverage (plan).');
  }

  return {
    message: lines.join('\n'),
    phase,
    isComplete: phase === 'complete'
  };
}

/**
 * Emit system message to stdout as JSON
 */
function emitSystemMessage(guidance: { message: string; phase: string }): void {
  let additionalContext = '';

  if (guidance && guidance.message) {
    additionalContext += guidance.message;
  }

  if (additionalContext) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext
      }
    }));
  }
}

/**
 * Main hook logic
 */
function main(): void {
  // Compute guidance based on current progress
  const guidance = computeGuidance();

  // Emit system message
  emitSystemMessage(guidance);

  // Always allow the prompt to proceed
  process.exit(0);
}

// Re-export for test compatibility
export { determinePhase, discoverAnalysisFiles };

// Import-safe guard - only run main() when executed directly
if (import.meta.main) {
  main();
}
