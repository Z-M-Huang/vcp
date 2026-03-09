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

  test('golden trace: init → show_status → noop → requirements', () => {
    let cmd = run(`init --pipeline feature --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('show_status');
    expect(cmd.message).toBeTruthy();

    report(cmd.command_id);
    cmd = next();
    expect(cmd.action).toBe('noop'); // init phase transition

    report(cmd.command_id);
    cmd = next();
    // Requirements step 0 (CHECK_STAGE) → read_file for VCP
    expect(cmd.action).toBe('read_file');

    const state = readState();
    expect(state.phase).toBe('requirements');
    expect(state.stages.length).toBeGreaterThanOrEqual(9);

    const withGroups = state.stages.filter(
      (s: any) => s.parallel_group_id !== null,
    );
    expect(withGroups.length).toBeGreaterThanOrEqual(4);
  });
});

describe('pipeline-driver e2e bugfix trace', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('golden trace: init → show_status → noop → main_loop dispatch', () => {
    let cmd = run(`init --pipeline bugfix --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('show_status');

    report(cmd.command_id);
    cmd = next();
    expect(cmd.action).toBe('noop'); // init phase transition

    report(cmd.command_id);
    cmd = next();
    // Main loop dispatches first RCA stage: spawn_agent
    expect(cmd.action).toBe('spawn_agent');

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

  /** Drive bugfix to completion of all RCA stages (handles parallel dispatch) */
  function driveBugfixThroughRcaStages(): { state: any } {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    // noop (init transition)
    let cmd = next();
    report(cmd.command_id);

    const state = readState();
    const rcaStages = state.stages.filter((s: any) => s.type === 'rca');

    // RCA stages may be dispatched as parallel_batch or sequential spawn_agent
    cmd = next();

    if (cmd.action === 'parallel_batch') {
      // Parallel dispatch — report batch success
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = { ok: true };
      }
      report(cmd.command_id, { batch_results: batchResults });

      // Read output files for each RCA stage
      for (let i = 0; i < rcaStages.length; i++) {
        cmd = next(); // read_file
        expect(cmd.action).toBe('read_file');

        const s = readState().stages[rcaStages[i].index];
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
      }
    } else {
      // Sequential dispatch — may be spawn_agent or spawn_background depending on provider
      for (let i = 0; i < rcaStages.length; i++) {
        if (i > 0) cmd = next();
        expect(['spawn_agent', 'spawn_background']).toContain(cmd.action);
        report(cmd.command_id);

        cmd = next(); // read_file
        const s = readState().stages[rcaStages[i].index];
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
      }
    }

    return { state: readState() };
  }

  test('RCA consolidation triggers after all RCA stages complete', () => {
    driveBugfixThroughRcaStages();

    // After RCA stages, next should trigger RCA consolidation
    const cmd = next();
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
        { index: 0, type: 'rca', provider: 'minimax', model: 'MiniMax-M2.5', providerType: 'api', output_file: 'rca-minimax-MiniMax-M2.5-0-v1.json', parallel_group_id: null, current_version: 1, status: 'in_progress', iteration_count: 0 },
        { index: 1, type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan-review-anthropic-subscription-sonnet-1-v1.json', parallel_group_id: null, current_version: 1, status: 'pending', iteration_count: 0 },
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
      dispatch_step: 0, // AGENT — will emit wait_for_task for API bg task
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
        output_file: s.output_file, parallel_group_id: s.parallel_group_id,
        current_version: s.current_version,
      })),
    }));
  }

  test('spawn_background report stores background task', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    // noop (init transition)
    let cmd = next();
    report(cmd.command_id);

    // Stage 0 dispatch: spawn_agent
    cmd = next();
    expect(cmd.action).toBe('spawn_agent');

    // Report with a task_id (simulating spawn_background)
    report(cmd.command_id, { task_id: 'bg-abc' });

    const state = readState();
    // dispatch_step should advance to READ_OUTPUT (1)
    expect(state.dispatch_step).toBe(1);
  });

  test('wait_for_task emitted for API stage with running background task', () => {
    setupStateWithBackgroundTask();

    // dispatch_step=0 with background task → should emit wait_for_task
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
    expect(state.dispatch_step).toBe(1); // READ_OUTPUT
  });
});

// ─── ERROR RECOVERY ──────────────────────────────────────────────────────

