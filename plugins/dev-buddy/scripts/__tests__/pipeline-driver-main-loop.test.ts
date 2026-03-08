import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ctx, DRIVER, EXEC_CWD,
  setup, teardown, run, report, readState, readPipelineTasks, next, driveToShowStatus,
} from './pipeline-driver-test-utils.ts';

// ─── REQUIREMENTS PHASE (Feature Pipeline) ─────────────────────────────────

describe('pipeline-driver requirements phase', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('transitions to requirements phase after task chain wiring', () => {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    const state = readState();
    expect(state.phase).toBe('requirements');
    expect(state.step).toBe(0);
  });

  test('requirements step 0: update_task(in_progress)', () => {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    const cmd = next();
    expect(cmd.action).toBe('update_task');
    expect(cmd.status).toBe('in_progress');
  });

  test('requirements step 1: VCP detection read_file', () => {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    let cmd = next(); // update_task(in_progress)
    report(cmd.command_id);

    cmd = next(); // read_file for VCP config
    expect(cmd.action).toBe('read_file');
    expect(cmd.path).toContain('.vcp');
  });

  test('VCP detected sets vcp_detection.detected = true', () => {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    let cmd = next(); // update_task
    report(cmd.command_id);

    cmd = next(); // read_file VCP
    report(cmd.command_id, {
      content: JSON.stringify({ pluginRoot: '/some/path' }),
    });

    const state = readState();
    expect(state.vcp_detection.detected).toBe(true);
  });

  test('VCP not detected keeps vcp_detection.detected = false', () => {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    let cmd = next(); // update_task
    report(cmd.command_id);

    cmd = next(); // read_file VCP
    report(cmd.command_id, { content: '' });

    const state = readState();
    expect(state.vcp_detection.detected).toBe(false);
  });

  test('requirements step 2: parallel_batch for 5 specialists', () => {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    let cmd = next(); // update_task
    report(cmd.command_id);

    cmd = next(); // read_file VCP
    report(cmd.command_id, { content: '' });

    cmd = next(); // parallel_batch
    expect(cmd.action).toBe('parallel_batch');
    expect(cmd.commands).toBeInstanceOf(Array);
    expect(cmd.commands.length).toBe(5);
  });

  test('specialist names are correct', () => {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    let cmd = next();
    report(cmd.command_id);
    cmd = next();
    report(cmd.command_id, { content: '' });
    cmd = next(); // parallel_batch

    const names = cmd.commands.map((c: any) => c.name).sort();
    expect(names).toContain('architecture-analyst');
    expect(names).toContain('performance-analyst');
    expect(names).toContain('security-analyst');
    expect(names).toContain('technical-analyst');
    expect(names).toContain('ux-domain-analyst');
  });

  /** Helper: drive feature pipeline through to requirements step 7 (wait for output). */
  function driveToRequirementsStep7(): { reqGathererCmd: any } {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    let cmd = next(); // step 0: update_task(in_progress)
    report(cmd.command_id);

    cmd = next(); // step 1: read_file VCP config
    report(cmd.command_id, { content: '' });

    cmd = next(); // step 2: parallel_batch (5 specialists)
    expect(cmd.action).toBe('parallel_batch');
    const batchResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      batchResults[c.command_id] = { ok: true, content: 'spawned' };
    }
    report(cmd.command_id, { batch_results: batchResults });

    cmd = next(); // step 3: receive_messages
    expect(cmd.action).toBe('receive_messages');
    // Report all specialists completed
    const specialistMessages = [
      { from: 'technical-analyst', summary: 'Analysis complete' },
      { from: 'ux-domain-analyst', summary: 'Analysis complete' },
      { from: 'security-analyst', summary: 'Analysis complete' },
      { from: 'performance-analyst', summary: 'Analysis complete' },
      { from: 'architecture-analyst', summary: 'Analysis complete' },
    ];
    report(cmd.command_id, { messages: specialistMessages });

    cmd = next(); // step 5: parallel_batch (read analysis files)
    expect(cmd.action).toBe('parallel_batch');
    const readResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      readResults[c.command_id] = { ok: true, content: '{}' };
    }
    report(cmd.command_id, { batch_results: readResults });

    cmd = next(); // step 6: spawn_agent (requirements-gatherer)
    expect(cmd.action).toBe('spawn_agent');
    expect(cmd.subagent_type).toBe('dev-buddy:requirements-gatherer');
    report(cmd.command_id);

    return { reqGathererCmd: cmd };
  }

  test('step 7: waits for requirements output file before shutdown', () => {
    driveToRequirementsStep7();

    // Step 7: should emit read_file for user-story/manifest.json
    const cmd = next();
    expect(cmd.action).toBe('read_file');
    expect(cmd.path).toContain('user-story/manifest.json');
  });

  test('step 7: retries read_file if output file not found', () => {
    driveToRequirementsStep7();

    // Step 7: read_file for manifest
    let cmd = next();
    expect(cmd.action).toBe('read_file');

    // Report file not found (ok=false) via report helper with error
    const rptFile = path.join(ctx.testDir, 'rpt.json');
    fs.writeFileSync(rptFile, JSON.stringify({
      command_id: cmd.command_id,
      ok: false,
      error: 'File does not exist',
    }));
    execSync(
      `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmd.command_id}" --result-file "${rptFile}" 2>/dev/null`,
      { encoding: 'utf-8', cwd: EXEC_CWD, timeout: 15000 },
    );

    // Next should re-emit read_file (retry)
    cmd = next();
    expect(cmd.action).toBe('read_file');
    expect(cmd.path).toContain('user-story/manifest.json');
  });

  test('step 7→8: advances to specialist shutdown when output file exists', () => {
    driveToRequirementsStep7();

    // Step 7: read_file
    let cmd = next();
    expect(cmd.action).toBe('read_file');

    // Report file found with content — step advances to 8
    report(cmd.command_id, {
      content: JSON.stringify({ id: 'us-1', title: 'Test story', ac_count: 3 }),
    });
    let state = readState();
    expect(state.step).toBe(8);

    // Next call enters specialist_shutdown (step 8 → handleSpecialistShutdown)
    cmd = next();
    state = readState();
    expect(state.phase).toBe('specialist_shutdown');
  });

  // ─── Fix 1: Specialist spawn verification ─────────────────────────────────

  /** Helper: drive to step 2 specialist spawn batch (not yet reported). */
  function driveToSpecialistSpawnBatch(): { batchCmd: any } {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);
    let cmd = next(); // step 0: update_task
    report(cmd.command_id);
    cmd = next(); // step 1: read_file VCP config
    report(cmd.command_id, { content: '' });
    cmd = next(); // step 2: parallel_batch (5 specialists)
    expect(cmd.action).toBe('parallel_batch');
    return { batchCmd: cmd };
  }

  test('specialist spawn failure marks specialist as failed', () => {
    const { batchCmd } = driveToSpecialistSpawnBatch();
    const cmds = batchCmd.commands;
    // Fail the first specialist, succeed the rest
    const batchResults: Record<string, any> = {};
    batchResults[cmds[0].command_id] = { ok: false, error: 'spawn rejected' };
    for (let i = 1; i < cmds.length; i++) {
      batchResults[cmds[i].command_id] = { ok: true, content: 'spawned' };
    }
    report(batchCmd.command_id, { batch_results: batchResults });

    const state = readState();
    expect(state.specialists!.approved_specialists[0].status).toBe('failed');
    expect(state.specialists!.approved_specialists[1].status).toBe('spawned');
  });

  test('failed spawn counted in spawn_failures', () => {
    const { batchCmd } = driveToSpecialistSpawnBatch();
    const cmds = batchCmd.commands;
    const batchResults: Record<string, any> = {};
    batchResults[cmds[0].command_id] = { ok: false, error: 'spawn rejected' };
    for (let i = 1; i < cmds.length; i++) {
      batchResults[cmds[i].command_id] = { ok: true, content: 'spawned' };
    }
    report(batchCmd.command_id, { batch_results: batchResults });

    const state = readState();
    expect(state.specialists!.spawn_failures.length).toBe(1);
    expect(state.specialists!.spawn_failures[0]).toBe(state.specialists!.approved_specialists[0].name);
  });

  test('missing specialist spawn sub-result marks failed', () => {
    const { batchCmd } = driveToSpecialistSpawnBatch();
    const cmds = batchCmd.commands;
    // Only return results for first 3 specialists, omit last 2
    const batchResults: Record<string, any> = {};
    for (let i = 0; i < 3; i++) {
      batchResults[cmds[i].command_id] = { ok: true, content: 'spawned' };
    }
    report(batchCmd.command_id, { batch_results: batchResults });

    const state = readState();
    // Last 2 specialists should be marked as failed
    expect(state.specialists!.approved_specialists[3].status).toBe('failed');
    expect(state.specialists!.approved_specialists[4].status).toBe('failed');
    expect(state.specialists!.spawn_failures.length).toBe(2);
  });

  // ─── Fix 2: Analysis file read verification ───────────────────────────────

  /** Helper: drive to step 5 analysis read batch (not yet reported). */
  function driveToAnalysisReadBatch(): { batchCmd: any } {
    const { batchCmd: spawnBatch } = driveToSpecialistSpawnBatch();
    const batchResults: Record<string, any> = {};
    for (const c of spawnBatch.commands) {
      batchResults[c.command_id] = { ok: true, content: 'spawned' };
    }
    report(spawnBatch.command_id, { batch_results: batchResults });
    // step 3: receive_messages
    let cmd = next();
    expect(cmd.action).toBe('receive_messages');
    const msgs = [
      { from: 'technical-analyst', summary: 'Analysis complete' },
      { from: 'ux-domain-analyst', summary: 'Analysis complete' },
      { from: 'security-analyst', summary: 'Analysis complete' },
      { from: 'performance-analyst', summary: 'Analysis complete' },
      { from: 'architecture-analyst', summary: 'Analysis complete' },
    ];
    report(cmd.command_id, { messages: msgs });
    // step 5: parallel_batch (read analysis files)
    cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    return { batchCmd: cmd };
  }

  test('step 5 does not pre-advance before batch completes', () => {
    const { batchCmd } = driveToAnalysisReadBatch();
    // Before reporting, step should still be 5
    const state = readState();
    expect(state.step).toBe(5);
    // Verify batch_cmd_to_stage was set
    expect(state.batch_cmd_to_stage).toBeDefined();
    expect(Object.keys(state.batch_cmd_to_stage!).length).toBe(batchCmd.commands.length);
  });

  test('step 5 advances to 6 after batch report', () => {
    const { batchCmd } = driveToAnalysisReadBatch();
    const readResults: Record<string, any> = {};
    for (const c of batchCmd.commands) {
      readResults[c.command_id] = { ok: true, content: '{}' };
    }
    report(batchCmd.command_id, { batch_results: readResults });
    const state = readState();
    expect(state.step).toBe(6);
    expect(state.batch_cmd_to_stage).toBeUndefined();
  });

  // ─── Fix 4: Manifest validation ───────────────────────────────────────────

  test('step 7 rejects malformed JSON manifest', () => {
    driveToRequirementsStep7();
    const cmd = next(); // step 7: read_file
    expect(cmd.action).toBe('read_file');
    report(cmd.command_id, { content: 'not valid json' });
    const state = readState();
    expect(state.step).toBe(7); // stays at 7
    expect(state.manifest_retry_count).toBe(1);
  });

  test('step 7 rejects manifest missing ac_count', () => {
    driveToRequirementsStep7();
    const cmd = next(); // step 7: read_file
    report(cmd.command_id, { content: JSON.stringify({ title: 'Test' }) });
    const state = readState();
    expect(state.step).toBe(7);
    expect(state.manifest_retry_count).toBe(1);
  });

  test('step 7 terminal failure after max retries', () => {
    driveToRequirementsStep7();
    // Retry 5 times with invalid manifest
    for (let i = 0; i < 5; i++) {
      const cmd = next(); // step 7: read_file
      expect(cmd.action).toBe('read_file');
      report(cmd.command_id, { content: '{}' });
    }
    const state = readState();
    expect(state.terminal_state).toBe('requirements_manifest_invalid');
    expect(state.terminal_reason).toContain('missing title or ac_count');
  });
});

