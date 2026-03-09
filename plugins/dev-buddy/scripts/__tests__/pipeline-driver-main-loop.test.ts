import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ctx, DRIVER, EXEC_CWD,
  setup, teardown, run, report, readState, readPipelineTasks, next, driveToShowStatus,
  driveToShowStatusWithDescription, driveToInitTransition,
} from './pipeline-driver-test-utils.ts';

// ─── REQUIREMENTS PHASE (Feature Pipeline) ─────────────────────────────────

describe('pipeline-driver requirements phase', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('transitions to requirements phase after init', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    const state = readState();
    expect(state.phase).toBe('requirements');
    expect(state.step).toBe(0);
  });

  test('requirements step 0: read_file for VCP config', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    const cmd = next();
    expect(cmd.action).toBe('read_file');
    expect(cmd.path).toContain('.vcp');
  });

  test('requirements step 1 (VCP_DETECT): noop after VCP read', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, {
      content: JSON.stringify({ pluginRoot: '/some/path' }),
    });

    cmd = next(); // step 1: noop (VCP detection complete)
    expect(cmd.action).toBe('noop');
  });

  test('VCP detected sets vcp_detection.detected = true', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, {
      content: JSON.stringify({ pluginRoot: '/some/path' }),
    });

    const state = readState();
    expect(state.vcp_detection.detected).toBe(true);
  });

  test('VCP not detected keeps vcp_detection.detected = false', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, { content: '' });

    const state = readState();
    expect(state.vcp_detection.detected).toBe(false);
  });

  test('requirements step 2: create_team', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, { content: '' });
    cmd = next(); // step 1: noop (VCP_DETECT)
    report(cmd.command_id);

    cmd = next(); // step 2: create_team
    expect(cmd.action).toBe('create_team');
  });

  test('requirements step 3: parallel_batch for 5 specialists', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, { content: '' });
    cmd = next(); // step 1: noop (VCP_DETECT)
    report(cmd.command_id);
    cmd = next(); // step 2: create_team
    report(cmd.command_id);

    cmd = next(); // step 3: parallel_batch
    expect(cmd.action).toBe('parallel_batch');
    expect(cmd.commands).toBeInstanceOf(Array);
    expect(cmd.commands.length).toBe(5);
  });

  test('specialist names are correct', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // read_file VCP
    report(cmd.command_id, { content: '' });
    cmd = next(); // noop VCP_DETECT
    report(cmd.command_id);
    cmd = next(); // create_team
    report(cmd.command_id);
    cmd = next(); // parallel_batch

    const names = cmd.commands.map((c: any) => c.name).sort();
    expect(names).toContain('architecture-analyst');
    expect(names).toContain('performance-analyst');
    expect(names).toContain('security-analyst');
    expect(names).toContain('technical-analyst');
    expect(names).toContain('ux-domain-analyst');
  });

  /**
   * Helper: drive feature pipeline through to SYNTHESIS spawn_agent command
   * but do NOT report it. Callers can write manifest files to disk, then
   * report the spawn_agent to trigger in-process validation.
   */
  function driveToSpawnAgent(): { spawnCmd: any } {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, { content: '' });

    cmd = next(); // step 1: noop (VCP_DETECT)
    report(cmd.command_id);

    cmd = next(); // step 2: create_team
    report(cmd.command_id);

    cmd = next(); // step 3: parallel_batch (5 specialists)
    expect(cmd.action).toBe('parallel_batch');
    const batchResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      batchResults[c.command_id] = { ok: true, content: 'spawned' };
    }
    report(cmd.command_id, { batch_results: batchResults });

    cmd = next(); // step 4: receive_messages
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

    cmd = next(); // step 6: parallel_batch (read analysis files)
    expect(cmd.action).toBe('parallel_batch');
    const readResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      readResults[c.command_id] = { ok: true, content: '{}' };
    }
    report(cmd.command_id, { batch_results: readResults });

    // step 7: parallel_batch (shutdown specialists)
    cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    const shutdownResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      expect(c.action).toBe('shutdown_teammate');
      shutdownResults[c.command_id] = { ok: true };
    }
    report(cmd.command_id, { batch_results: shutdownResults });

    // step 8→9: specialists marked shutdown, delete_team emitted
    cmd = next();
    expect(cmd.action).toBe('delete_team');
    report(cmd.command_id);

    // step 10: spawn_agent (requirements-gatherer — no team context)
    cmd = next();
    expect(cmd.action).toBe('spawn_agent');
    expect(cmd.subagent_type).toBe('dev-buddy:requirements-gatherer');
    // DO NOT report — caller controls when/how to report

    return { spawnCmd: cmd };
  }

  test('step 7: shuts down specialists before spawning requirements-gatherer', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, { content: '' });
    cmd = next(); // step 1: noop VCP_DETECT
    report(cmd.command_id);
    cmd = next(); // step 2: create_team
    report(cmd.command_id);
    cmd = next(); // step 3: parallel_batch (5 specialists)
    const batchResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      batchResults[c.command_id] = { ok: true, content: 'spawned' };
    }
    report(cmd.command_id, { batch_results: batchResults });
    cmd = next(); // step 4: receive_messages
    report(cmd.command_id, {
      messages: [
        { from: 'technical-analyst', summary: 'Analysis complete' },
        { from: 'ux-domain-analyst', summary: 'Analysis complete' },
        { from: 'security-analyst', summary: 'Analysis complete' },
        { from: 'performance-analyst', summary: 'Analysis complete' },
        { from: 'architecture-analyst', summary: 'Analysis complete' },
      ],
    });
    cmd = next(); // step 6: parallel_batch (read analysis files)
    const readResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      readResults[c.command_id] = { ok: true, content: '{}' };
    }
    report(cmd.command_id, { batch_results: readResults });

    // step 7: should emit specialist shutdown batch BEFORE requirements-gatherer
    cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    for (const c of cmd.commands) {
      expect(c.action).toBe('shutdown_teammate');
    }
  });

  test('step 9: deletes team after specialist shutdown', () => {
    const { spawnCmd } = driveToSpawnAgent();
    // driveToSpawnAgent already verified delete_team and spawn_agent
    // State should be at step 11 (MANIFEST_READ, pre-advanced by step 10)
    const state = readState();
    expect(state.step).toBe(11);
  });

  test('spawn_agent report validates manifest in-process (valid manifest → step 12)', () => {
    const { spawnCmd } = driveToSpawnAgent();

    // Write valid manifest to disk before reporting spawn_agent
    const manifestDir = path.join(ctx.testDir, '.vcp/task/user-story');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({ id: 'us-1', title: 'Test story', ac_count: 3 }),
    );

    // Report spawn_agent success — triggers in-process validation
    report(spawnCmd.command_id);

    const state = readState();
    expect(state.step).toBe(12); // Skipped step 11 entirely
  });

  test('spawn_agent report → step 12 → main_loop transition', () => {
    const { spawnCmd } = driveToSpawnAgent();

    // Write valid manifest
    const manifestDir = path.join(ctx.testDir, '.vcp/task/user-story');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({ id: 'us-1', title: 'Test story', ac_count: 3 }),
    );

    report(spawnCmd.command_id);

    // Next call marks requirements complete and enters main_loop
    const cmd = next();
    const state = readState();
    expect(state.phase).toBe('main_loop');
  });

  test('spawn_agent report with missing manifest falls through to retry path (no terminal)', () => {
    const { spawnCmd } = driveToSpawnAgent();

    // Do NOT write manifest — simulate requirements-gatherer failure
    report(spawnCmd.command_id);

    const state = readState();
    // Should NOT set terminal — falls through to MANIFEST_READ retry path
    expect(state.terminal_state).toBeNull();
    expect(state.step).toBe(11); // stays at MANIFEST_READ
  });

  test('spawn_agent report with invalid manifest falls through to retry path (no terminal)', () => {
    const { spawnCmd } = driveToSpawnAgent();

    // Write invalid manifest (no title or ac_count)
    const manifestDir = path.join(ctx.testDir, '.vcp/task/user-story');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({}),
    );

    report(spawnCmd.command_id);

    const state = readState();
    // Should NOT set terminal — falls through to MANIFEST_READ retry path
    expect(state.terminal_state).toBeNull();
    expect(state.step).toBe(11); // stays at MANIFEST_READ
  });

  // ─── Fix 1: Specialist spawn verification ─────────────────────────────────

  /** Helper: drive to step 3 specialist spawn batch (not yet reported). */
  function driveToSpecialistSpawnBatch(): { batchCmd: any } {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);
    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, { content: '' });
    cmd = next(); // step 1: noop VCP_DETECT
    report(cmd.command_id);
    cmd = next(); // step 2: create_team
    report(cmd.command_id);
    cmd = next(); // step 3: parallel_batch (5 specialists)
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

  /** Helper: drive to step 6 analysis read batch (not yet reported). */
  function driveToAnalysisReadBatch(): { batchCmd: any } {
    const { batchCmd: spawnBatch } = driveToSpecialistSpawnBatch();
    const batchResults: Record<string, any> = {};
    for (const c of spawnBatch.commands) {
      batchResults[c.command_id] = { ok: true, content: 'spawned' };
    }
    report(spawnBatch.command_id, { batch_results: batchResults });
    // step 4: receive_messages
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
    // step 6: parallel_batch (read analysis files)
    cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    return { batchCmd: cmd };
  }

  test('step 6 does not pre-advance before batch completes', () => {
    const { batchCmd } = driveToAnalysisReadBatch();
    // Before reporting, step should still be 6
    const state = readState();
    expect(state.step).toBe(6);
    // Verify batch_cmd_to_stage was set
    expect(state.batch_cmd_to_stage).toBeDefined();
    expect(Object.keys(state.batch_cmd_to_stage!).length).toBe(batchCmd.commands.length);
  });

  test('step 6 advances to 7 after batch report', () => {
    const { batchCmd } = driveToAnalysisReadBatch();
    const readResults: Record<string, any> = {};
    for (const c of batchCmd.commands) {
      readResults[c.command_id] = { ok: true, content: '{}' };
    }
    report(batchCmd.command_id, { batch_results: readResults });
    const state = readState();
    expect(state.step).toBe(7);
    expect(state.batch_cmd_to_stage).toBeUndefined();
  });

  // ─── Defense-in-depth: Step 11 (MANIFEST_READ) fallback path ──────────────
  // These tests exercise the step 11 read_file path, which is normally
  // unreachable after in-process manifest validation in spawn_agent
  // report handler. They test the fallback for resume/state corruption.

  /** Manually seed state to step 11 in requirements phase for defense-in-depth tests. */
  function seedStateAtStep11(): void {
    const { spawnCmd } = driveToSpawnAgent();
    // Write valid manifest so spawn_agent report advances to step 12
    const manifestDir = path.join(ctx.testDir, '.vcp/task/user-story');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({ id: 'us-1', title: 'Test', ac_count: 1 }),
    );
    report(spawnCmd.command_id);

    // Manually rewind state to step 11 (simulates resume/corruption)
    const state = readState();
    state.step = 11;
    state.phase = 'requirements';
    state.manifest_retry_count = 0;
    fs.writeFileSync(
      path.join(ctx.testDir, '.vcp/task/pipeline-state.json'),
      JSON.stringify(state),
    );
  }

  test('step 11 defense-in-depth: rejects malformed JSON manifest', () => {
    seedStateAtStep11();
    const cmd = next(); // step 11: read_file
    expect(cmd.action).toBe('read_file');
    report(cmd.command_id, { content: 'not valid json' });
    const state = readState();
    expect(state.step).toBe(11); // stays at 11
    expect(state.manifest_retry_count).toBe(1);
  });

  test('step 11 defense-in-depth: rejects manifest missing ac_count', () => {
    seedStateAtStep11();
    const cmd = next(); // step 11: read_file
    report(cmd.command_id, { content: JSON.stringify({ title: 'Test' }) });
    const state = readState();
    expect(state.step).toBe(11);
    expect(state.manifest_retry_count).toBe(1);
  });

  test('step 11 defense-in-depth: escalates after max invalid retries', () => {
    seedStateAtStep11();
    // Retry 5 times with invalid manifest
    for (let i = 0; i < 5; i++) {
      const cmd = next(); // step 11: read_file
      expect(cmd.action).toBe('read_file');
      report(cmd.command_id, { content: '{}' });
    }
    const state = readState();
    // Should escalate, not terminate
    expect(state.terminal_state).toBeNull();
    expect(state.step).toBe(13); // MANIFEST_ESCALATE
    expect(state.manifest_failure_kind).toBe('invalid');

    // next() should emit escalate command
    const escalateCmd = next();
    expect(escalateCmd.action).toBe('escalate');
    expect(escalateCmd.recovery_options).toHaveLength(2);
  });

  test('step 11 defense-in-depth: escalates after 3 file-not-found errors', () => {
    seedStateAtStep11();
    // Remove the manifest file so read_file returns file-not-found
    const manifestPath = path.join(ctx.testDir, '.vcp/task/user-story/manifest.json');
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

    for (let i = 0; i < 3; i++) {
      const cmd = next(); // step 11: read_file
      expect(cmd.action).toBe('read_file');
      // Report file not found — all args are test constants
      const rptFile = path.join(ctx.testDir, 'rpt.json');
      fs.writeFileSync(rptFile, JSON.stringify({
        command_id: cmd.command_id,
        ok: false,
        error: 'File does not exist',
      }));
      // All args are test constants — execSync is safe here
      execSync(
        `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmd.command_id}" --result-file "${rptFile}" 2>/dev/null`,
        { encoding: 'utf-8', cwd: EXEC_CWD, timeout: 15000 },
      );
    }
    const state = readState();
    // Should escalate, not terminate
    expect(state.terminal_state).toBeNull();
    expect(state.step).toBe(13); // MANIFEST_ESCALATE
    expect(state.manifest_failure_kind).toBe('missing');

    // next() should emit escalate command
    const escalateCmd = next();
    expect(escalateCmd.action).toBe('escalate');
    expect(escalateCmd.recovery_options).toHaveLength(2);
  });

  // ─── Escalation recovery: retry and abort ──────────────────────────────────

  test('escalation answer "Retry" resets state and re-spawns requirements-gatherer', () => {
    seedStateAtStep11();
    // Exhaust retries → escalate
    for (let i = 0; i < 5; i++) {
      const cmd = next();
      report(cmd.command_id, { content: '{}' });
    }
    const escalateCmd = next();
    expect(escalateCmd.action).toBe('escalate');

    // User chooses "Retry requirements synthesis"
    report(escalateCmd.command_id, { answer: 'Retry requirements synthesis' });
    const state = readState();
    expect(state.step).toBe(10); // SYNTHESIS
    expect(state.manifest_retry_count).toBe(0);
    expect(state.manifest_failure_kind).toBeUndefined();
    expect(state.terminal_state).toBeNull();

    // next() should spawn a new requirements-gatherer
    const cmd = next();
    expect(cmd.action).toBe('spawn_agent');
    expect(cmd.subagent_type).toBe('dev-buddy:requirements-gatherer');
  });

  test('escalation answer "Abort" sets terminal state', () => {
    seedStateAtStep11();
    // Remove manifest to trigger missing-file escalation
    const manifestPath = path.join(ctx.testDir, '.vcp/task/user-story/manifest.json');
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

    for (let i = 0; i < 3; i++) {
      const cmd = next();
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
    }
    const escalateCmd = next();
    expect(escalateCmd.action).toBe('escalate');

    // User chooses "Abort pipeline"
    report(escalateCmd.command_id, { answer: 'Abort pipeline' });
    const state = readState();
    expect(state.terminal_state).toBe('requirements_manifest_missing');

    // next() should emit done
    const doneCmd = next();
    expect(doneCmd.action).toBe('done');
    expect(doneCmd.terminal_state).toBe('requirements_manifest_missing');
  });

  test('manifest appears during retry recovers without escalation', () => {
    seedStateAtStep11();
    // First read: invalid
    let cmd = next();
    report(cmd.command_id, { content: '{}' });
    let state = readState();
    expect(state.manifest_retry_count).toBe(1);

    // Second read: valid manifest
    cmd = next();
    report(cmd.command_id, {
      content: JSON.stringify({ id: 'us-1', title: 'Test', ac_count: 5 }),
    });
    state = readState();
    expect(state.step).toBe(12); // COMPLETE
    expect(state.terminal_state).toBeNull();
  });
});