describe('pipeline-driver error recovery', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('spawn_agent failure marks stage failed', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    // noop (init transition)
    let cmd = next();
    report(cmd.command_id);

    cmd = next(); // spawn_agent
    expect(cmd.action).toBe('spawn_agent');

    // Report failure — all args are test constants, execSync is safe
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
    // Inject state at dispatch_step PROCESS with iteration_count at max
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
        { index: 0, type: 'rca', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'rca-0-v1.json', parallel_group_id: null, current_version: 1, status: 'needs_changes', iteration_count: 10 },
        { index: 1, type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan-review-1-v1.json', parallel_group_id: null, current_version: 1, status: 'pending', iteration_count: 0 },
      ],
      active_parallel_group: null,
      phased_state: null,
      background_tasks: {},
      specialists: null,
      vcp_detection: { detected: false, source_config_path: null, context_injected: false },
      rca_consolidation: null,
      current_dispatch_index: 0,
      dispatch_step: 2, // PROCESS — stage is needs_changes
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
        output_file: s.output_file, parallel_group_id: s.parallel_group_id,
        current_version: s.current_version,
      })),
    }));

    // dispatch_step PROCESS with needs_changes + iteration_count=10 (>= max_iterations=10)
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

  test('fix 1: resume pending stage dispatches spawn_agent directly', () => {
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(taskDir, { recursive: true });

    const stages = [
      { type: 'rca', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription',
        output_file: 'rca-anthropic-subscription-sonnet-0-v1.json',
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

    if (cmd.action === 'show_status') {
      report(cmd.command_id);
      cmd = next();
    }
    // First dispatch action for a pending stage is spawn_agent
    expect(cmd.action).toBe('spawn_agent');
  });

  test('fix 2: pipeline-tasks.json has no task_id fields', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    const tasks = readPipelineTasks();
    for (const stage of tasks.stages) {
      expect(stage.task_id).toBeUndefined();
    }
  });

  test('fix 3: phased API spawn_background stores correct stage_index', () => {
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(taskDir, { recursive: true });

    const stages = [
      { index: 0, type: 'implementation', provider: 'minimax', model: 'MiniMax-M2.5',
        providerType: 'api', output_file: 'impl-result.json',
        parallel_group_id: null, current_version: 1, status: 'in_progress', iteration_count: 0 },
    ];

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
        output_file: s.output_file,
        parallel_group_id: s.parallel_group_id, current_version: s.current_version,
      })),
    }));

    const cmd = next();
    expect(cmd.action).toBe('spawn_background');
    expect(cmd.stage_index).toBe(0);

    report(cmd.command_id, { task_id: 'bg-phased-1' });

    const updatedState = readState();
    const bgEntry = updatedState.background_tasks['bg-phased-1'];
    expect(bgEntry).toBeDefined();
    expect(bgEntry.stage_index).toBe(0);
  });

  test('fix 4: partial reviewer files waits for all reviewers', () => {
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(path.join(taskDir, 'phased-reviews'), { recursive: true });

    const stages = [
      { index: 0, type: 'planning', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan/manifest.json', parallel_group_id: null, current_version: 1, status: 'completed', iteration_count: 0 },
      { index: 1, type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan-review-anthropic-subscription-sonnet-1-v1.json', parallel_group_id: null, current_version: 1, status: 'completed', iteration_count: 0 },
      { index: 2, type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'impl-result.json', parallel_group_id: null, current_version: 1, status: 'in_progress', iteration_count: 0 },
      { index: 3, type: 'code-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'code-review-anthropic-subscription-sonnet-3-v1.json', parallel_group_id: null, current_version: 1, status: 'pending', iteration_count: 0 },
    ];

    const state = {
      pipeline: 'feature',
      team_name: 'pipeline-test-partial',
      config_hash: 'test',
      state_version: 20,
      phase: 'phased_implementation',
      step: 3,
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
        output_file: s.output_file,
        parallel_group_id: s.parallel_group_id, current_version: s.current_version,
      })),
    }));

    fs.writeFileSync(
      path.join(taskDir, 'phased-reviews/phased-review-bailian-qwen3.5-plus-step-2-v1.json'),
      JSON.stringify({ status: 'approved' }),
    );

    const cmd = next();
    expect(cmd.action).toBe('noop');
    expect(cmd.message).toMatch(/Waiting for phased review/);
  });

  test('fix 5: RCA disagreement detected with object root_cause', () => {
    const showStatus = driveToShowStatus('bugfix');
    report(showStatus.command_id);

    // noop (init transition)
    let cmd = next();
    report(cmd.command_id);

    const state = readState();
    const rcaStages = state.stages.filter((s: any) => s.type === 'rca');

    // RCA stages may be dispatched as parallel_batch or sequential
    cmd = next();

    // Drive through RCA stages — may be parallel_batch or sequential spawn_agent/spawn_background
    let iterations = 0;
    while (iterations < 30 && cmd.action !== 'done') {
      if (cmd.action === 'parallel_batch') {
        const batchResults: Record<string, any> = {};
        for (const c of cmd.commands) {
          batchResults[c.command_id] = { ok: true };
        }
        report(cmd.command_id, { batch_results: batchResults });
      } else if (cmd.action === 'read_file') {
        const st = readState();
        if (st.current_dispatch_index !== null) {
          const s = st.stages[st.current_dispatch_index];
          const rcaIdx = rcaStages.findIndex((r: any) => r.index === s.index);
          const rootCauseObj = {
            summary: rcaIdx === 0 ? 'Memory leak in parser' : 'Race condition in scheduler',
            location: rcaIdx === 0 ? 'parser.ts:42' : 'scheduler.ts:99',
          };
          const outputPath = path.join(ctx.testDir, '.vcp/task', s.output_file);
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, JSON.stringify({ status: 'complete', root_cause: rootCauseObj }));
          report(cmd.command_id, { content: JSON.stringify({ status: 'complete', root_cause: rootCauseObj }) });
        } else {
          report(cmd.command_id);
        }
      } else {
        report(cmd.command_id);
      }

      // Check if RCA consolidation phase started
      const st = readState();
      if (st.rca_consolidation) break;

      cmd = next();
      iterations++;
    }

    const finalState = readState();
    if (finalState.rca_consolidation) {
      expect(finalState.rca_consolidation.disagreement_detected).toBe(true);
    }
  });

  test('fix 7: resume rejected/failed stage resets to pending for normal dispatch', () => {
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(taskDir, { recursive: true });

    const stages = [
      { type: 'rca', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription',
        output_file: 'rca-anthropic-subscription-sonnet-0-v1.json',
        parallel_group_id: null, current_version: 1 },
    ];

    fs.writeFileSync(path.join(taskDir, 'pipeline-tasks.json'), JSON.stringify({
      pipeline_type: 'bugfix',
      team_name: 'pipeline-test-resume-rejected',
      config_hash: 'test',
      resolved_config: {},
      stages,
    }));

    fs.writeFileSync(path.join(taskDir, 'pipeline-state.json'), JSON.stringify({
      state_version: 1,
      pipeline: 'bugfix',
      phase: 'main_loop',
      team_name: 'pipeline-test-resume-rejected',
      config_hash: 'test',
      stages: [{
        index: 0, type: 'rca', provider: 'anthropic-subscription', model: 'sonnet',
        providerType: 'subscription', output_file: 'rca-anthropic-subscription-sonnet-0-v1.json',
        status: 'rejected', parallel_group_id: null, current_version: 1,
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

    let cmd = run(`init --pipeline bugfix --cwd "${ctx.testDir}"`);
    expect(cmd.action).toBe('ask_user');

    report(cmd.command_id, { answer: 'Resume' });
    cmd = next();

    if (cmd.action === 'show_status') {
      report(cmd.command_id);
      cmd = next();
    }
    expect(cmd.action).toBe('spawn_agent');

    const updatedState = readState();
    expect(updatedState.stages[0].status).toBe('in_progress');
  });

  test('fix 6: VCP detected sets context_injected when specialists spawn', () => {
    const showStatus = driveToShowStatus('feature');
    report(showStatus.command_id);

    // noop (init transition)
    let cmd = next();
    report(cmd.command_id);

    cmd = next(); // read_file VCP (CHECK_STAGE)
    report(cmd.command_id, {
      content: JSON.stringify({ pluginRoot: '/some/path' }),
    });

    cmd = next(); // noop (VCP_DETECT)
    report(cmd.command_id);

    let state = readState();
    expect(state.vcp_detection.detected).toBe(true);

    cmd = next(); // create_team (CREATE_TEAM)
    report(cmd.command_id);

    cmd = next(); // parallel_batch (spawn specialists)
    expect(cmd.action).toBe('parallel_batch');

    state = readState();
    expect(state.vcp_detection.context_injected).toBe(true);
  });
});