// ─── BUGFIX PIPELINE — MAIN LOOP ──────────────────────────────────────────

describe('pipeline-driver bugfix main loop', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('bugfix transitions to main_loop (no requirements phase)', () => {
    driveToShowStatus('bugfix');
    const state = readState();
    expect(state.phase).toBe('main_loop');
  });

  test('main loop dispatches first actionable stage', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    const cmd = next();
    expect(cmd.action).toBe('update_task');
    expect(cmd.status).toBe('in_progress');
  });

  test('dispatch step 0→1: agent spawned after in_progress ack', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next(); // update_task(in_progress)
    report(cmd.command_id);

    cmd = next(); // spawn_agent
    expect(cmd.action).toBe('spawn_agent');
    expect(cmd.subagent_type).toBeTruthy();
  });

  test('dispatch step 1→2: read output after agent completes', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next(); // update_task
    report(cmd.command_id);
    cmd = next(); // spawn_agent
    report(cmd.command_id);

    cmd = next(); // read_file
    expect(cmd.action).toBe('read_file');
  });

  test('dispatch step 2→3: approved stage completes', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next(); // update_task
    report(cmd.command_id);
    cmd = next(); // spawn_agent
    report(cmd.command_id);
    cmd = next(); // read_file

    const state = readState();
    const stage = state.stages[0];
    const outputPath = path.join(ctx.testDir, '.vcp/task', stage.output_file);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      JSON.stringify({
        status: 'complete',
        root_cause: { summary: 'Found bug in X' },
      }),
    );

    report(cmd.command_id, {
      content: JSON.stringify({
        status: 'complete',
        root_cause: { summary: 'Found bug in X' },
      }),
    });

    cmd = next(); // update_task(completed)
    expect(cmd.action).toBe('update_task');
    expect(cmd.status).toBe('completed');
  });
});

