#!/usr/bin/env bun
/**
 * Pipeline orchestrator — human-readable CLI wrapper.
 *
 * Commands:
 *   bun orchestrator.ts run       Show current pipeline status (default)
 *   bun orchestrator.ts status    Show current pipeline status
 *   bun orchestrator.ts reset     Reset pipeline (remove all artifacts)
 *   bun orchestrator.ts dry-run   Validate setup without running
 *   bun orchestrator.ts phase     Output current phase token (for scripting/testing)
 *
 * Options:
 *   --cwd <dir>   Project directory (overrides CLAUDE_PROJECT_DIR / cwd)
 *
 * Pipeline logic lives in pipeline-driver.ts. This file provides the
 * human-friendly status display and the setup validation (dry-run).
 */

import fs from 'fs';
import path from 'path';
import {
  computeTaskDir,
  determinePhase,
  getProgress,
  getPipelineType,
} from './pipeline-utils.ts';

// ─── Parse args ─────────────────────────────────────────────────────

const positionalArgs: string[] = [];
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd') {
      const val = args[i + 1];
      if (!val || val.startsWith('-')) {
        console.error('Error: --cwd requires a directory path');
        process.exit(1);
      }
      process.env.CLAUDE_PROJECT_DIR = val;
      i++;
    } else {
      positionalArgs.push(args[i]);
    }
  }
}

// ─── Paths ──────────────────────────────────────────────────────────

const SCRIPT_DIR = import.meta.dir;
const PLUGIN_ROOT = path.dirname(SCRIPT_DIR);
const TASK_DIR = computeTaskDir();

// ─── ANSI colours ───────────────────────────────────────────────────

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const NC = '\x1b[0m';

function logInfo(msg: string): void { console.log(`${BLUE}[INFO]${NC} ${msg}`); }
function logSuccess(msg: string): void { console.log(`${GREEN}[SUCCESS]${NC} ${msg}`); }
function logWarn(msg: string): void { console.log(`${YELLOW}[WARN]${NC} ${msg}`); }
function logError(msg: string): void { console.error(`${RED}[ERROR]${NC} ${msg}`); }

// ─── Locking ────────────────────────────────────────────────────────

const LOCK_FILE = path.join(TASK_DIR, '.orchestrator.lock');

function getLockPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: unknown) { return (e as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

export function acquireLock(): boolean {
  const existingPid = getLockPid();
  if (existingPid !== null) {
    if (isPidAlive(existingPid)) {
      logError(`Another orchestrator is running (PID: ${existingPid})`);
      logError(`If this is incorrect, manually remove ${LOCK_FILE}`);
      return false;
    }
    logWarn(`Removing stale lock (PID ${existingPid} no longer exists)`);
    try { fs.unlinkSync(LOCK_FILE); } catch { /* already removed */ }
  }
  fs.mkdirSync(TASK_DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    logError('Failed to acquire lock (race condition)');
    return false;
  }
}

export function releaseLock(): void {
  if (getLockPid() === process.pid) {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* already removed */ }
  }
}

process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

// ─── Phase descriptions ─────────────────────────────────────────────

const PHASE_DESCRIPTIONS: Record<string, string> = {
  requirements_gathering: 'Requirements Gathering — use requirements-gatherer agent',
  requirements_team_pending: 'Requirements (Team Pending) — spawn specialist teammates',
  requirements_team_exploring: 'Requirements (Team Exploring) — specialists exploring in parallel',
  plan_drafting: 'Planning — create plan-refined.json',
  implementation: 'Implementation — use implementer agent',
  implementation_failed: 'STOPPED: implementation_failed — review impl-result.json',
  plan_rejected: 'STOPPED: plan_rejected — review feedback',
  code_rejected: 'STOPPED: code_rejected — review feedback',
  complete: 'Complete! All reviews approved.',
  idle: 'Unknown (old pipeline format) — reset to continue',
};

const PHASE_PREFIXES: Array<[string, string]> = [
  ['plan_review_', 'Plan Review'],
  ['code_review_', 'Code Review'],
  ['fix_plan_review_', 'Fix Plan — address reviewer feedback'],
  ['fix_code_review_', 'Fix Code — address reviewer feedback'],
  ['clarification_', 'Clarification Needed — answer reviewer questions'],
];

function showStatus(): void {
  if (!fs.existsSync(TASK_DIR)) {
    logInfo('No .vcp/task directory found. Pipeline not started.');
    console.log('\nTo start: /dev-buddy-feature-implement or /dev-buddy-bug-fix');
    return;
  }

  const progress = getProgress(TASK_DIR);
  const { phase } = determinePhase(progress);
  logInfo(`Current phase: ${phase}`);
  console.log('');

  // RCA phase needs special handling for sub-states
  if (phase === 'root_cause_analysis') {
    const rcaEntries = Object.entries(progress.stageOutputs).filter(([k]) => k.startsWith('rca-'));
    const done = rcaEntries.filter(([, v]) => v !== null).length;
    if (rcaEntries.length > 0 && done === rcaEntries.length) {
      console.log('Phase: RCA Consolidation — all analyses complete, consolidate findings');
    } else if (done > 0) {
      console.log('Phase: Root Cause Analysis (In Progress)');
      console.log(rcaEntries.map(([k, v]) => `${k}: ${v !== null ? 'complete' : 'running'}`).join(', '));
    } else {
      console.log('Phase: Root Cause Analysis (Pending)');
    }
    return;
  }

  // Plan drafting: bug-fix vs feature message
  if (phase === 'plan_drafting') {
    const pt = getPipelineType(progress.pipelineTasks);
    console.log(pt === 'bug-fix'
      ? 'Phase: Planning — consolidation incomplete, write plan from RCA findings'
      : 'Phase: Planning — use planner agent to create plan-refined.json');
    return;
  }

  // Plan review: bug-fix vs feature message
  if (phase.startsWith('plan_review_')) {
    const pt = getPipelineType(progress.pipelineTasks);
    console.log(pt === 'bug-fix'
      ? 'Phase: RCA + Plan Validation'
      : 'Phase: Plan Review');
    return;
  }

  // Static phase tokens
  const desc = PHASE_DESCRIPTIONS[phase];
  if (desc) {
    if (phase === 'complete') {
      logSuccess(desc);
      console.log(`\nTo reset: bun "${PLUGIN_ROOT}/scripts/orchestrator.ts" reset --cwd <dir>`);
    } else if (phase === 'implementation_failed' || phase === 'plan_rejected' || phase === 'code_rejected') {
      logError(desc);
    } else {
      console.log(`Phase: ${desc}`);
    }
    return;
  }

  // Dynamic phase tokens (prefix match)
  for (const [prefix, label] of PHASE_PREFIXES) {
    if (phase.startsWith(prefix)) {
      console.log(`Phase: ${label}`);
      return;
    }
  }

  console.log(`Phase: ${phase} — check .vcp/task/ files for pipeline state`);
}

// ─── Dry-run ────────────────────────────────────────────────────────

function runDryRun(): void {
  let errors = 0;
  let warnings = 0;
  console.log('Running dry-run validation...\n');

  function check(label: string, ok: boolean, severity: 'error' | 'warn' = 'error'): void {
    if (ok) { console.log(`${label}: OK`); return; }
    console.log(`${label}: ${severity === 'error' ? 'MISSING' : 'WARNING - not found'}`);
    if (severity === 'error') errors++; else warnings++;
  }

  check('Task directory', fs.existsSync(TASK_DIR));
  check('Scripts', ['orchestrator.ts', 'pipeline-driver.ts'].every(s => fs.existsSync(path.join(SCRIPT_DIR, s))));

  const skillsDir = path.join(PLUGIN_ROOT, 'skills');
  check('Skills', fs.existsSync(skillsDir) &&
    ['dev-buddy-feature-implement/SKILL.md', 'dev-buddy-bug-fix/SKILL.md']
      .every(s => fs.existsSync(path.join(skillsDir, s))));

  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  check('Agents', fs.existsSync(agentsDir) &&
    ['requirements-gatherer', 'planner', 'plan-reviewer', 'implementer', 'code-reviewer', 'cli-executor', 'root-cause-analyst', 'phased-reviewer']
      .every(a => fs.existsSync(path.join(agentsDir, `${a}.md`))));

  check('docs/review-guidelines.md', fs.existsSync(path.join(PLUGIN_ROOT, 'docs', 'review-guidelines.md')));
  check('docs/workflow.md', fs.existsSync(path.join(PLUGIN_ROOT, 'docs', 'workflow.md')));

  check('CLI bun', !!Bun.which('bun'));
  check('CLI claude', !!Bun.which('claude'), 'warn');
  check('CLI codex', !!Bun.which('codex'), 'warn');

  console.log('');
  if (errors === 0) {
    console.log(warnings > 0 ? `Dry run: PASSED (${warnings} warnings)` : 'Dry run: PASSED');
    process.exit(0);
  } else {
    console.log(`Dry run: FAILED (${errors} errors, ${warnings} warnings)`);
    process.exit(1);
  }
}

// ─── Reset ──────────────────────────────────────────────────────────

function resetPipeline(): void {
  if (!acquireLock()) {
    logError('Cannot reset while another orchestrator is running');
    process.exit(1);
  }
  logWarn('Resetting pipeline...');
  // Delete first while we hold the lock, then release
  fs.rmSync(TASK_DIR, { recursive: true, force: true });
  fs.mkdirSync(TASK_DIR, { recursive: true });
  releaseLock();
  logSuccess('Pipeline reset complete');
}

// ─── Entry Point ────────────────────────────────────────────────────

const command = positionalArgs[0] || 'run';

switch (command) {
  case 'run':
  case 'status':
    showStatus();
    break;
  case 'reset':
    resetPipeline();
    break;
  case 'dry-run':
  case '--dry-run':
    runDryRun();
    break;
  case 'phase': {
    if (!fs.existsSync(TASK_DIR)) { console.log('idle'); break; }
    const progress = getProgress(TASK_DIR);
    const { phase } = determinePhase(progress);
    console.log(phase);
    break;
  }
  default:
    console.log('Usage: bun orchestrator.ts {run|status|reset|dry-run|phase} [--cwd <dir>]');
    process.exit(1);
}
