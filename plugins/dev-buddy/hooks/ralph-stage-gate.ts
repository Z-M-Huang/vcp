#!/usr/bin/env bun
/**
 * Ralph Stage Gate Hook — PreToolUse hook that blocks out-of-sequence stage skills.
 *
 * Reads the most recent ralph-*.md master plan file (excluding unit files),
 * parses **Status:** {value}, and blocks Skill/Bash invocations that don't
 * match the current plan stage.
 *
 * Fail-open: if no plan file, no status, unparseable input, or non-dev-buddy
 * skill, the hook allows the action (exit 0).
 *
 * Exit codes:
 *   0 — allow
 *   2 — block (descriptive message on stderr)
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

// ================== STAGE MAPPINGS ==================

/** Map plan **Status:** value → allowed skill name */
const STATUS_TO_SKILL: Record<string, string> = {
  discover: 'dev-buddy-discover',
  requirements: 'dev-buddy-requirements',
  decompose: 'dev-buddy-decompose',
  build: 'dev-buddy-build',
  review: 'dev-buddy-code-review',
  uat: 'dev-buddy-uat',
};

/** Map plan **Status:** value → allowed --stage-type in Bash commands */
const STATUS_TO_STAGE_TYPE: Record<string, string> = {
  discover: 'discovery',
  requirements: 'ralph-requirements',
  decompose: 'decomposition',
  build: 'ralph-build',
  review: 'ralph-code-review',
  uat: 'ralph-uat',
};

/** Skills that are always allowed regardless of plan status */
const ALWAYS_ALLOWED_SKILLS = new Set([
  'dev-buddy-ralph',
  'dev-buddy-chatroom',
  'dev-buddy-once',
  'dev-buddy-config',
]);

// ================== PLAN RESOLUTION ==================

/**
 * Find the most recent ralph-*.md master plan file.
 * Unit plans live in ralph/{slug}/ subdirectories, so only master plans
 * (ralph-*.md) exist at the top level of .vcp/plan/.
 * Returns null if no plan found.
 */