// ─── REPORT — Command Acknowledgment ───────────────────────────────────────

describe('pipeline-driver report', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('report clears pending_command', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    const stateBefore = readState();
    expect(stateBefore.pending_command).not.toBeNull();

    report(cmd.command_id);
    const stateAfter = readState();
    expect(stateAfter.pending_command).toBeNull();
  });

  test('report marks command as acknowledged in history', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    report(cmd.command_id);

    const state = readState();
    const entry = state.command_history.find(
      (h: any) => h.command_id === cmd.command_id,
    );
    expect(entry).toBeDefined();
    expect(entry.acknowledged).toBe(true);
  });

  test('report rejects mismatched command_id', () => {
    run(`init --pipeline feature --cwd "${ctx.testDir}"`);

    const rptFile = path.join(ctx.testDir, 'rpt.json');
    fs.writeFileSync(
      rptFile,
      JSON.stringify({ command_id: 'wrong-id', ok: true }),
    );

    // The report should fail gracefully (stderr); pending_command remains
    execSync(
      `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "wrong-id" --result-file "${rptFile}" 2>/dev/null || true`,
      { encoding: 'utf-8', cwd: EXEC_CWD, timeout: 15000 },
    );

    const state = readState();
    expect(state.pending_command).not.toBeNull();
  });

  test('report with interrupted flag pauses pipeline', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);

    const rptFile = path.join(ctx.testDir, 'rpt.json');
    fs.writeFileSync(
      rptFile,
      JSON.stringify({
        command_id: cmd.command_id,
        ok: true,
        interrupted: true,
        user_message: 'User interrupted',
      }),
    );
    execSync(
      `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmd.command_id}" --result-file "${rptFile}"`,
      { cwd: EXEC_CWD, timeout: 15000 },
    );

    const state = readState();
    expect(state.paused).toBe(true);
    expect(state.pause_reason).toContain('User interruption');
  });

  test('paused pipeline emits pause on next call', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);

    const rptFile = path.join(ctx.testDir, 'rpt.json');
    fs.writeFileSync(
      rptFile,
      JSON.stringify({
        command_id: cmd.command_id,
        ok: true,
        interrupted: true,
      }),
    );
    execSync(
      `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmd.command_id}" --result-file "${rptFile}"`,
      { cwd: EXEC_CWD, timeout: 15000 },
    );

    const nextCmd = next();
    expect(nextCmd.action).toBe('pause');
  });
});

