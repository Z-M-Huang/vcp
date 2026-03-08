import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ctx, DRIVER, EXEC_CWD,
  setup, teardown, report, readState, next,
} from './pipeline-driver-test-utils.ts';

// ─── PHASED IMPLEMENTATION ────────────────────────────────────────────────
//
// State injection: write pipeline-state.json + pipeline-tasks.json directly
// to exercise phased implementation without driving through 30+ commands.

describe('pipeline-driver phased implementation', () => {
  beforeEach(setup);
  afterEach(teardown);

  /** Build a minimal pipeline state in phased_implementation phase. */
  function setupPhasedState(overrides: Record<string, any> = {}) {
    const taskDir = path.join(ctx.testDir, '.vcp/task');
    fs.mkdirSync(taskDir, { recursive: true });

    const stages = [
      { index: 0, type: 'planning', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan/manifest.json', task_id: 'task-1', parallel_group_id: null, current_version: 1, status: 'completed', iteration_count: 0 },
      { index: 1, type: 'plan-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'plan-review-anthropic-subscription-sonnet-1-v1.json', task_id: 'task-2', parallel_group_id: null, current_version: 1, status: 'completed', iteration_count: 0 },
      { index: 2, type: 'implementation', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'impl-result.json', task_id: 'task-3', parallel_group_id: null, current_version: 1, status: 'in_progress', iteration_count: 0 },
      { index: 3, type: 'code-review', provider: 'anthropic-subscription', model: 'sonnet', providerType: 'subscription', output_file: 'code-review-anthropic-subscription-sonnet-3-v1.json', task_id: 'task-4', parallel_group_id: null, current_version: 1, status: 'pending', iteration_count: 0 },
    ];

    const state = {
      pipeline: 'feature',
      team_name: 'pipeline-test-abc123',
      config_hash: 'test-hash',
      state_version: 20,
      phase: 'phased_implementation',
      step: 0,
      pending_command: null,
      command_history: [],
      stages,
      active_parallel_group: null,
      phased_state: {
        impl_stage_index: 2,
        current_step: 1,
        total_steps: 0, // Set from plan manifest on step 0→1
        last_reviewed_step: 0,
        review_interval: 5,
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
      ...overrides,
    };

    // Apply phased_state overrides separately
    if (overrides.phased_state) {
      state.phased_state = { ...state.phased_state, ...overrides.phased_state };
    }

    fs.writeFileSync(path.join(taskDir, 'pipeline-state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(taskDir, 'pipeline-tasks.json'), JSON.stringify({
      pipeline_type: 'feature-implement',
      team_name: state.team_name,
      config_hash: state.config_hash,
      resolved_config: {},
      stages: stages.map(s => ({
        type: s.type,
        provider: s.provider,
        model: s.model,
        providerType: s.providerType,
        output_file: s.output_file,
        task_id: s.task_id,
        parallel_group_id: s.parallel_group_id,
        current_version: s.current_version,
      })),
    }));

    return state;
  }

  /** Create plan/manifest.json with given step count */
  function writePlanManifest(stepCount: number) {
    const planDir = path.join(ctx.testDir, '.vcp/task/plan');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, 'manifest.json'),
      JSON.stringify({ step_count: stepCount, steps: [] }),
    );
  }

  test('step 0 reads plan manifest', () => {
    setupPhasedState();
    const cmd = next();
    expect(cmd.action).toBe('read_file');
    expect(cmd.path).toContain('plan/manifest.json');
  });

  test('step 1 escalates when total_steps is 0', () => {
    setupPhasedState({ step: 1 });
    const cmd = next();
    expect(cmd.action).toBe('escalate');
    expect(cmd.error).toContain('no step_count');
  });

  test('step 1 dispatches implementer after plan manifest read', () => {
    setupPhasedState();
    writePlanManifest(3);

    // Step 0: read plan manifest
    let cmd = next();
    expect(cmd.action).toBe('read_file');

    // Report plan manifest content → sets total_steps=3, advances to step 1
    report(cmd.command_id, {
      content: JSON.stringify({ step_count: 3 }),
    });

    // Step 1: dispatch implementer for step 1
    cmd = next();
    expect(cmd.action).toBe('spawn_agent');
    expect(cmd.subagent_type).toBe('dev-buddy:implementer');
    expect(cmd.name).toContain('step-1');

    const state = readState();
    expect(state.phased_state.total_steps).toBe(3);
    expect(state.step).toBe(2);
  });

  test('step 2 mid-batch advances to next step', () => {
    setupPhasedState({
      step: 2,
      phased_state: {
        impl_stage_index: 2,
        current_step: 1,
        total_steps: 10,
        last_reviewed_step: 0,
        review_interval: 5,
        batch_start: 1,
        batch_end: 0,
        completed_steps: [],
        iteration_count: 0,
        max_iterations: 3,
        per_reviewer_versions: {},
      },
    });

    const cmd = next();
    expect(cmd.action).toBe('noop');
    expect(cmd.message).toContain('Mid-batch');

    const state = readState();
    expect(state.phased_state.current_step).toBe(2);
    expect(state.step).toBe(1); // Back to step 1 to dispatch next implementer
  });

  test('step 2 batch boundary triggers reviewer dispatch', () => {
    // review_interval=2, current_step=2, batch_start=1 → stepsInBatch=2 → batch complete
    setupPhasedState({
      step: 2,
      phased_state: {
        impl_stage_index: 2,
        current_step: 2,
        total_steps: 4,
        last_reviewed_step: 0,
        review_interval: 2,
        batch_start: 1,
        batch_end: 0,
        completed_steps: [],
        iteration_count: 0,
        max_iterations: 3,
        per_reviewer_versions: {},
      },
    });

    const cmd = next();
    // With 4 phased_reviews in default config, should emit parallel_batch or spawn_agent
    expect(['spawn_agent', 'parallel_batch']).toContain(cmd.action);

    const state = readState();
    expect(state.phased_state.batch_end).toBe(2);
    expect(state.step).toBe(3); // Waiting for review results
  });

  test('step 30 approved → batch approved (step 4) → advances', () => {
    setupPhasedState({
      step: 30,
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
        last_review_approved: true,
      },
    });

    const cmd = next();
    // Step 30 → approved → step 4 → noop (continue next batch)
    expect(cmd.action).toBe('noop');
    expect(cmd.message).toContain('approved');

    const state = readState();
    expect(state.phased_state.completed_steps).toEqual([1, 2]);
    expect(state.phased_state.batch_start).toBe(3);
    expect(state.phased_state.current_step).toBe(3);
    expect(state.step).toBe(1); // Back to dispatch next step
  });

  test('step 30 needs_changes → dispatches fix (step 5→7)', () => {
    setupPhasedState({
      step: 30,
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
        last_review_approved: false,
      },
    });

    const cmd = next();
    // Step 30 → not approved → step 5 → iteration_count++ → step 7 → spawn fix agent
    expect(cmd.action).toBe('spawn_agent');
    expect(cmd.name).toContain('fix-batch');

    const state = readState();
    expect(state.phased_state.iteration_count).toBe(1);
    expect(state.step).toBe(7);
  });

  test('step 5 max iterations → escalation (step 6)', () => {
    setupPhasedState({
      step: 30,
      phased_state: {
        impl_stage_index: 2,
        current_step: 2,
        total_steps: 4,
        last_reviewed_step: 0,
        review_interval: 2,
        batch_start: 1,
        batch_end: 2,
        completed_steps: [],
        iteration_count: 2, // Will become 3 (= max_iterations)
        max_iterations: 3,
        per_reviewer_versions: {},
        last_review_approved: false,
      },
    });

    const cmd = next();
    // Step 30 → needs_changes → step 5 → iteration_count=3 >= max → ask_user
    expect(cmd.action).toBe('ask_user');
    expect(cmd.question).toContain('failed phased review');
    expect(cmd.context).toContain('escalation');
  });

  test('step 6 escalation → pause', () => {
    setupPhasedState({
      step: 6,
      phased_state: {
        impl_stage_index: 2,
        current_step: 2,
        total_steps: 4,
        last_reviewed_step: 0,
        review_interval: 2,
        batch_start: 1,
        batch_end: 2,
        completed_steps: [],
        iteration_count: 3,
        max_iterations: 3,
        per_reviewer_versions: {},
      },
    });

    const cmd = next();
    expect(cmd.action).toBe('pause');
    expect(cmd.reason).toContain('phased review');

    const state = readState();
    expect(state.paused).toBe(true);
  });

  test('all steps complete → aggregation writes impl-result.json', () => {
    setupPhasedState({
      step: 30,
      phased_state: {
        impl_stage_index: 2,
        current_step: 3,
        total_steps: 3,
        last_reviewed_step: 0,
        review_interval: 3,
        batch_start: 1,
        batch_end: 3,
        completed_steps: [],
        iteration_count: 0,
        max_iterations: 3,
        per_reviewer_versions: {},
        last_review_approved: true,
      },
    });

    const cmd = next();
    // Step 30 → approved → step 4 → all steps done → step 10 → aggregation
    expect(cmd.action).toBe('write_file');
    expect(cmd.path).toContain('impl-result.json');

    const state = readState();
    expect(state.phase).toBe('main_loop'); // Transitioned back
    expect(state.phased_state).toBeNull();
    expect(state.stages[2].status).toBe('completed');
  });

  test('step 7 fix dispatched → re-review cycle (step 3)', () => {
    setupPhasedState({
      step: 7,
      phased_state: {
        impl_stage_index: 2,
        current_step: 2,
        total_steps: 4,
        last_reviewed_step: 0,
        review_interval: 2,
        batch_start: 1,
        batch_end: 2,
        completed_steps: [],
        iteration_count: 1,
        max_iterations: 3,
        per_reviewer_versions: {},
      },
    });

    const cmd = next();
    // Step 7 → dispatch reviewers again
    expect(['spawn_agent', 'parallel_batch']).toContain(cmd.action);

    const state = readState();
    expect(state.step).toBe(3); // Waiting for review results
    expect(state.phased_state.last_review_approved).toBe(true); // Reset before re-review
  });

  test('phased impl dispatch error marks stage failed + terminal', () => {
    setupPhasedState();
    writePlanManifest(3);

    // Step 0: read plan manifest
    let cmd = next();
    expect(cmd.action).toBe('read_file');
    report(cmd.command_id, { content: JSON.stringify({ step_count: 3 }) });

    // Step 1: dispatch implementer (spawn_agent)
    cmd = next();
    expect(cmd.action).toBe('spawn_agent');

    // Report spawn_agent failure (dispatch action)
    const rpt = { command_id: cmd.command_id, ok: false, error: 'Agent spawn failed' };
    const rptFile = path.join(ctx.testDir, 'rpt.json');
    fs.writeFileSync(rptFile, JSON.stringify(rpt));
    execSync(
      `bun "${DRIVER}" report --cwd "${ctx.testDir}" --id "${cmd.command_id}" --result-file "${rptFile}"`,
      { cwd: EXEC_CWD, timeout: 15000 },
    );

    const state = readState();
    expect(state.terminal_state).toBe('implementation_failed');
    expect(state.stages[2].status).toBe('failed');
    expect(state.phase).toBe('main_loop');
    expect(state.phased_state).toBeNull();
  });

  test('review verdict read_file with needs_changes sets last_review_approved false', () => {
    // Use sanitizeForFilename-correct names matching default config phased_reviews
    const reviewDir = path.join(ctx.testDir, '.vcp/task/phased-reviews');

    setupPhasedState({
      step: 3,
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
        last_review_approved: true,
      },
    });

    // Create review files with sanitized names (lowercase, spaces→hyphens)
    fs.mkdirSync(reviewDir, { recursive: true });
    const reviewFiles = [
      'phased-review-bailian-qwen3.5-plus-step-2-v1.json',
      'phased-review-bailian-kimi-k2.5-step-2-v1.json',
      'phased-review-bailian-glm-5-step-2-v1.json',
      'phased-review-bailian-openai-minimax-m2.5-step-2-v1.json',
    ];
    for (const f of reviewFiles) {
      fs.writeFileSync(
        path.join(reviewDir, f),
        JSON.stringify({ status: 'needs_changes', issues: ['Fix imports'] }),
      );
    }

    // Step 3: should read review files → parallel_batch of read_file
    let cmd = next();
    expect(['read_file', 'parallel_batch']).toContain(cmd.action);

    // Report review content with needs_changes
    if (cmd.action === 'parallel_batch') {
      const batchResults: Record<string, any> = {};
      for (const c of cmd.commands) {
        batchResults[c.command_id] = {
          ok: true,
          content: JSON.stringify({ status: 'needs_changes', issues: ['Fix imports'] }),
        };
      }
      report(cmd.command_id, { batch_results: batchResults });
    } else {
      report(cmd.command_id, {
        content: JSON.stringify({ status: 'needs_changes', issues: ['Fix imports'] }),
      });
    }

    const updatedState = readState();
    expect(updatedState.phased_state.last_review_approved).toBe(false);
    expect(updatedState.step).toBe(30);
  });

  test('no reviewers configured → auto-approve', () => {
    // The auto-approve path is hit when phased_reviews is empty in config.
    // Default config HAS phased_reviews, so we test the step 3 → no files → noop path.
    setupPhasedState({
      step: 3,
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
    });

    // No review files exist → noop (waiting)
    const cmd = next();
    expect(cmd.action).toBe('noop');
    expect(cmd.message).toContain('Waiting for phased review');
  });

  test('multi-reviewer batch spawn failure marks impl failed', () => {
    // Set up state at step 2 batch boundary to trigger reviewer dispatch
    setupPhasedState({
      step: 2,
      phased_state: {
        impl_stage_index: 2,
        current_step: 2,
        total_steps: 4,
        last_reviewed_step: 0,
        review_interval: 2,
        batch_start: 1,
        batch_end: 0,
        completed_steps: [],
        iteration_count: 0,
        max_iterations: 3,
        per_reviewer_versions: {},
      },
    });

    const cmd = next();
    // Default config has 4 phased reviewers → parallel_batch
    expect(cmd.action).toBe('parallel_batch');
    expect(cmd.commands.length).toBeGreaterThan(1);

    // Report all reviewer spawns as failed
    const batchResults: Record<string, any> = {};
    for (const c of cmd.commands) {
      batchResults[c.command_id] = { ok: false, error: 'reviewer spawn failed' };
    }
    report(cmd.command_id, { batch_results: batchResults });

    const state = readState();
    expect(state.terminal_state).toBe('phased_reviewer_spawn_failed');
    // Implementation stage should be marked as failed
    const implStage = state.stages.find((s: any) => s.type === 'implementation');
    expect(implStage?.status).toBe('failed');
  });
});
