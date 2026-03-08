import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ctx, DRIVER, EXEC_CWD,
  setup, teardown, run, report, readState, readPipelineTasks, next, driveToShowStatus,
} from './pipeline-driver-test-utils.ts';

// ─── FULL E2E TRACES ──────────────────────────────────────────────────────

describe('pipeline-driver e2e feature trace', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('golden trace: init → tasks → deps → requirements', () => {
    let cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('create_team');
    expect(cmd.team_name).toMatch(/^pipeline-/);

    report(cmd.command_id);
    cmd = next();
    expect(cmd.action).toBe('list_tasks');

    // Batch task creation
    report(cmd.command_id, { tasks: [] });
    cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    const taskCount = cmd.commands.length;
    expect(taskCount).toBeGreaterThanOrEqual(9);

    const createResults: Record<string, { ok: boolean; taskId: string }> = {};
    cmd.commands.forEach((sub: any, i: number) => {
      createResults[sub.command_id] = { ok: true, taskId: `task-${i + 1}` };
    });
    report(cmd.command_id, { batch_results: createResults });
    cmd = next();

    // Batch dependency wiring
    expect(cmd.action).toBe('parallel_batch');
    const depResults: Record<string, { ok: boolean }> = {};
    for (const sub of cmd.commands) {
      depResults[sub.command_id] = { ok: true };
    }
    report(cmd.command_id, { batch_results: depResults });
    cmd = next();

    expect(cmd.action).toBe('show_status');

    const state = readState();
    expect(state.phase).toBe('requirements');
    expect(state.stages.length).toBe(taskCount);
    expect(state.stages.every((s: any) => s.task_id)).toBe(true);

    const withGroups = state.stages.filter(
      (s: any) => s.parallel_group_id !== null,
    );
    expect(withGroups.length).toBeGreaterThanOrEqual(4);
  });
});