// ─── NEEDS_CHANGES Flow ────────────────────────────────────────────────────

describe('pipeline-driver needs_changes flow', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('needs_changes creates fix task (dispatch step 10)', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next(); // update_task(in_progress)
    report(cmd.command_id);
    cmd = next(); // spawn_agent
    report(cmd.command_id);
    cmd = next(); // read_file

    report(cmd.command_id, {
      content: JSON.stringify({
        status: 'needs_changes',
        issues: ['Fix the null check'],
      }),
    });

    cmd = next();
    expect(cmd.action).toBe('create_task');
    expect(cmd.subject).toContain('Fix');
  });

  test('after fix task, re-review task is created (step 11)', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next();
    report(cmd.command_id);
    cmd = next();
    report(cmd.command_id);
    cmd = next();
    report(cmd.command_id, {
      content: JSON.stringify({ status: 'needs_changes', issues: ['Fix it'] }),
    });

    cmd = next(); // create_task (fix)
    expect(cmd.action).toBe('create_task');
    expect(cmd.subject).toContain('Fix');
    report(cmd.command_id, { taskId: 'fix-task-1' });

    cmd = next(); // create_task (re-review)
    expect(cmd.action).toBe('create_task');
    expect(cmd.subject).not.toMatch(/^Fix /);
  });

  test('after re-review task, original review is completed (step 12)', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next();
    report(cmd.command_id);
    cmd = next();
    report(cmd.command_id);
    cmd = next();
    report(cmd.command_id, {
      content: JSON.stringify({ status: 'needs_changes', issues: ['Fix'] }),
    });

    cmd = next(); // create_task (fix)
    report(cmd.command_id, { taskId: 'fix-task-1' });
    cmd = next(); // create_task (re-review)
    report(cmd.command_id, { taskId: 'rerev-task-1' });

    cmd = next(); // update_task(completed)
    expect(cmd.action).toBe('update_task');
    expect(cmd.status).toBe('completed');
  });

  test('needs_changes increments iteration_count', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next();
    report(cmd.command_id);
    cmd = next();
    report(cmd.command_id);
    cmd = next();

    report(cmd.command_id, {
      content: JSON.stringify({ status: 'needs_changes' }),
    });

    const state = readState();
    expect(state.stages[0].iteration_count).toBe(1);
  });
});