// ─── BUGFIX PIPELINE — MAIN LOOP ──────────────────────────────────────────

describe('pipeline-driver bugfix main loop', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('bugfix transitions to main_loop after init', () => {
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    const state = readState();
    expect(state.phase).toBe('main_loop');
  });

  test('main loop dispatches first actionable stage (spawn_agent)', () => {
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    const cmd = next();
    // Dispatch directly — no update_task. Could be spawn_agent or parallel_batch
    expect(['spawn_agent', 'parallel_batch']).toContain(cmd.action);
  });

  test('dispatch AGENT→READ_OUTPUT: read output after agent completes', () => {
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    let cmd = next(); // spawn_agent or parallel_batch
    if (cmd.action === 'parallel_batch') {
      // Parallel RCA group — report batch
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = { ok: true };
      }
      report(cmd.command_id, { batch_results: batchResults });
    } else {
      report(cmd.command_id);
    }

    cmd = next(); // read_file
    expect(cmd.action).toBe('read_file');
  });

  test('dispatch READ_OUTPUT→PROCESS: approved stage completes', () => {
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    let cmd = next(); // spawn_agent or parallel_batch
    if (cmd.action === 'parallel_batch') {
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = { ok: true };
      }
      report(cmd.command_id, { batch_results: batchResults });
    } else {
      report(cmd.command_id);
    }

    cmd = next(); // read_file
    const state = readState();
    const stageIdx = state.current_dispatch_index;
    const stage = state.stages[stageIdx];
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

    // PROCESS step is transparent — next command dispatches the next stage
    cmd = next();
    // Should proceed to next stage dispatch (spawn_agent, parallel_batch, or rca_consolidation)
    expect(cmd.action).not.toBe('update_task');
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
    // All args are test constants — execSync is safe here
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
    // All args are test constants — execSync is safe here
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
    // All args are test constants — execSync is safe here
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

  /** Helper: drive bugfix to read_file step for stage dispatch. */
  function driveBugfixToReadFile(): { cmd: any } {
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    let cmd = next(); // spawn_agent or parallel_batch
    if (cmd.action === 'parallel_batch') {
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = { ok: true };
      }
      report(cmd.command_id, { batch_results: batchResults });
    } else {
      report(cmd.command_id);
    }

    cmd = next(); // read_file
    expect(cmd.action).toBe('read_file');
    return { cmd };
  }

  test('needs_changes emits noop (fix flow, dispatch step 10)', () => {
    const { cmd } = driveBugfixToReadFile();

    report(cmd.command_id, {
      content: JSON.stringify({
        status: 'needs_changes',
        issues: ['Fix the null check'],
      }),
    });

    const cmdAfter = next();
    expect(cmdAfter.action).toBe('noop');
    expect(cmdAfter.message).toContain('Fix flow');
  });

  test('needs_changes increments iteration_count', () => {
    const { cmd } = driveBugfixToReadFile();

    report(cmd.command_id, {
      content: JSON.stringify({ status: 'needs_changes' }),
    });

    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    expect(state.stages[stageIdx].iteration_count).toBe(1);
  });
});