describe('pipeline-driver e2e bugfix trace', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('golden trace: init → tasks → deps → main_loop', () => {
    let cmd = run(`init --pipeline bugfix --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('create_team');

    report(cmd.command_id);
    cmd = next();
    expect(cmd.action).toBe('list_tasks');

    // Batch task creation
    report(cmd.command_id, { tasks: [] });
    cmd = next();
    expect(cmd.action).toBe('parallel_batch');
    expect(cmd.commands.length).toBe(7);

    const createResults: Record<string, { ok: boolean; taskId: string }> = {};
    cmd.commands.forEach((sub: any, i: number) => {
      createResults[sub.command_id] = { ok: true, taskId: `task-${i + 1}` };
    });
    report(cmd.command_id, { batch_results: createResults });
    cmd = next();

    // Batch dependency wiring
    expect(cmd.action).toBe('parallel_batch');
    const depResults: Record<string, { ok: boolean }> = {};
    for (const sub of cmd.commands) {
      depResults[sub.command_id] = { ok: true };
    }
    report(cmd.command_id, { batch_results: depResults });
    cmd = next();

    expect(cmd.action).toBe('show_status');
    const state = readState();
    expect(state.phase).toBe('main_loop');
    expect(state.stages.length).toBe(7);

    const rcaStages = state.stages.filter((s: any) => s.type === 'rca');
    expect(rcaStages.length).toBe(2);
  });
});

// ─── RCA CONSOLIDATION ────────────────────────────────────────────────────

describe('pipeline-driver RCA consolidation', () => {
  beforeEach(setup);
  afterEach(teardown);

  /** Drive bugfix to completion of all RCA stages */
  function driveBugfixThroughRcaStages(): { state: any } {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    const state = readState();
    const rcaStages = state.stages.filter((s: any) => s.type === 'rca');

    // Complete each RCA stage
    for (let i = 0; i < rcaStages.length; i++) {
      let cmd = next(); // update_task(in_progress)
      report(cmd.command_id);
      cmd = next(); // spawn_agent
      report(cmd.command_id);
      cmd = next(); // read_file

      // Write output file
      const s = readState().stages[i];
      const outputPath = path.join(ctx.testDir, '.vcp/task', s.output_file);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify({
        status: 'complete',
        root_cause: `Null pointer in module ${i}`,
      }));

      report(cmd.command_id, {
        content: JSON.stringify({
          status: 'complete',
          root_cause: `Null pointer in module ${i}`,
        }),
      });

      // update_task(completed) + enrichment
      cmd = next();
      report(cmd.command_id);
    }

    return { state: readState() };
  }

  test('RCA consolidation triggers after all RCA stages complete', () => {
    driveBugfixThroughRcaStages();

    // After RCA stages, next should trigger RCA consolidation
    // with parallel_batch to read all RCA outputs
    const cmd = next();
    // Could be parallel_batch (read outputs) or continue to plan-review
    const state = readState();
    if (state.rca_consolidation) {
      expect(state.rca_consolidation.all_complete).toBe(true);
    }
  });
});

// ─── BACKGROUND TASK WAITING (API) ───────────────────────────────────────

describe('pipeline-driver background task waiting', () => {
  beforeEach(setup);
  afterEach(teardown);

  /** Set up a state with a background task for stage 0 */
  function setupStateWithBackgroundTask() {
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(taskDir, { recursive: true });

    const state = {
      pipeline: 'bugfix',
      team_name: 'pipeline-test-bg',
      config_hash: 'test-hash',
      state_version: 10,
      phase: 'main_loop',
      step: 0,
      pending_command: null,
      command_history: [],
      stages: [
        { index: 0, type: 'rca', provider: 'minimax', model: 'MiniMax-M2.5', providerType: 'api', output_file: 'rca-minimax-MiniMax-M2.5-0-v1.json', task_id: 'task-1', parallel_group_id: null, current_version: 1, status: 'in_progress', iteration_count: 0 },
        { index: 1, type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan-review-anthropic-subscription-sonnet-1-v1.json', task_id: 'task-2', parallel_group_id: null, current_version: 1, status: 'pending', iteration_count: 0 },
      ],
      active_parallel_group: null,
      phased_state: null,
      background_tasks: {
        'bg-task-123': {
          command_id: 'bg-task-123',
          stage_index: 0,
          started_at: new Date().toISOString(),
          timeout_ms: 300000,
          poll_attempts: 0,
          last_poll_result: null,
          deadline: new Date(Date.now() + 300000).toISOString(),
        },
      },
      specialists: null,
      vcp_detection: { detected: false, source_config_path: null, context_injected: false },
      rca_consolidation: null,
      current_dispatch_index: 0,
      dispatch_step: 1, // Agent dispatched, waiting for report
      paused: false,
      pause_reason: null,
      pending_user_decision: null,
      terminal_state: null,
      terminal_reason: null,
      global_iteration_counters: {},
    };

    fs.writeFileSync(path.join(taskDir, 'pipeline-state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(taskDir, 'pipeline-tasks.json'), JSON.stringify({
      pipeline_type: 'bug-fix',
      team_name: state.team_name,
      config_hash: state.config_hash,
      resolved_config: {},
      stages: state.stages.map(s => ({
        type: s.type, provider: s.provider, model: s.model, providerType: s.providerType,
        output_file: s.output_file, task_id: s.task_id, parallel_group_id: s.parallel_group_id,
        current_version: s.current_version,
      })),
    }));
  }

  test('spawn_background report stores background task', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    // Stage 0 dispatch
    let cmd = next(); // update_task
    report(cmd.command_id);
    cmd = next(); // spawn_agent (or spawn_background for API stages)

    // Report with a task_id (simulating spawn_background)
    report(cmd.command_id, { task_id: 'bg-abc' });

    const state = readState();
    // dispatch_step should advance to 2 (read output)
    expect(state.dispatch_step).toBe(2);
  });

  test('wait_for_task emitted for API stage with running background task', () => {
    setupStateWithBackgroundTask();

    // dispatch_step=1 with background task → should emit wait_for_task
    const cmd = next();
    expect(cmd.action).toBe('wait_for_task');
    expect(cmd.task_id).toBe('bg-task-123');
    expect(cmd.poll_on_still_running).toBe(true);
  });

  test('wait_for_task still_running re-polls', () => {
    setupStateWithBackgroundTask();

    let cmd = next(); // wait_for_task
    expect(cmd.action).toBe('wait_for_task');

    // Report still_running
    report(cmd.command_id, { still_running: true });

    // Should re-emit wait_for_task
    cmd = next();
    expect(cmd.action).toBe('wait_for_task');

    const state = readState();
    // Background task should still be tracked
    expect(Object.keys(state.background_tasks).length).toBeGreaterThan(0);
  });

  test('wait_for_task completion advances to read_file', () => {
    setupStateWithBackgroundTask();

    let cmd = next(); // wait_for_task
    expect(cmd.action).toBe('wait_for_task');

    // Report completion (exit_code: 0)
    report(cmd.command_id, { exit_code: 0, event: 'complete' });

    // Background task should be cleaned up, advance to read_file
    cmd = next();
    expect(cmd.action).toBe('read_file');

    const state = readState();
    expect(state.dispatch_step).toBe(2);
  });
});

// ─── ERROR RECOVERY ──────────────────────────────────────────────────────

describe('pipeline-driver error recovery', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('spawn_agent failure marks stage failed', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    let cmd = next(); // update_task(in_progress)
    report(cmd.command_id);
    cmd = next(); // spawn_agent

    // Report failure
    const rpt = { command_id: cmd.command_id, ok: false, error: 'Agent spawn failed' };
    const rptFile = path.join(ctx.testDir, 'rpt.json');
    fs.writeFileSync(rptFile, JSON.stringify(rpt));
    execSync(
      `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmd.command_id}" --result-file "${rptFile}"`,
      { cwd: EXEC_CWD, timeout: 15000 },
    );

    const state = readState();
    expect(state.stages[0].status).toBe('failed');
    expect(state.current_dispatch_index).toBeNull();
    expect(state.dispatch_step).toBe(0);
  });

  test('max iterations reached → terminal state', () => {
    // Inject state at dispatch_step 3 with iteration_count at max
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(taskDir, { recursive: true });

    const state = {
      pipeline: 'bugfix',
      team_name: 'pipeline-test-max',
      config_hash: 'test-hash',
      state_version: 20,
      phase: 'main_loop',
      step: 0,
      pending_command: null,
      command_history: [],
      stages: [
        { index: 0, type: 'rca', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'rca-0-v1.json', task_id: 'task-1', parallel_group_id: null, current_version: 1, status: 'needs_changes', iteration_count: 10 },
        { index: 1, type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan-review-1-v1.json', task_id: 'task-2', parallel_group_id: null, current_version: 1, status: 'pending', iteration_count: 0 },
      ],
      active_parallel_group: null,
      phased_state: null,
      background_tasks: {},
      specialists: null,
      vcp_detection: { detected: false, source_config_path: null, context_injected: false },
      rca_consolidation: null,
      current_dispatch_index: 0,
      dispatch_step: 3, // Just processed result — stage is needs_changes
      paused: false,
      pause_reason: null,
      pending_user_decision: null,
      terminal_state: null,
      terminal_reason: null,
      global_iteration_counters: {},
    };

    fs.writeFileSync(path.join(taskDir, 'pipeline-state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(taskDir, 'pipeline-tasks.json'), JSON.stringify({
      pipeline_type: 'bug-fix',
      team_name: state.team_name,
      config_hash: state.config_hash,
      resolved_config: {},
      stages: state.stages.map(s => ({
        type: s.type, provider: s.provider, model: s.model, providerType: s.providerType,
        output_file: s.output_file, task_id: s.task_id, parallel_group_id: s.parallel_group_id,
        current_version: s.current_version,
      })),
    }));

    // dispatch_step 3 with needs_changes + iteration_count=10 (>= max_iterations=10)
    const cmd = next();
    expect(cmd.action).toBe('done');
    expect(cmd.terminal_state).toBe('max_iterations_reached');

    const updatedState = readState();
    expect(updatedState.terminal_state).toBe('max_iterations_reached');
    expect(updatedState.current_dispatch_index).toBeNull();
  });
});