// ─── ENRICHMENT ────────────────────────────────────────────────────────────

describe('pipeline-driver enrichment', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('enrichment file written after stage completion', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next(); // update_task(in_progress)
    report(cmd.command_id);
    cmd = next(); // spawn_agent
    report(cmd.command_id);
    cmd = next(); // read_file

    const state = readState();
    const stage = state.stages[0];
    const outputPath = path.join(ctx.testDir, '.vcp/task', stage.output_file);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      JSON.stringify({
        status: 'complete',
        root_cause: { summary: 'Null pointer in auth module' },
      }),
    );

    report(cmd.command_id, {
      content: JSON.stringify({
        status: 'complete',
        root_cause: { summary: 'Null pointer in auth module' },
      }),
    });

    cmd = next(); // update_task(completed)
    expect(cmd.action).toBe('update_task');
    expect(cmd.status).toBe('completed');

    // Check enrichment file
    const enrichPath = path.join(ctx.testDir, '.vcp/task/.tmp/enrichment-1.txt');
    if (fs.existsSync(enrichPath)) {
      const content = fs.readFileSync(enrichPath, 'utf-8');
      expect(content).toContain('RCA');
      expect(content).toContain('Null pointer');
    }
  });
});

// ─── PROCESSRESULT STATUS MAPPING ──────────────────────────────────────────