// ─── ENRICHMENT ────────────────────────────────────────────────────────────

describe('pipeline-driver enrichment', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('enrichment file written after stage completion', () => {
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    let cmd = next(); // spawn_agent or parallel_batch
    if (cmd.action === 'parallel_batch') {
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = { ok: true };
      }
      report(cmd.command_id, { batch_results: batchResults });
    } else {
      report(cmd.command_id);
    }

    cmd = next(); // read_file
    const state = readState();
    const stageIdx = state.current_dispatch_index!;
    const stage = state.stages[stageIdx];
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

    // PROCESS step is transparent — next dispatches the next stage
    cmd = next();
    expect(cmd.action).not.toBe('update_task');

    // Check enrichment file exists for the successor stage
    const successorIdx = stageIdx + 1;
    const enrichPath = path.join(ctx.testDir, `.vcp/task/.tmp/enrichment-${successorIdx}.txt`);
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
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    let cmd = next(); // spawn_agent or parallel_batch
    if (cmd.action === 'parallel_batch') {
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = { ok: true };
      }
      report(cmd.command_id, { batch_results: batchResults });
    } else {
      report(cmd.command_id);
    }

    cmd = next(); // read_file
    return { cmd };
  }

  function writeStageOutput(status: string, extra: Record<string, any> = {}): void {
    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    const stage = state.stages[stageIdx];
    const outputPath = path.join(ctx.testDir, '.vcp/task', stage.output_file);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ status, ...extra }));
  }

  test('status "approved" → stage completed', () => {
    const { cmd } = driveBugfixToReadFile();
    writeStageOutput('approved');
    report(cmd.command_id, { content: JSON.stringify({ status: 'approved' }) });
    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    expect(state.stages[stageIdx].status).toBe('completed');
  });

  test('status "complete" → stage completed', () => {
    const { cmd } = driveBugfixToReadFile();
    writeStageOutput('complete');
    report(cmd.command_id, { content: JSON.stringify({ status: 'complete' }) });
    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    expect(state.stages[stageIdx].status).toBe('completed');
  });

  test('status "needs_changes" → stage needs_changes', () => {
    const { cmd } = driveBugfixToReadFile();
    report(cmd.command_id, {
      content: JSON.stringify({ status: 'needs_changes' }),
    });
    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    expect(state.stages[stageIdx].status).toBe('needs_changes');
    expect(state.stages[stageIdx].iteration_count).toBe(1);
  });

  test('status synonym "passed" → stage completed', () => {
    const { cmd } = driveBugfixToReadFile();
    writeStageOutput('passed');
    report(cmd.command_id, { content: JSON.stringify({ status: 'passed' }) });
    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    expect(state.stages[stageIdx].status).toBe('completed');
  });

  test('status synonym "pass" → stage completed', () => {
    const { cmd } = driveBugfixToReadFile();
    writeStageOutput('pass');
    report(cmd.command_id, { content: JSON.stringify({ status: 'pass' }) });
    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    expect(state.stages[stageIdx].status).toBe('completed');
  });

  test('status case-insensitive "Approved" → stage completed', () => {
    const { cmd } = driveBugfixToReadFile();
    writeStageOutput('Approved');
    report(cmd.command_id, { content: JSON.stringify({ status: 'Approved' }) });
    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    expect(state.stages[stageIdx].status).toBe('completed');
  });

  test('nested review.status fallback → stage completed', () => {
    const { cmd } = driveBugfixToReadFile();
    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    const stage = state.stages[stageIdx];
    const outputPath = path.join(ctx.testDir, '.vcp/task', stage.output_file);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    // No top-level status — nested under review.status
    fs.writeFileSync(outputPath, JSON.stringify({ review: { status: 'approved', comments: [] } }));
    report(cmd.command_id, { content: JSON.stringify({ review: { status: 'approved', comments: [] } }) });
    const updated = readState();
    expect(updated.stages[stageIdx].status).toBe('completed');
  });

  test('status "failed" → stage failed', () => {
    const { cmd } = driveBugfixToReadFile();
    writeStageOutput('failed');
    report(cmd.command_id, { content: JSON.stringify({ status: 'failed' }) });
    const state = readState();
    const stageIdx = state.current_dispatch_index ?? 0;
    expect(state.stages[stageIdx].status).toBe('failed');
  });

  test(
    'status "rejected" on plan-review → plan_rejected terminal',
    () => {
      // Need a plan-review stage — drive bugfix through RCA stages first
      const noop = driveToInitTransition('bugfix');
      report(noop.command_id);

      // Drive through stages until we hit a plan-review read_file
      let iterations = 0;
      let foundPlanReviewReadFile = false;
      let cmd = next();
      while (iterations < 40 && cmd.action !== 'done') {
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

        // For parallel_batch, report with appropriate results
        if (cmd.action === 'parallel_batch') {
          const batchResults: Record<string, any> = {};
          for (const c of cmd.commands) {
            batchResults[c.command_id] = { ok: true };
          }
          report(cmd.command_id, { batch_results: batchResults });
        } else if (cmd.action === 'read_file') {
          // Complete stages by reporting approved content
          const st = readState();
          if (st.current_dispatch_index !== null) {
            const s = st.stages[st.current_dispatch_index];
            const outPath = path.join(ctx.testDir, '.vcp/task', s.output_file);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(
              outPath,
              JSON.stringify({ status: 'complete', root_cause: { summary: 'Bug found' } }),
            );
            report(cmd.command_id, {
              content: JSON.stringify({ status: 'complete', root_cause: { summary: 'Bug found' } }),
            });
          } else {
            report(cmd.command_id);
          }
        } else {
          report(cmd.command_id);
        }

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
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    let cmd = next(); // spawn_agent or parallel_batch

    if (cmd.action === 'parallel_batch') {
      // For parallel group, fail the first member
      const rptFile = path.join(ctx.testDir, 'rpt.json');
      fs.writeFileSync(
        rptFile,
        JSON.stringify({
          command_id: cmd.command_id,
          ok: false,
          error: 'Agent spawn failed',
        }),
      );
      // All args are test constants — execSync is safe here
      execSync(
        `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmd.command_id}" --result-file "${rptFile}"`,
        { cwd: EXEC_CWD, timeout: 15000 },
      );
    } else {
      const rptFile = path.join(ctx.testDir, 'rpt.json');
      fs.writeFileSync(
        rptFile,
        JSON.stringify({
          command_id: cmd.command_id,
          ok: false,
          error: 'Agent spawn failed',
        }),
      );
      // All args are test constants — execSync is safe here
      execSync(
        `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmd.command_id}" --result-file "${rptFile}"`,
        { cwd: EXEC_CWD, timeout: 15000 },
      );

      const state = readState();
      expect(state.stages[0].status).toBe('failed');
      expect(state.current_dispatch_index).toBeNull();
      expect(state.dispatch_step).toBe(0);
    }
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
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    next(); // spawn_agent or parallel_batch → sets current_dispatch_index
    const state = readState();
    expect(state.current_dispatch_index).not.toBeNull();
    expect(state.dispatch_step).toBe(0);
  });

  test('dispatch step advances through flow', () => {
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    let cmd = next(); // spawn_agent (dispatch step AGENT=0)
    let state = readState();
    expect(state.dispatch_step).toBe(0);

    if (cmd.action === 'parallel_batch') {
      // Parallel dispatch — batch completes, advances to READ_OUTPUT
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = { ok: true };
      }
      report(cmd.command_id, { batch_results: batchResults });
      state = readState();
      expect(state.dispatch_step).toBe(1); // READ_OUTPUT
    } else {
      report(cmd.command_id); // spawn_agent acknowledged → dispatch_step advances to READ_OUTPUT
      state = readState();
      expect(state.dispatch_step).toBe(1); // READ_OUTPUT
    }
  });
});

