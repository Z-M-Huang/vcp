#!/usr/bin/env bun
/**
 * Dispatch Gate Hook — PreToolUse hook that blocks Edit/Write on checkpoint-stage
 * Ralph plan files unless a matching dispatch proof exists.
 *
 * Fail-open: if input is unparseable, file is not a master plan, the plan cannot
 * be read, or the status is missing/unknown, the hook allows the action (exit 0).
 *
 * Exit codes:
 *   0 — allow
 *   2 — block (descriptive message on stderr)
 */

import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

const CHECKPOINT_STATUSES = new Set(['discover', 'requirements', 'decompose']);

/** Extract **Status:** value from plan file content. Returns null if not found. */
function parseStatus(content: string): string | null {
  const match = content.match(/\*\*Status:\*\*\s*(\S+)/);
  return match ? match[1].toLowerCase() : null;
}

/** Extract slug from plan file path: ralph-{SLUG}.md → {SLUG} */
function extractSlug(planFilePath: string): string | null {
  const match = path.basename(planFilePath).match(/^ralph-(.+)\.md$/);
  return match ? match[1] : null;
}

function hasExecutorOutput(outputIds: unknown): boolean {
  if (!Array.isArray(outputIds)) {
    return false;
  }

  const outputDir = path.join(os.tmpdir(), '.vcp', 'oneshot');
  return outputIds.some(id =>
    typeof id === 'string' &&
    id.length > 0 &&
    existsSync(path.join(outputDir, `${id}.json`))
  );
}

function block(message: string): never {
  process.stderr.write(`[dispatch-gate] BLOCKED: ${message}\n`);
  process.exit(2);
}

function main(): void {
  let input: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    const stdin = readFileSync(0, 'utf-8');
    input = JSON.parse(stdin);
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write') {
    process.exit(0);
  }

  const toolInput = input.tool_input;
  const filePath = toolInput?.file_path;
  if (typeof filePath !== 'string') {
    process.exit(0);
  }

  if (!/[\\/]\.vcp[\\/]plan[\\/]ralph-.*\.md$/.test(filePath)) {
    process.exit(0);
  }

  if (toolName === 'Write' && !existsSync(filePath)) {
    process.exit(0);
  }

  let planContent: string;
  try {
    planContent = readFileSync(filePath, 'utf-8');
  } catch {
    process.exit(0);
  }

  const status = parseStatus(planContent);
  if (!status || !CHECKPOINT_STATUSES.has(status)) {
    process.exit(0);
  }

  const slug = extractSlug(filePath);
  if (!slug) {
    process.exit(0);
  }

  const proofPath = path.join(path.dirname(filePath), '.dispatch', `${slug}-proof.json`);
  if (!existsSync(proofPath)) {
    block(`Executor dispatch required before modifying checkpoint-stage plan '${filePath}'. Missing proof: ${proofPath}`);
  }

  let proof: Record<string, unknown>;
  try {
    const raw = JSON.parse(readFileSync(proofPath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('proof must be a JSON object');
    }
    proof = raw as Record<string, unknown>;
  } catch {
    block(`Executor dispatch proof is invalid. Re-dispatch executors. Proof: ${proofPath}`);
  }

  const proofStage = typeof proof.stage === 'string' ? proof.stage.toLowerCase() : null;
  if (!proofStage) {
    block(`Executor dispatch proof is invalid (missing stage). Re-dispatch executors. Proof: ${proofPath}`);
  }

  if (proofStage !== status) {
    block(`Stale executor dispatch proof for stage '${proofStage}'. Current plan status is '${status}'. Re-dispatch executors. Proof: ${proofPath}`);
  }

  const executorType = typeof proof.executor_type === 'string' ? proof.executor_type.toLowerCase() : null;
  if (!executorType || !new Set(['subscription', 'api', 'mixed']).has(executorType)) {
    block(`Executor dispatch proof is invalid (bad executor_type). Re-dispatch executors. Proof: ${proofPath}`);
  }

  if (executorType !== 'subscription' && !hasExecutorOutput(proof.output_ids)) {
    block(`No executor output files found for proof '${proofPath}'. Re-dispatch executors before modifying '${filePath}'.`);
  }

  process.exit(0);
}

main();