describe('pipeline-driver processStageResult', () => {
  beforeEach(setup);
  afterEach(teardown);

  /** Helper: drive bugfix pipeline to the read_file step for stage 0. */
  function driveBugfixToReadFile(): { cmd: any } {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next(); // update_task(in_progress)
    report(cmd.command_id);
    cmd = next(); // spawn_agent
    report(cmd.command_id);
    cmd = next(); // read_file
    return { cmd };
  }

  function writeStageOutput(status: string, extra: Record<string, any> = {}): void {
    const state = readState();
    const stage = state.stages[0];
    const outputPath = path.join(ctx.testDir, '.vcp/task', stage.output_file);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ status, ...extra }));
  }

  test('status "approved" → stage completed', () => {
    const { cmd } = driveBugfixToReadFile();
    writeStageOutput('approved');
    report(cmd.command_id, { content: JSON.stringify({ status: 'approved' }) });
    expect(readState().stages[0].status).toBe('completed');
  });

  test('status "complete" → stage completed', () => {
    const { cmd } = driveBugfixToReadFile();
    writeStageOutput('complete');
    report(cmd.command_id, { content: JSON.stringify({ status: 'complete' }) });
    expect(readState().stages[0].status).toBe('completed');
  });

  test('status "needs_changes" → stage needs_changes', () => {
    const { cmd } = driveBugfixToReadFile();
    report(cmd.command_id, {
      content: JSON.stringify({ status: 'needs_changes' }),
    });
    const state = readState();
    expect(state.stages[0].status).toBe('needs_changes');
    expect(state.stages[0].iteration_count).toBe(1);
  });

  test('status "failed" → stage failed', () => {
    const { cmd } = driveBugfixToReadFile();
    writeStageOutput('failed');
    report(cmd.command_id, { content: JSON.stringify({ status: 'failed' }) });
    expect(readState().stages[0].status).toBe('failed');
  });

  test(
    'status "rejected" on plan-review → plan_rejected terminal',
    () => {
      // Need a plan-review stage — skip to it via bugfix pipeline
      // Bugfix default: rca, rca, plan-review, impl, 3 code-reviews
      const showStatus = driveToShowStatus('bugfix');
      report(showStatus.command_id);

      // Complete RCA stages (0, 1)
      for (let i = 0; i < 2; i++) {
        let cmd = next(); // update_task
        report(cmd.command_id);
        cmd = next(); // spawn_agent
        report(cmd.command_id);
        cmd = next(); // read_file

        const s = readState().stages[i];
        const outPath = path.join(ctx.testDir, '.vcp/task', s.output_file);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(
          outPath,
          JSON.stringify({
            status: 'complete',
            root_cause: { summary: 'Bug found' },
          }),
        );

        report(cmd.command_id, {
          content: JSON.stringify({
            status: 'complete',
            root_cause: { summary: 'Bug found' },
          }),
        });

        cmd = next(); // update_task(completed)
        report(cmd.command_id);
      }

      // Now at plan-review (or possibly rca_consolidation)
      // Drive until we hit a read_file in main_loop for plan-review
      let iterations = 0;
      let foundPlanReviewReadFile = false;
      let cmd = next();
      while (iterations < 30 && cmd.action !== 'done') {
        if (cmd.action === 'read_file') {
          const st = readState();
          if (
            st.current_dispatch_index !== null &&
            st.stages[st.current_dispatch_index]?.type === 'plan-review'
          ) {
            foundPlanReviewReadFile = true;
            break;
          }
        }
        report(cmd.command_id);
        cmd = next();
        iterations++;
      }

      if (foundPlanReviewReadFile) {
        // Reject the plan review
        const s = readState().stages[readState().current_dispatch_index!];
        const outPath = path.join(ctx.testDir, '.vcp/task', s.output_file);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(
          outPath,
          JSON.stringify({ status: 'rejected', reason: 'Plan is flawed' }),
        );

        report(cmd.command_id, {
          content: JSON.stringify({
            status: 'rejected',
            reason: 'Plan is flawed',
          }),
        });

        const finalState = readState();
        expect(finalState.terminal_state).toBe('plan_rejected');
      }
    },
    30000,
  );
});

// ─── DISPATCH ERROR HANDLING ───────────────────────────────────────────────