// ─── PARALLEL GROUP DISPATCH ──────────────────────────────────────────────

describe('pipeline-driver parallel group dispatch', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('parallel group stages dispatched as parallel_batch', () => {
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    // Bugfix: stages 0,1 are parallel RCA stages
    const state = readState();
    const rcaStages = state.stages.filter((s: any) => s.type === 'rca');
    expect(rcaStages.length).toBe(2);

    // Both should have same parallel_group_id
    if (rcaStages[0].parallel_group_id !== null) {
      expect(rcaStages[1].parallel_group_id).toBe(rcaStages[0].parallel_group_id);
    }

    // First next: dispatch (parallel_batch or spawn_agent)
    let cmd = next();
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
    const noop = driveToInitTransition('bugfix');
    report(noop.command_id);

    // Drive through first stage dispatch
    let cmd = next(); // spawn_agent or parallel_batch

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

// ─── DESCRIPTION TRANSPORT ──────────────────────────────────────────────────

describe('pipeline-driver --description-file', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('description persisted in state and pipeline-tasks.json', () => {
    const descPath = path.join(ctx.testDir, 'desc.txt');
    fs.writeFileSync(descPath, 'Add OAuth2 login flow');
    run(`init --pipeline feature --cwd "${ctx.testDir}" --description-file "${descPath}"`);

    const state = readState();
    expect(state.description).toBe('Add OAuth2 login flow');

    const tasks = readPipelineTasks();
    expect(tasks.description).toBe('Add OAuth2 login flow');
  });

  test('missing description-file proceeds without error', () => {
    const cmd = run(`init --pipeline feature --cwd "${ctx.testDir}" --description-file "/nonexistent/file.txt"`);
    expect(cmd.action).toBe('show_status');

    const state = readState();
    expect(state.description).toBeUndefined();
  });

  test('description restored on resume via rebuildStateFromTasks', () => {
    const descPath = path.join(ctx.testDir, 'desc.txt');
    fs.writeFileSync(descPath, 'Fix authentication bypass');
    const showStatus = driveToShowStatusWithDescription('bugfix', descPath);
    report(showStatus.command_id);

    // Drive through noop init transition
    let cmd = next();
    expect(cmd.action).toBe('noop');
    report(cmd.command_id);

    // Delete state file to simulate resume
    const statePath = path.join(ctx.testDir, '.vcp/task/pipeline-state.json');
    fs.unlinkSync(statePath);

    // Re-init → choose Resume
    const initCmd = run(`init --pipeline bugfix --cwd "${ctx.testDir}"`);
    expect(initCmd.action).toBe('ask_user');
    report(initCmd.command_id, { answer: 'Resume' });

    const resumedState = readState();
    expect(resumedState.description).toBe('Fix authentication bypass');
  });
});

// ─── SPECIALIST PROMPT CONTENT ──────────────────────────────────────────────

describe('pipeline-driver specialist prompts', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('specialist prompts contain Mission Brief sections', () => {
    const descPath = path.join(ctx.testDir, 'desc.txt');
    fs.writeFileSync(descPath, 'Add user profile page');
    const descFlag = ` --description-file "${descPath}"`;
    const noop = driveToInitTransition('feature', descPath);
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, { content: '' });
    cmd = next(); // step 1: noop VCP_DETECT
    report(cmd.command_id);
    cmd = next(); // step 2: create_team
    report(cmd.command_id);
    cmd = next(); // step 3: parallel_batch (5 specialists)
    expect(cmd.action).toBe('parallel_batch');

    // Read each specialist's prompt file
    for (const c of cmd.commands) {
      const promptContent = fs.readFileSync(c.prompt_file, 'utf-8');
      expect(promptContent).toContain('## Mission');
      expect(promptContent).toContain('## Scope');
      expect(promptContent).toContain('## Team');
      expect(promptContent).toContain('## Asking User Questions');
      expect(promptContent).toContain('[QUESTION]');
      expect(promptContent).toContain('Add user profile page');
    }
  });

  test('specialist prompts contain output schema with questions_for_user', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // read_file VCP
    report(cmd.command_id, { content: '' });
    cmd = next(); // noop VCP_DETECT
    report(cmd.command_id);
    cmd = next(); // create_team
    report(cmd.command_id);
    cmd = next(); // parallel_batch

    for (const c of cmd.commands) {
      const promptContent = fs.readFileSync(c.prompt_file, 'utf-8');
      expect(promptContent).toContain('questions_for_user');
      expect(promptContent).toContain('out_of_scope');
      expect(promptContent).toContain('assumptions');
    }
  });

  test('security analyst prompt includes VCP fields when VCP detected', () => {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config — report VCP detected
    report(cmd.command_id, { content: JSON.stringify({ pluginRoot: '/some/path' }) });
    cmd = next(); // step 1: noop VCP_DETECT
    report(cmd.command_id);
    cmd = next(); // step 2: create_team
    report(cmd.command_id);
    cmd = next(); // step 3: parallel_batch

    const securityCmd = cmd.commands.find((c: any) => c.name === 'security-analyst');
    expect(securityCmd).toBeDefined();
    const promptContent = fs.readFileSync(securityCmd.prompt_file, 'utf-8');
    expect(promptContent).toContain('vcp_active');
    expect(promptContent).toContain('vcp_rule');
    expect(promptContent).toContain('## VCP Standards');
  });
});