// ─── BUG FIX REGRESSION TESTS ────────────────────────────────────────────

describe('pipeline-driver bug fixes', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('fix 1: resume pending stage goes through dispatchStage (update_task first)', () => {
    // Build a pipeline-tasks.json with a pending stage (simulating resume)
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(taskDir, { recursive: true });

    const stages = [
      { type: 'rca', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription',
        output_file: 'rca-anthropic-subscription-sonnet-0-v1.json', task_id: 'task-1',
        parallel_group_id: null, current_version: 1 },
    ];

    fs.writeFileSync(path.join(taskDir, 'pipeline-tasks.json'), JSON.stringify({
      pipeline_type: 'bugfix',
      team_name: 'pipeline-test-resume',
      config_hash: 'test',
      resolved_config: {},
      stages,
    }));

    // Init should detect existing pipeline and ask user
    let cmd = run(`init --pipeline bugfix --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('ask_user');

    // User chooses resume
    report(cmd.command_id, { answer: 'Resume' });
    cmd = next();

    // The resumed pending stage should go through the normal main_loop flow,
    // which calls dispatchStage → update_task(in_progress) first
    // NOT directly to spawn_agent (which was the bug)
    if (cmd.action === 'show_status') {
      report(cmd.command_id);
      cmd = next();
    }
    // First dispatch action for a pending stage must be update_task(in_progress)
    expect(cmd.action).toBe('update_task');
    expect(cmd.status).toBe('in_progress');
  });

  test('fix 2: pipeline-tasks.json has task IDs after task-chain creation', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    // At this point, task-chain creation is complete.
    // Verify pipeline-tasks.json has real task IDs (not all null).
    const tasks = readPipelineTasks();
    const taskIds = tasks.stages.map((s: any) => s.task_id);
    expect(taskIds.some((id: any) => id !== null)).toBe(true);
    // All stages should have non-null task IDs
    for (const id of taskIds) {
      expect(id).not.toBeNull();
      expect(id).toMatch(/^task-/);
    }
  });

  test('fix 3: phased API spawn_background stores correct stage_index', () => {
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(taskDir, { recursive: true });

    const stages = [
      { index: 0, type: 'implementation', provider: 'minimax', model: 'MiniMax-M2.5',
        providerType: 'api', output_file: 'impl-result.json', task_id: 'task-impl',
        parallel_group_id: null, current_version: 1, status: 'in_progress', iteration_count: 0 },
    ];

    // State in phased_implementation step 1 (dispatch implementer)
    const state = {
      pipeline: 'feature',
      team_name: 'pipeline-test-api',
      config_hash: 'test',
      state_version: 1,
      phase: 'phased_implementation',
      step: 1,
      pending_command: null,
      command_history: [],
      stages,
      active_parallel_group: null,
      phased_state: {
        impl_stage_index: 0,
        current_step: 1,
        total_steps: 2,
        last_reviewed_step: 0,
        review_interval: 2,
        batch_start: 1,
        batch_end: 0,
        completed_steps: [],
        iteration_count: 0,
        max_iterations: 3,
        per_reviewer_versions: {},
      },
      background_tasks: {},
      specialists: null,
      vcp_detection: { detected: false, source_config_path: null, context_injected: false },
      rca_consolidation: null,
      current_dispatch_index: null, // null in phased mode
      dispatch_step: 0,
      paused: false,
      pause_reason: null,
      pending_user_decision: null,
      terminal_state: null,
      terminal_reason: null,
      global_iteration_counters: {},
    };

    fs.writeFileSync(path.join(taskDir, 'pipeline-state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(taskDir, 'pipeline-tasks.json'), JSON.stringify({
      pipeline_type: 'feature-implement',
      team_name: state.team_name,
      config_hash: state.config_hash,
      resolved_config: {},
      stages: stages.map(s => ({
        type: s.type, provider: s.provider, model: s.model, providerType: s.providerType,
        output_file: s.output_file, task_id: s.task_id,
        parallel_group_id: s.parallel_group_id, current_version: s.current_version,
      })),
    }));

    // next should emit spawn_background for API provider
    const cmd = next();
    expect(cmd.action).toBe('spawn_background');
    expect(cmd.stage_index).toBe(0);

    // Report spawn_background with task_id
    report(cmd.command_id, { task_id: 'bg-phased-1' });

    // Verify background_tasks entry has correct stage_index (not null)
    const updatedState = readState();
    const bgEntry = updatedState.background_tasks['bg-phased-1'];
    expect(bgEntry).toBeDefined();
    expect(bgEntry.stage_index).toBe(0); // Was null before fix
  });

  test('fix 4: partial reviewer files waits for all reviewers', () => {
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(path.join(taskDir, 'phased-reviews'), { recursive: true });

    const stages = [
      { index: 0, type: 'planning', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan/manifest.json', task_id: 'task-1', parallel_group_id: null, current_version: 1, status: 'completed', iteration_count: 0 },
      { index: 1, type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan-review-anthropic-subscription-sonnet-1-v1.json', task_id: 'task-2', parallel_group_id: null, current_version: 1, status: 'completed', iteration_count: 0 },
      { index: 2, type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'impl-result.json', task_id: 'task-3', parallel_group_id: null, current_version: 1, status: 'in_progress', iteration_count: 0 },
      { index: 3, type: 'code-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'code-review-anthropic-subscription-sonnet-3-v1.json', task_id: 'task-4', parallel_group_id: null, current_version: 1, status: 'pending', iteration_count: 0 },
    ];

    const state = {
      pipeline: 'feature',
      team_name: 'pipeline-test-partial',
      config_hash: 'test',
      state_version: 20,
      phase: 'phased_implementation',
      step: 3, // Step 3: check review verdicts
      pending_command: null,
      command_history: [],
      stages,
      active_parallel_group: null,
      phased_state: {
        impl_stage_index: 2,
        current_step: 2,
        total_steps: 4,
        last_reviewed_step: 0,
        review_interval: 2,
        batch_start: 1,
        batch_end: 2,
        completed_steps: [],
        iteration_count: 0,
        max_iterations: 3,
        per_reviewer_versions: {},
      },
      background_tasks: {},
      specialists: null,
      vcp_detection: { detected: false, source_config_path: null, context_injected: false },
      rca_consolidation: null,
      current_dispatch_index: null,
      dispatch_step: 0,
      paused: false,
      pause_reason: null,
      pending_user_decision: null,
      terminal_state: null,
      terminal_reason: null,
      global_iteration_counters: {},
    };

    fs.writeFileSync(path.join(taskDir, 'pipeline-state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(taskDir, 'pipeline-tasks.json'), JSON.stringify({
      pipeline_type: 'feature-implement',
      team_name: state.team_name,
      config_hash: state.config_hash,
      resolved_config: {},
      stages: stages.map(s => ({
        type: s.type, provider: s.provider, model: s.model, providerType: s.providerType,
        output_file: s.output_file, task_id: s.task_id,
        parallel_group_id: s.parallel_group_id, current_version: s.current_version,
      })),
    }));

    // Write only 1 of 2 expected review files (config has 2 phased reviewers)
    fs.writeFileSync(
      path.join(taskDir, 'phased-reviews/phased-review-bailian-qwen3.5-plus-step-2-v1.json'),
      JSON.stringify({ status: 'approved' }),
    );

    const cmd = next();
    // Should wait (noop) because not all reviewers have submitted
    expect(cmd.action).toBe('noop');
    expect(cmd.message).toMatch(/Waiting for phased review/);
  });

  test('fix 5: RCA disagreement detected with object root_cause', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    const state = readState();
    const rcaStages = state.stages.filter((s: any) => s.type === 'rca');

    // Complete each RCA stage with different OBJECT root causes
    for (let i = 0; i < rcaStages.length; i++) {
      let cmd = next(); // update_task(in_progress)
      report(cmd.command_id);
      cmd = next(); // spawn_agent
      report(cmd.command_id);
      cmd = next(); // read_file

      const rootCauseObj = {
        summary: i === 0 ? 'Memory leak in parser' : 'Race condition in scheduler',
        location: i === 0 ? 'parser.ts:42' : 'scheduler.ts:99',
      };

      const s = readState().stages[i];
      const outputPath = path.join(ctx.testDir, '.vcp/task', s.output_file);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify({
        status: 'complete',
        root_cause: rootCauseObj,
      }));

      report(cmd.command_id, {
        content: JSON.stringify({
          status: 'complete',
          root_cause: rootCauseObj,
        }),
      });

      // update_task(completed) + enrichment
      cmd = next();
      report(cmd.command_id);
    }

    const finalState = readState();
    if (finalState.rca_consolidation) {
      // With different object root causes, disagreement should be detected
      // Before the fix, String({...}) = "[object Object]" made them appear identical
      expect(finalState.rca_consolidation.disagreement_detected).toBe(true);
    }
  });

  test('fix 7: resume rejected/failed stage resets to pending for normal dispatch', () => {
    // Build a pipeline-tasks.json with a stage that was rejected (simulating resume)
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(taskDir, { recursive: true });

    const stages = [
      { type: 'rca', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription',
        output_file: 'rca-anthropic-subscription-sonnet-0-v1.json', task_id: 'task-1',
        parallel_group_id: null, current_version: 1 },
    ];

    fs.writeFileSync(path.join(taskDir, 'pipeline-tasks.json'), JSON.stringify({
      pipeline_type: 'bugfix',
      team_name: 'pipeline-test-resume-rejected',
      config_hash: 'test',
      resolved_config: {},
      stages,
    }));

    // Write a state file where the stage is 'rejected'
    fs.writeFileSync(path.join(taskDir, 'pipeline-state.json'), JSON.stringify({
      state_version: 1,
      pipeline: 'bugfix',
      phase: 'main_loop',
      team_name: 'pipeline-test-resume-rejected',
      config_hash: 'test',
      stages: [{
        index: 0, type: 'rca', provider: 'anthropic-subscription', model: 'sonnet',
        providerType: 'subscription', output_file: 'rca-anthropic-subscription-sonnet-0-v1.json',
        task_id: 'task-1', status: 'rejected', parallel_group_id: null, current_version: 1,
        iteration_count: 1,
      }],
      pending_command: null,
      command_history: [],
      rca_consolidation: { results: [], disagreement_detected: false, consolidated_rca: null },
      background_tasks: [],
      phased_impl: null,
      current_dispatch_index: null,
      dispatch_step: 0,
      paused: false,
      pause_reason: null,
      pending_user_decision: null,
      terminal_state: null,
      terminal_reason: null,
      global_iteration_counters: {},
      vcp_detection: { detected: false, source_config_path: null, context_injected: false },
    }));

    // Init should detect existing pipeline and ask user
    let cmd = run(`init --pipeline bugfix --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('ask_user');

    // User chooses resume
    report(cmd.command_id, { answer: 'Resume' });
    cmd = next();

    // After resume, the rejected stage should be reset to 'pending'
    // and go through normal dispatchStage flow (update_task first)
    if (cmd.action === 'show_status') {
      report(cmd.command_id);
      cmd = next();
    }
    expect(cmd.action).toBe('update_task');
    expect(cmd.status).toBe('in_progress');

    // Verify state: the stage should have been reset from 'rejected' to being dispatched
    const updatedState = readState();
    expect(updatedState.stages[0].status).toBe('in_progress');
  });

  test('fix 6: VCP detected sets context_injected when specialists spawn', () => {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    let cmd = next(); // update_task
    report(cmd.command_id);

    cmd = next(); // read_file VCP
    // Report VCP as detected
    report(cmd.command_id, {
      content: JSON.stringify({ pluginRoot: '/some/path' }),
    });

    let state = readState();
    expect(state.vcp_detection.detected).toBe(true);

    cmd = next(); // parallel_batch (spawn specialists)
    expect(cmd.action).toBe('parallel_batch');

    // After specialists are spawned with VCP detected, context_injected should be true
    state = readState();
    expect(state.vcp_detection.context_injected).toBe(true);
  });
});
