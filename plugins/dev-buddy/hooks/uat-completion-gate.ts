#!/usr/bin/env bun
/**
 * UAT Completion Gate Hook — PreToolUse hook that blocks uat→done transitions
 * when any UAT definition lacks a PASS result.
 *
 * Intercepts Edit tool calls on ralph plan files. When an edit changes
 * **Status:** from uat to done, reads the plan file and verifies every
 * UAT-N defined in ## Requirements has a corresponding PASS in the last
 * ## UAT Results section.
 *
 * Fail-open: if input is unparseable, file is not a plan file, edit is not
 * a status transition, or any error occurs, the hook allows the action (exit 0).
 *
 * Exit codes:
 *   0 — allow
 *   2 — block (descriptive message on stderr)
 */

import { readFileSync } from 'fs';

function main(): void {
  try {
    // Read stdin JSON: { tool_name, tool_input }
    let input: { tool_name?: string; tool_input?: Record<string, unknown> };
    try {
      const stdin = readFileSync(0, 'utf-8');
      input = JSON.parse(stdin);
    } catch {
      process.exit(0); // Fail-open: unparseable input
    }

    const toolName = input.tool_name;
    if (toolName !== 'Edit' && toolName !== 'Write') {
      process.exit(0); // Only intercept Edit and Write calls
    }

    const toolInput = input.tool_input;
    if (!toolInput) {
      process.exit(0); // Fail-open
    }

    // Handle Write tool: check if overwriting a plan file with uat→done transition
    if (toolName === 'Write') {
      const filePath = toolInput.file_path as string | undefined;
      const newContent = toolInput.content as string | undefined;
      if (!filePath || !newContent) {
        process.exit(0); // Fail-open
      }
      if (!/[\\/]\.vcp[\\/]plan[\\/]ralph-.*\.md$/.test(filePath)) {
        process.exit(0);
      }
      // Check if new content sets status to done
      if (!/\*\*Status:\*\*\s*done/.test(newContent)) {
        process.exit(0);
      }
      // Read current file to check if transitioning from uat
      let currentContent: string;
      try {
        currentContent = readFileSync(filePath, 'utf-8');
      } catch {
        process.exit(0); // Fail-open: file doesn't exist yet
      }
      if (!/\*\*Status:\*\*\s*uat/.test(currentContent)) {
        process.exit(0);
      }
      // Verify UAT PASS results exist in the NEW content
      verifyUatResults(newContent, filePath);
      process.exit(0); // All UATs passed
    }

    // Handle Edit tool (existing logic)
    const filePath = toolInput.file_path as string | undefined;
    const oldString = toolInput.old_string as string | undefined;
    const newString = toolInput.new_string as string | undefined;

    if (!filePath || !oldString || !newString) {
      process.exit(0); // Fail-open
    }

    // Fast-path: only check plan files matching */.vcp/plan/ralph-*.md
    if (!/[\\/]\.vcp[\\/]plan[\\/]ralph-.*\.md$/.test(filePath)) {
      process.exit(0);
    }

    // Only check uat→done status transitions
    if (
      !/\*\*Status:\*\*\s*uat/.test(oldString) ||
      !/\*\*Status:\*\*\s*done/.test(newString)
    ) {
      process.exit(0);
    }

    // Read the plan file
    let planContent: string;
    try {
      planContent = readFileSync(filePath, 'utf-8');
    } catch {
      process.exit(0); // Fail-open: can't read plan file
    }

    // Verify UAT results in the plan file content
    verifyUatResults(planContent, filePath);

    process.exit(0); // All UATs passed
  } catch {
    process.exit(0); // Fail-open: unexpected error
  }
}

/**
 * Check that all defined UAT-N scenarios have a PASS result in the content.
 * Blocks (exit 2) if any UAT lacks a PASS result. Returns normally if all pass.
 */
function verifyUatResults(content: string, planFilePath: string): void {
  // Extract UAT definitions from ## Requirements section: ### UAT-{N}: {title}
  const definedUATs = new Set<string>();
  const uatDefRegex = /^### UAT-(\d+):/gm;
  let match: RegExpExecArray | null;
  while ((match = uatDefRegex.exec(content)) !== null) {
    definedUATs.add(match[1]);
  }

  if (definedUATs.size === 0) {
    return; // No UAT definitions found, allow
  }

  // Find the LAST ## UAT Results section and extract PASS entries
  const uatResultsSections = content.split(/^## UAT Results/gm);
  const lastResultsSection =
    uatResultsSections.length > 1
      ? uatResultsSections[uatResultsSections.length - 1]
      : '';

  const passedUATs = new Set<string>();
  const uatPassRegex = /^- UAT-(\d+):\s*PASS/gm;
  while ((match = uatPassRegex.exec(lastResultsSection)) !== null) {
    passedUATs.add(match[1]);
  }

  // Set difference: find defined UATs that are not in PASS set
  const missing: string[] = [];
  for (const uatId of definedUATs) {
    if (!passedUATs.has(uatId)) {
      missing.push(`UAT-${uatId}`);
    }
  }

  if (missing.length > 0) {
    missing.sort((a, b) => {
      const numA = parseInt(a.replace('UAT-', ''), 10);
      const numB = parseInt(b.replace('UAT-', ''), 10);
      return numA - numB;
    });
    process.stderr.write(
      `[uat-completion-gate] BLOCKED: Cannot transition to 'done' — ` +
        `the following UATs have not passed: ${missing.join(', ')}. ` +
        `Plan: ${planFilePath}\n`,
    );
    process.exit(2);
  }
}

main();