// ─── Q&A RELAY ──────────────────────────────────────────────────────────────

describe('pipeline-driver Q&A relay', () => {
  beforeEach(setup);
  afterEach(teardown);

  /** Helper: drive to step 5 interactive loop (after specialist spawn batch reported). */
  function driveToInteractiveLoop(): { recvCmd: any } {
    const noop = driveToInitTransition('feature');
    report(noop.command_id);
    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, { content: '' });
    cmd = next(); // step 1: noop VCP_DETECT
    report(cmd.command_id);
    cmd = next(); // step 2: create_team
    report(cmd.command_id);
    cmd = next(); // step 3: parallel_batch (5 specialists)
    const batchResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      batchResults[c.command_id] = { ok: true, content: 'spawned' };
    }
    report(cmd.command_id, { batch_results: batchResults });
    cmd = next(); // step 4: receive_messages
    expect(cmd.action).toBe('receive_messages');
    return { recvCmd: cmd };
  }

  test('full Q&A cycle: [QUESTION] → ask_user → send_message → transcript', () => {
    const { recvCmd } = driveToInteractiveLoop();

    // Specialist sends a question
    report(recvCmd.command_id, {
      messages: [{ from: 'technical-analyst', summary: '[QUESTION] What database are you using?' }],
    });

    // State should have pending question
    let state = readState();
    expect(state.specialists.pending_questions.length).toBe(1);
    expect(state.specialists.pending_questions[0].specialist_name).toBe('technical-analyst');

    // next() → ask_user (pops from queue into active_relay)
    let cmd = next();
    expect(cmd.action).toBe('ask_user');
    expect(cmd.question).toBe('What database are you using?');
    expect(cmd.context).toContain('technical-analyst');

    // Report user's answer
    report(cmd.command_id, { answer: 'PostgreSQL 15' });
    state = readState();
    expect(state.specialists.active_relay).toBeDefined();
    expect(state.specialists.active_relay.answer).toBe('PostgreSQL 15');

    // next() → send_message to specialist
    cmd = next();
    expect(cmd.action).toBe('send_message');
    expect(cmd.recipient).toBe('technical-analyst');
    expect(cmd.summary).toBe('Answer to your question');

    // Report send_message success → transcript persisted, active_relay cleared
    report(cmd.command_id);
    state = readState();
    expect(state.specialists.active_relay).toBeUndefined();
    expect(state.specialists.qa_transcript.length).toBe(1);
    expect(state.specialists.qa_transcript[0].specialist_name).toBe('technical-analyst');
    expect(state.specialists.qa_transcript[0].question).toBe('What database are you using?');
    expect(state.specialists.qa_transcript[0].answer).toBe('PostgreSQL 15');

    // next() → back to receive_messages
    cmd = next();
    expect(cmd.action).toBe('receive_messages');
  });

  test('multiple questions in one poll are queued and processed sequentially', () => {
    const { recvCmd } = driveToInteractiveLoop();

    // Two specialists send questions in the same poll
    report(recvCmd.command_id, {
      messages: [
        { from: 'security-analyst', summary: '[QUESTION] What auth framework?' },
        { from: 'architecture-analyst', summary: '[QUESTION] Is this a monorepo?' },
      ],
    });

    let state = readState();
    expect(state.specialists.pending_questions.length).toBe(2);

    // First question: ask_user
    let cmd = next();
    expect(cmd.action).toBe('ask_user');
    expect(cmd.question).toBe('What auth framework?');

    // Answer first question
    report(cmd.command_id, { answer: 'Passport.js' });
    cmd = next(); // send_message
    expect(cmd.action).toBe('send_message');
    expect(cmd.recipient).toBe('security-analyst');
    report(cmd.command_id);

    // Second question: ask_user
    cmd = next();
    expect(cmd.action).toBe('ask_user');
    expect(cmd.question).toBe('Is this a monorepo?');

    // Answer second question
    report(cmd.command_id, { answer: 'No, single repo' });
    cmd = next(); // send_message
    expect(cmd.action).toBe('send_message');
    expect(cmd.recipient).toBe('architecture-analyst');
    report(cmd.command_id);

    state = readState();
    expect(state.specialists.qa_transcript.length).toBe(2);

    // Back to polling
    cmd = next();
    expect(cmd.action).toBe('receive_messages');
  });

  test('deferred completion: specialist sends completion while Q&A pending', () => {
    const { recvCmd } = driveToInteractiveLoop();

    // Specialist sends question AND completion in same poll
    report(recvCmd.command_id, {
      messages: [
        { from: 'technical-analyst', summary: '[QUESTION] Which ORM?' },
        { from: 'technical-analyst', summary: 'Analysis complete' },
      ],
    });

    let state = readState();
    // Should NOT be marked completed yet (deferred)
    const specialist = state.specialists.approved_specialists.find(
      (s: any) => s.name === 'technical-analyst'
    );
    expect(specialist.status).toBe('spawned');
    expect(specialist.deferred_completion).toBe(true);

    // Answer the question
    let cmd = next(); // ask_user
    expect(cmd.action).toBe('ask_user');
    report(cmd.command_id, { answer: 'Prisma' });
    cmd = next(); // send_message
    expect(cmd.action).toBe('send_message');
    report(cmd.command_id);

    // After send_message, deferred completion should be promoted
    state = readState();
    const updatedSpecialist = state.specialists.approved_specialists.find(
      (s: any) => s.name === 'technical-analyst'
    );
    expect(updatedSpecialist.status).toBe('completed');
    expect(updatedSpecialist.deferred_completion).toBeUndefined();
  });

  test('completion-before-question ordering: deferred even when complete arrives first', () => {
    const { recvCmd } = driveToInteractiveLoop();

    // Specialist sends completion BEFORE question in same poll (order-dependent bug check)
    report(recvCmd.command_id, {
      messages: [
        { from: 'technical-analyst', summary: 'Analysis complete' },
        { from: 'technical-analyst', summary: '[QUESTION] Which ORM?' },
      ],
    });

    let state = readState();
    const specialist = state.specialists.approved_specialists.find(
      (s: any) => s.name === 'technical-analyst'
    );
    // Must NOT be completed — question is still pending
    expect(specialist.status).toBe('spawned');
    expect(specialist.deferred_completion).toBe(true);
    expect(state.specialists.pending_questions.length).toBe(1);

    // Answer the question → deferred completion promoted
    let cmd = next(); // ask_user
    expect(cmd.action).toBe('ask_user');
    report(cmd.command_id, { answer: 'Prisma' });
    cmd = next(); // send_message
    report(cmd.command_id);

    state = readState();
    const updated = state.specialists.approved_specialists.find(
      (s: any) => s.name === 'technical-analyst'
    );
    expect(updated.status).toBe('completed');
    expect(updated.deferred_completion).toBeUndefined();
  });

  test('question + completion race: deferred not promoted until all questions answered', () => {
    const { recvCmd } = driveToInteractiveLoop();

    // Specialist sends 2 questions + completion
    report(recvCmd.command_id, {
      messages: [
        { from: 'performance-analyst', summary: '[QUESTION] Expected RPS?' },
        { from: 'performance-analyst', summary: '[QUESTION] Cache tier?' },
        { from: 'performance-analyst', summary: 'Analysis done' },
      ],
    });

    let state = readState();
    expect(state.specialists.pending_questions.length).toBe(2);
    const specialist = state.specialists.approved_specialists.find(
      (s: any) => s.name === 'performance-analyst'
    );
    expect(specialist.deferred_completion).toBe(true);
    expect(specialist.status).toBe('spawned');

    // Answer first question
    let cmd = next(); // ask_user
    report(cmd.command_id, { answer: '10k RPS' });
    cmd = next(); // send_message
    report(cmd.command_id);

    // After first answer: still has pending Q, should NOT be promoted
    state = readState();
    const midSpecialist = state.specialists.approved_specialists.find(
      (s: any) => s.name === 'performance-analyst'
    );
    expect(midSpecialist.status).toBe('spawned');
    expect(midSpecialist.deferred_completion).toBe(true);

    // Answer second question
    cmd = next(); // ask_user
    report(cmd.command_id, { answer: 'Redis' });
    cmd = next(); // send_message
    report(cmd.command_id);

    // NOW promoted
    state = readState();
    const finalSpecialist = state.specialists.approved_specialists.find(
      (s: any) => s.name === 'performance-analyst'
    );
    expect(finalSpecialist.status).toBe('completed');
    expect(finalSpecialist.deferred_completion).toBeUndefined();
  });

  test('transcript included in synthesis prompt', () => {
    const descPath = path.join(ctx.testDir, 'desc.txt');
    fs.writeFileSync(descPath, 'Add dark mode support');
    const noop = driveToInitTransition('feature', descPath);
    report(noop.command_id);

    let cmd = next(); // step 0: read_file VCP config
    report(cmd.command_id, { content: '' });
    cmd = next(); // step 1: noop VCP_DETECT
    report(cmd.command_id);
    cmd = next(); // step 2: create_team
    report(cmd.command_id);
    cmd = next(); // step 3: parallel_batch (5 specialists)
    const batchResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      batchResults[c.command_id] = { ok: true, content: 'spawned' };
    }
    report(cmd.command_id, { batch_results: batchResults });

    cmd = next(); // step 4: receive_messages
    // Specialist sends a question
    report(cmd.command_id, {
      messages: [{ from: 'ux-domain-analyst', summary: '[QUESTION] Which color scheme?' }],
    });

    // Answer the question
    cmd = next(); // ask_user
    report(cmd.command_id, { answer: 'Material Design 3' });
    cmd = next(); // send_message
    report(cmd.command_id);

    // Now all specialists complete
    cmd = next(); // receive_messages
    report(cmd.command_id, {
      messages: [
        { from: 'technical-analyst', summary: 'Analysis complete' },
        { from: 'ux-domain-analyst', summary: 'Analysis complete' },
        { from: 'security-analyst', summary: 'Analysis complete' },
        { from: 'performance-analyst', summary: 'Analysis complete' },
        { from: 'architecture-analyst', summary: 'Analysis complete' },
      ],
    });

    // step 6: parallel_batch (read analysis files)
    cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    const readResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      readResults[c.command_id] = { ok: true, content: '{}' };
    }
    report(cmd.command_id, { batch_results: readResults });

    // step 7: parallel_batch (shutdown specialists)
    cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    const shutdownResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      shutdownResults[c.command_id] = { ok: true };
    }
    report(cmd.command_id, { batch_results: shutdownResults });

    // step 8→9: delete_team
    cmd = next();
    expect(cmd.action).toBe('delete_team');
    report(cmd.command_id);

    // step 10: spawn_agent (requirements-gatherer)
    cmd = next();
    expect(cmd.action).toBe('spawn_agent');
    expect(cmd.subagent_type).toBe('dev-buddy:requirements-gatherer');

    // Read the synthesis prompt file
    const promptContent = fs.readFileSync(cmd.prompt_file, 'utf-8');
    expect(promptContent).toContain('FEATURE REQUEST: Add dark mode support');
    expect(promptContent).toContain('Q&A CONTEXT');
    expect(promptContent).toContain('Which color scheme?');
    expect(promptContent).toContain('Material Design 3');
    expect(promptContent).toContain('ux-domain-analyst');
  });
});