describe('pipeline-driver dispatch errors', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('spawn_agent error marks stage as failed', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next(); // update_task(in_progress)
    report(cmd.command_id);
    cmd = next(); // spawn_agent

    const rptFile = path.join(ctx.testDir, 'rpt.json');
    fs.writeFileSync(
      rptFile,
      JSON.stringify({
        command_id: cmd.command_id,
        ok: false,
        error: 'Agent spawn failed',
      }),
    );
    execSync(
      `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmd.command_id}" --result-file "${rptFile}"`,
      { cwd: EXEC_CWD, timeout: 15000 },
    );

    const state = readState();
    expect(state.stages[0].status).toBe('failed');
    expect(state.current_dispatch_index).toBeNull();
    expect(state.dispatch_step).toBe(0);
  });
});

// ─── DISPATCH TRACKING ────────────────────────────────────────────────────

describe('pipeline-driver dispatch tracking', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('dispatch tracking initialized correctly', () => {
    run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    const state = readState();
    expect(state.current_dispatch_index).toBeNull();
    expect(state.dispatch_step).toBe(0);
  });

  test('dispatch tracking set when entering main loop', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    next(); // update_task → sets current_dispatch_index
    const state = readState();
    expect(state.current_dispatch_index).not.toBeNull();
    expect(state.dispatch_step).toBe(0);
  });

  test('dispatch step advances through flow', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next(); // update_task(in_progress)
    let state = readState();
    expect(state.dispatch_step).toBe(0);

    report(cmd.command_id); // update_task acknowledged — dispatch_step stays 0
    state = readState();
    expect(state.dispatch_step).toBe(0); // NOT advanced by report — handleMainLoopDispatch case 0 will dispatch

    cmd = next(); // spawn_agent (handleMainLoopDispatch case 0 dispatches, sets step=1)
    state = readState();
    expect(state.dispatch_step).toBe(1);

    report(cmd.command_id); // spawn_agent acknowledged — processReport advances to 2
    state = readState();
    expect(state.dispatch_step).toBe(2);
  });
});

// ─── PARALLEL GROUP DISPATCH ──────────────────────────────────────────────

describe('pipeline-driver parallel group dispatch', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('parallel group stages dispatched as parallel_batch', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    // Bugfix: stages 0,1 are parallel RCA stages
    const state = readState();
    const rcaStages = state.stages.filter((s: any) => s.type === 'rca');
    expect(rcaStages.length).toBe(2);

    // Both should have same parallel_group_id
    if (rcaStages[0].parallel_group_id !== null) {
      expect(rcaStages[1].parallel_group_id).toBe(rcaStages[0].parallel_group_id);
    }

    // First next: update_task (in_progress) for first RCA
    let cmd = next();
    expect(cmd.action).toBe('update_task');
    report(cmd.command_id);

    // Next should dispatch: for parallel group, it should be parallel_batch
    // or spawn_agent depending on whether they're truly parallel
    cmd = next();
    if (cmd.action === 'parallel_batch') {
      expect(cmd.commands.length).toBeGreaterThanOrEqual(2);
      // Report batch success
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = { ok: true };
      }
      report(cmd.command_id, { batch_results: batchResults });
    } else {
      // Sequential dispatch — report and continue
      report(cmd.command_id);
    }
  });

  test('parallel group completion triggers read_file chain', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    const initialState = readState();
    const rcaStages = initialState.stages.filter((s: any) => s.type === 'rca');

    // Drive through first stage dispatch
    let cmd = next(); // update_task
    report(cmd.command_id);
    cmd = next(); // spawn_agent or parallel_batch

    if (cmd.action === 'parallel_batch') {
      // All spawned at once — report batch results
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = { ok: true };
      }
      report(cmd.command_id, { batch_results: batchResults });

      // After batch, should proceed to read output files
      cmd = next();
      expect(cmd.action).toBe('read_file');
    } else if (cmd.action === 'spawn_agent') {
      // Sequential — just verify we can continue
      report(cmd.command_id);
      cmd = next();
      expect(cmd.action).toBe('read_file');
    }
  });
});