function findMasterPlan(): string | null {
  const plansDir = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.vcp', 'plan');
  let entries: string[];
  try {
    entries = readdirSync(plansDir);
  } catch {
    return null; // plans dir doesn't exist
  }

  const masterPlans = entries
    .filter(f => /^ralph-.*\.md$/.test(f))
    .map(f => {
      const fullPath = path.join(plansDir, f);
      try {
        return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);

  return masterPlans.length > 0 ? masterPlans[0].path : null;
}

/** Extract **Status:** value from plan file content. Returns null if not found. */
function parseStatus(content: string): string | null {
  const match = content.match(/\*\*Status:\*\*\s*(\S+)/);
  return match ? match[1].toLowerCase() : null;
}

// ================== HOOK LOGIC ==================

function main(): void {
  // Read stdin JSON: { tool_name, tool_input }
  let input: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    const stdin = readFileSync(0, 'utf-8');
    input = JSON.parse(stdin);
  } catch {
    process.exit(0); // Fail-open: unparseable input
  }

  const toolName = input.tool_name;
  if (!toolName) {
    process.exit(0); // Fail-open
  }

  // Find and read master plan
  const planPath = findMasterPlan();
  if (!planPath) {
    process.exit(0); // Fail-open: no plan file
  }

  let planContent: string;
  try {
    planContent = readFileSync(planPath, 'utf-8');
  } catch {
    process.exit(0); // Fail-open: can't read plan
  }

  const status = parseStatus(planContent);
  if (!status) {
    process.exit(0); // Fail-open: no status in plan
  }

  // Status 'done' blocks all stage skills
  if (status === 'done') {
    if (toolName === 'Skill') {
      const skillName = (input.tool_input as any)?.skill as string | undefined;
      if (skillName?.startsWith('dev-buddy-') && !ALWAYS_ALLOWED_SKILLS.has(skillName)) {
        process.stderr.write(`[ralph-stage-gate] BLOCKED: Plan status is 'done'. No stage skills allowed. Plan: ${planPath}\n`);
        process.exit(2);
      }
    }
    // Allow non-dev-buddy skills and Bash when done
    process.exit(0);
  }

  // Handle Skill tool calls
  if (toolName === 'Skill') {
    const skillName = (input.tool_input as any)?.skill as string | undefined;
    if (!skillName) {
      process.exit(0); // Fail-open
    }

    // Non-dev-buddy skills are always allowed
    if (!skillName.startsWith('dev-buddy-')) {
      process.exit(0);
    }

    // Always-allowed dev-buddy skills
    if (ALWAYS_ALLOWED_SKILLS.has(skillName)) {
      process.exit(0);
    }

    // Check against status mapping
    const allowedSkill = STATUS_TO_SKILL[status];
    if (!allowedSkill) {
      process.exit(0); // Fail-open: unknown status
    }

    if (skillName !== allowedSkill) {
      process.stderr.write(
        `[ralph-stage-gate] BLOCKED: Skill '${skillName}' not allowed at plan status '${status}'. ` +
        `Expected: '${allowedSkill}'. Plan: ${planPath}\n`
      );
      process.exit(2);
    }

    // Precondition checks — verify previous stage produced expected artifacts
    const preconditionError = checkPreconditions(status, planContent, planPath);
    if (preconditionError) {
      process.stderr.write(preconditionError);
      process.exit(2);
    }

    process.exit(0); // Allowed
  }

  // Handle Bash tool calls — check for one-shot-runner/api-task-runner invocations
  if (toolName === 'Bash') {
    const command = (input.tool_input as any)?.command as string | undefined;
    if (!command) {
      process.exit(0); // Fail-open
    }

    // Only check commands that invoke our runners
    if (!command.includes('one-shot-runner') && !command.includes('api-task-runner')) {
      process.exit(0); // Allow all other Bash commands
    }

    // Extract --stage-type value from command
    const stageTypeMatch = command.match(/--stage-type\s+(\S+)/);
    if (!stageTypeMatch) {
      process.exit(0); // Fail-open: no --stage-type in command
    }

    const stageType = stageTypeMatch[1];
    const allowedStageType = STATUS_TO_STAGE_TYPE[status];
    if (!allowedStageType) {
      process.exit(0); // Fail-open: unknown status
    }

    if (stageType !== allowedStageType) {
      process.stderr.write(
        `[ralph-stage-gate] BLOCKED: --stage-type '${stageType}' not allowed at plan status '${status}'. ` +
        `Expected: '${allowedStageType}'. Plan: ${planPath}\n`
      );
      process.exit(2);
    }

    process.exit(0); // Allowed
  }

  // Other tool types: fail-open
  process.exit(0);
}

// ================== PRECONDITION CHECKS ==================

/** Extract slug from plan file path: ralph-{SLUG}.md → {SLUG} */
function extractSlug(planFilePath: string): string | null {
  const match = path.basename(planFilePath).match(/^ralph-(.+)\.md$/);
  return match ? match[1] : null;
}

/**
 * Check stage-specific preconditions beyond just plan status matching.
 * Returns an error message string if preconditions fail, null if all pass.
 */
function checkPreconditions(status: string, content: string, planFilePath: string): string | null {
  const prefix = '[ralph-stage-gate] BLOCKED:';

  switch (status) {
    case 'requirements':
      if (/## Discovery\n\(pending\)/.test(content)) {
        return `${prefix} Discovery section is still (pending). Complete /dev-buddy-discover first. Plan: ${planFilePath}\n`;
      }
      return null;

    case 'decompose':
      if (/## Requirements\n\(pending\)/.test(content)) {
        return `${prefix} Requirements section is still (pending). Complete /dev-buddy-requirements first. Plan: ${planFilePath}\n`;
      }
      if (!/### AC-\d+:/.test(content)) {
        return `${prefix} No acceptance criteria (AC-N) found in plan. Complete /dev-buddy-requirements first. Plan: ${planFilePath}\n`;
      }
      if (!/### UAT-\d+:/.test(content)) {
        return `${prefix} No UAT scenarios (UAT-N) found in plan. Complete /dev-buddy-requirements first. Plan: ${planFilePath}\n`;
      }
      return null;

    case 'build': {
      const slug = extractSlug(planFilePath);
      if (!slug) return null; // fail-open
      const unitsDir = path.join(path.dirname(planFilePath), 'ralph', slug);
      try {
        const units = readdirSync(unitsDir).filter(f => /^unit-\d+\.md$/.test(f));
        if (units.length === 0) {
          return `${prefix} No unit plan files found in ${unitsDir}. Complete /dev-buddy-decompose first. Plan: ${planFilePath}\n`;
        }
      } catch {
        return `${prefix} Unit plans directory not found: ${unitsDir}. Complete /dev-buddy-decompose first. Plan: ${planFilePath}\n`;
      }
      return null;
    }

    case 'review': {
      const slug = extractSlug(planFilePath);
      if (!slug) return null; // fail-open
      const unitsDir = path.join(path.dirname(planFilePath), 'ralph', slug);
      try {
        const unitFiles = readdirSync(unitsDir).filter(f => /^unit-\d+\.md$/.test(f));
        const notDone: string[] = [];
        for (const f of unitFiles) {
          const unitContent = readFileSync(path.join(unitsDir, f), 'utf-8');
          const unitStatus = parseStatus(unitContent);
          if (unitStatus !== 'done') {
            notDone.push(`${f}: ${unitStatus || 'unknown'}`);
          }
        }
        if (notDone.length > 0) {
          return `${prefix} Cannot start code review — ${notDone.length} unit(s) not done:\n` +
            notDone.map(u => `  - ${u}`).join('\n') + '\n' +
            `All units must have **Status:** done. Plan: ${planFilePath}\n`;
        }
      } catch {
        // fail-open: can't read units directory
      }
      return null;
    }

    case 'uat': {
      if (!/\*\*Verdict:\*\*\s*approved/i.test(content)) {
        return `${prefix} No code review approval found. Complete /dev-buddy-code-review first. Plan: ${planFilePath}\n`;
      }
      return null;
    }

    default:
      return null;
  }
}

main();
