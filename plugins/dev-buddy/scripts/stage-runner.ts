#!/usr/bin/env bun
/**
 * Stage Runner — multi-executor dispatch + synthesize for Ralph pipeline stages.
 *
 * Reads config, resolves system prompts, dispatches all executors (subscription, API, CLI)
 * in segment order (parallel groups + sequential steps), collects outputs, and passes them
 * to the synthesizer (last non-parallel executor). Returns synthesized result as JSON.
 *
 * Executor dispatch by preset type:
 *   - Subscription: `claude -p` CLI (non-interactive mode)
 *   - API: `api-task-runner.ts` subprocess
 *   - CLI: `one-shot-runner.ts --output-id` subprocess
 *
 * Usage:
 *   bun stage-runner.ts --stage-type discovery --plan <path> --cwd <dir> --task "feature description"
 *   echo "feature description" | bun stage-runner.ts --stage-type discovery --plan <path> --cwd <dir> --task-stdin
 *
 * Exit codes:
 *   0 - Success (synthesis complete)
 *   1 - Validation error (missing config, bad stage type, no executors)
 *   2 - Execution error (subprocess failure, dispatch error)
 *   3 - Timeout
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { loadDevBuddyConfig, atomicWriteFile } from './pipeline-config.ts';
import { readPresets } from './preset-utils.ts';
import { loadStageDefinition, getSystemPrompt, composePrompt, discoverSystemPrompts } from './system-prompts.ts';
import { vcpLog, isDebugEnabled } from './vcp-logger.ts';
import type { StageExecutor, DevBuddyConfig } from '../types/pipeline.ts';
import type { Preset } from '../types/presets.ts';
import type { StageType } from '../types/stage-definitions.ts';

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000;       // 5 min default per executor
const CLI_DEFAULT_TIMEOUT_MS = 1_200_000; // 20 min for CLI
const PROCESS_TIMEOUT_BUFFER_MS = 120_000;
const KILL_GRACE_MS = 3_000;

// ─── TYPES ──────────────────────────────────────────────────────────────────

interface ExecutorOutput {
  executor_index: number;
  preset: string;
  model: string;
  system_prompt: string;
  result: string;
}

interface StageRunnerOutput {
  event: 'complete';
  stage: string;
  worker_outputs: ExecutorOutput[];
  synthesis: string | null;
}

interface StageRunnerError {
  event: 'error';
  phase: string;
  error: string;
  partial_outputs?: ExecutorOutput[];
}

/** A segment is a group of executors that run together (parallel or single sequential). */
interface Segment {
  parallel: boolean;
  executors: Array<{ executor: StageExecutor; index: number }>;
}

// ─── STAGE PROGRESS TRACKING ───────────────────────────────────────────────

interface ExecutorProgress {
  index: number;
  preset: string;
  model: string;
  system_prompt: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  duration_s?: number;
}

interface StageProgressState {
  stage: string;
  pid: number;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  outcome: 'success' | 'error' | 'fatal' | null;
  total: number;
  completed: number;
  failed: number;
  executors: ExecutorProgress[];
}

/**
 * Stage-level progress tracker. Writes an atomic JSON file as each executor
 * transitions through pending → running → done|failed.
 *
 * Every public method is non-throwing — progress tracking failure never
 * affects stage execution.
 */
class StageProgress {
  private state: StageProgressState;
  private filePath: string;
  private multiExecutor: boolean;

  constructor(
    stageType: string,
    executors: Array<{ index: number; executor: StageExecutor }>,
    cwd: string,
    slugHint: string | null = null,
  ) {
    // Scoping (§7): ralph stages pass the plan slug so progress files land under
    // .state/ralph-{slug}/progress/ and get archived with the plan. One-shot and
    // chatroom callers pass null and keep the legacy flat path.
    this.filePath = slugHint
      ? path.join(cwd, '.vcp', 'plan', '.state', `ralph-${slugHint}`, 'progress', `stage-progress-${stageType}-${process.pid}.json`)
      : path.join(cwd, '.vcp', 'plan', '.state', `stage-progress-${stageType}-${process.pid}.json`);
    this.multiExecutor = executors.length > 1;
    this.state = {
      stage: stageType,
      pid: process.pid,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      finished_at: null,
      outcome: null,
      total: executors.length,
      completed: 0,
      failed: 0,
      executors: executors.map(({ index, executor }) => ({
        index,
        preset: executor.preset,
        model: executor.model,
        system_prompt: executor.system_prompt,
        status: 'pending' as const,
      })),
    };
    this.writeSnapshot();
  }

  markRunning(index: number): void {
    try {
      const entry = this.state.executors.find(e => e.index === index);
      if (entry) entry.status = 'running';
      this.writeSnapshot();
    } catch { /* non-throwing */ }
  }

  markDone(index: number, durationS: number): void {
    try {
      const entry = this.state.executors.find(e => e.index === index);
      if (entry) {
        entry.status = 'done';
        entry.duration_s = durationS;
      }
      this.state.completed++;
      this.writeSnapshot();
      if (this.multiExecutor) {
        const done = this.state.completed + this.state.failed;
        process.stderr.write(`[${done}/${this.state.total}] executor ${index} (${entry?.preset}/${entry?.model}/${entry?.system_prompt}) done (${durationS}s)\n`);
      }
    } catch { /* non-throwing */ }
  }

  markFailed(index: number, durationS: number): void {
    try {
      const entry = this.state.executors.find(e => e.index === index);
      if (entry) {
        entry.status = 'failed';
        entry.duration_s = durationS;
      }
      this.state.failed++;
      this.writeSnapshot();
      if (this.multiExecutor) {
        const done = this.state.completed + this.state.failed;
        process.stderr.write(`[${done}/${this.state.total}] executor ${index} (${entry?.preset}/${entry?.model}/${entry?.system_prompt}) failed (${durationS}s)\n`);
      }
    } catch { /* non-throwing */ }
  }

  writeTerminal(outcome: 'success' | 'error' | 'fatal'): void {
    try {
      this.state.finished_at = new Date().toISOString();
      this.state.outcome = outcome;
      this.writeSnapshot();
    } catch { /* non-throwing */ }
  }

  getFilePath(): string { return this.filePath; }

  private writeSnapshot(): void {
    try {
      this.state.updated_at = new Date().toISOString();
      atomicWriteFile(this.filePath, this.state);
    } catch { /* non-throwing — progress failure must not abort stage */ }
  }
}

// ─── OUTPUT HELPERS ─────────────────────────────────────────────────────────

function emitSuccess(stage: string, workerOutputs: ExecutorOutput[], synthesis: string | null): never {
  const output: StageRunnerOutput = { event: 'complete', stage, worker_outputs: workerOutputs, synthesis };
  console.log(JSON.stringify(output));
  process.exit(0);
}

function emitError(phase: string, error: string, exitCode: number = 2, partialOutputs?: ExecutorOutput[]): never {
  const output: StageRunnerError = { event: 'error', phase, error, partial_outputs: partialOutputs };
  console.log(JSON.stringify(output));
  process.exit(exitCode);
}

// ─── PER-STAGE TASK BUILDER ─────────────────────────────────────────────────

/**
 * Build the task prompt for a stage, injecting prior stage context from the plan file.
 * - All stages: feature + ## Feedback section (if present, from user rejection)
 * - discovery: feature description only (+ feedback on re-run)
 * - ralph-requirements: feature + ## Discovery section
 * - decomposition: feature + ## Discovery + ## Requirements sections
 */
function buildStageTask(stageType: string, featureDescription: string, planPath: string): string {
  let planContent = '';
  try {
    planContent = fs.readFileSync(planPath, 'utf-8');
  } catch {
    // Plan file may not exist on first discovery run
  }

  // Known plan-level sections — only these act as extraction boundaries.
  // Arbitrary H2 subheadings within a section (e.g. "## Acceptance Criteria"
  // inside "## Requirements") must NOT truncate extraction.
  const PLAN_SECTIONS = ['## Discovery', '## Requirements', '## Units of Work', '## Feedback', '## UAT Results'];
  const extractSection = (heading: string): string => {
    if (!planContent) return '';
    const regex = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
    const match = planContent.match(regex);
    if (!match || match.index === undefined) return '';
    const start = match.index + match[0].length;
    let nextBoundary = -1;
    for (const section of PLAN_SECTIONS) {
      if (section === heading) continue;
      const idx = planContent.indexOf('\n' + section, start);
      if (idx !== -1 && (nextBoundary === -1 || idx < nextBoundary)) {
        nextBoundary = idx;
      }
    }
    return planContent.slice(start, nextBoundary === -1 ? undefined : nextBoundary).trim();
  };

  let context = featureDescription;

  // User rejection feedback — injected for all stage types including discovery re-runs
  const feedback = extractSection('## Feedback');
  if (feedback) {
    context += '\n\n---\n\n## User Feedback (Address This)\n\n' + feedback;
  }

  if (stageType === 'discovery') {
    return context;
  }

  if (stageType === 'ralph-requirements' || stageType === 'decomposition') {
    const discovery = extractSection('## Discovery');
    if (discovery) {
      context += '\n\n---\n\n## Prior Discovery Findings\n\n' + discovery;
    }
  }

  if (stageType === 'decomposition') {
    const requirements = extractSection('## Requirements');
    if (requirements) {
      context += '\n\n---\n\n## Prior Requirements\n\n' + requirements;
    }
  }

  return context;
}

// ─── SEGMENTATION ───────────────────────────────────────────────────────────

/**
 * Segment executors by parallel flag into ordered groups.
 * Consecutive parallel:true executors form a parallel segment.
 * Each parallel:false executor is a sequential segment (runs alone).
 */
function segmentExecutors(executors: StageExecutor[]): Segment[] {
  const segments: Segment[] = [];
  let currentParallel: Array<{ executor: StageExecutor; index: number }> = [];

  for (let i = 0; i < executors.length; i++) {
    const executor = executors[i];
    if (executor.parallel) {
      currentParallel.push({ executor, index: i });
    } else {
      // Flush any accumulated parallel executors
      if (currentParallel.length > 0) {
        segments.push({ parallel: true, executors: currentParallel });
        currentParallel = [];
      }
      // Sequential segment
      segments.push({ parallel: false, executors: [{ executor, index: i }] });
    }
  }
  // Flush remaining parallel
  if (currentParallel.length > 0) {
    segments.push({ parallel: true, executors: currentParallel });
  }

  return segments;
}

// ─── EXECUTOR DISPATCH ──────────────────────────────────────────────────────

interface DispatchResult {
  executor_index: number;
  status: 'fulfilled' | 'rejected';
  result?: string;
  error?: string;
}

/**
 * Build the argv for a subscription-preset `claude -p` invocation.
 *
 * Three correctness details the caller must not lose:
 *   1. The Claude CLI flag is `--allowed-tools` (aliased `--allowedTools`).
 *      The permission-allowlist semantic matches what stage definitions
 *      declare and aligns with the API path below (line ~370).
 *   2. `--allowed-tools <tools...>` is declared *variadic* in the CLI's
 *      argparse. Without a `--` terminator, the following positional
 *      (`task`) is consumed into the tools list and `-p` is left without
 *      a prompt — the CLI errors with "Input must be provided either
 *      through stdin or as a prompt argument when using --print". Insert
 *      `--` before `task` so the positional is always parsed as the prompt.
 *   3. Do NOT add `--bare`. It forces Anthropic auth to be strictly
 *      ANTHROPIC_API_KEY / apiKeyHelper and explicitly ignores the user's
 *      OAuth login + keychain. Subscription presets depend on the user
 *      having run `claude /login`, so `--bare` makes every subscription
 *      dispatch fail with "Not logged in".
 */
export function buildSubscriptionArgs(opts: {
  model: string;
  systemPrompt: string;
  allowedTools: string;
  task: string;
}): string[] {
  const args = [
    '-p',
    '--model', opts.model,
    '--system-prompt', opts.systemPrompt,
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
  ];
  if (opts.allowedTools) {
    args.push('--allowed-tools', opts.allowedTools);
  }
  args.push('--', opts.task);
  return args;
}

/**
 * Dispatch a single executor as a subprocess. Returns a promise that resolves
 * when the subprocess completes.
 */
function dispatchExecutor(
  executor: StageExecutor,
  executorIndex: number,
  preset: Preset,
  composedPrompt: string,
  task: string,
  allowedTools: string,
  cwd: string,
  debugEnabled: boolean,
): Promise<DispatchResult> {
  return new Promise<DispatchResult>((resolve) => {
    const timeoutMs = (('timeout_ms' in preset ? preset.timeout_ms : undefined) || DEFAULT_TIMEOUT_MS) + PROCESS_TIMEOUT_BUFFER_MS;
    let timedOut = false;
    let proc: ReturnType<typeof spawn>;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (preset.type === 'subscription') {
      // Subscription: claude -p — see buildSubscriptionArgs for the two
      // correctness details (flag name, variadic terminator).
      const args = buildSubscriptionArgs({
        model: executor.model,
        systemPrompt: composedPrompt,
        allowedTools,
        task,
      });

      proc = spawn('claude', args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        cwd,
      });
    } else if (preset.type === 'api') {
      // API: api-task-runner.ts
      const taskRunnerPath = path.join(path.dirname(import.meta.path), 'api-task-runner.ts');
      const taskTimeoutMs = ('timeout_ms' in preset ? preset.timeout_ms : undefined) || DEFAULT_TIMEOUT_MS;
      const args = [
        'bun', taskRunnerPath,
        '--preset', executor.preset,
        '--model', executor.model,
        '--task-stdin',
        '--cwd', cwd,
        '--task-timeout', String(taskTimeoutMs),
        '--system-prompt', executor.system_prompt,
      ];
      if (allowedTools) {
        args.push('--allowed-tools', allowedTools);
      }

      proc = spawn(args[0], args.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
      });
      proc.stdin!.write(task);
      proc.stdin!.end();
    } else if (preset.type === 'cli') {
      // CLI: one-shot-runner.ts with --output-id for capture
      const outputId = `stage-${executorIndex}-${crypto.randomUUID().slice(0, 8)}`;
      const oneShotPath = path.join(path.dirname(import.meta.path), 'one-shot-runner.ts');
      const args = [
        'bun', oneShotPath,
        '--type', 'cli',
        '--preset', executor.preset,
        '--model', executor.model,
        '--cwd', cwd,
        '--output-id', outputId,
        '--task-stdin',
      ];

      proc = spawn(args[0], args.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
      });
      // CLI presets can't structurally enforce a system prompt (no --system-prompt
      // flag equivalent in arbitrary CLI tools). Prepend the composed prompt (stage
      // definition + role) so the CLI executor receives the same constraints and
      // role identity as subscription/API executors.
      let effectiveTask = composedPrompt
        ? `${composedPrompt}\n\n---\n\n${task}`
        : task;
      if (allowedTools) {
        effectiveTask += `\n\nIMPORTANT: You may ONLY use these tools: ${allowedTools}.`;
      }
      proc.stdin!.write(effectiveTask);
      proc.stdin!.end();
    } else {
      resolve({ executor_index: executorIndex, status: 'rejected', error: `Unknown preset type: ${(preset as any).type}` });
      return;
    }

    // Collect stdout and stderr — drain immediately to avoid backpressure deadlock
    if (proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    }

    // Wall-clock timeout
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* best effort */ }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ executor_index: executorIndex, status: 'rejected', error: `Failed to start: ${err.message}` });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      // Log captured stderr to file (debug-gated); never leaks to parent Bash tool
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (stderr.trim()) {
        vcpLog(cwd, {
          source: 'stage-runner', event: 'executor_stderr', decision: 'info',
          details: `executor=${executorIndex} stderr=${stderr.slice(0, 100_000)}`,
        }, debugEnabled).catch(() => {});
      }

      if (timedOut) {
        resolve({ executor_index: executorIndex, status: 'rejected', error: 'Timed out' });
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();

      if (preset.type === 'subscription') {
        // claude -p --output-format json returns JSON with result field
        if (code === 0 && stdout) {
          try {
            const parsed = JSON.parse(stdout);
            // claude -p json format: { result: string, ... }
            const resultText = parsed.result || parsed.text || stdout;
            resolve({ executor_index: executorIndex, status: 'fulfilled', result: resultText });
          } catch {
            // If JSON parse fails, use raw stdout
            resolve({ executor_index: executorIndex, status: 'fulfilled', result: stdout });
          }
          return;
        }
      } else {
        // API/CLI: parse last line as JSON event
        const lastLine = stdout.split('\n').pop() || '';
        if (lastLine) {
          try {
            const parsed = JSON.parse(lastLine);
            if (parsed.event === 'complete') {
              resolve({ executor_index: executorIndex, status: 'fulfilled', result: parsed.result || '' });
              return;
            } else if (parsed.event === 'error') {
              resolve({ executor_index: executorIndex, status: 'rejected', error: parsed.error || 'Unknown error' });
              return;
            }
          } catch { /* fall through */ }
        }
      }

      if (code !== 0) {
        // Include stderr excerpt so fatal errors not on stdout are still visible
        const stderrExcerpt = stderr.trim() ? ` stderr=${stderr.slice(0, 500)}` : '';
        resolve({ executor_index: executorIndex, status: 'rejected', error: `Exit code ${code}: ${stdout.slice(0, 500)}${stderrExcerpt}` });
      } else {
        resolve({ executor_index: executorIndex, status: 'fulfilled', result: stdout || '' });
      }
    });
  });
}

/**
 * Kill all processes in a list. Best-effort SIGTERM → SIGKILL.
 */
function killSiblings(procs: Array<ReturnType<typeof spawn>>): void {
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* best effort */ }
  }
  setTimeout(() => {
    for (const p of procs) {
      try { p.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }, KILL_GRACE_MS);
}

// ─── EXECUTOR WITH PROGRESS ────────────────────────────────────────────────

/**
 * Dispatch an executor and update progress tracking as a side effect.
 * Does NOT catch dispatch exceptions — they propagate to the caller.
 * All progress methods are non-throwing, so they cannot alter control flow.
 */
async function runExecutorWithProgress(
  executor: StageExecutor,
  index: number,
  preset: Preset,
  composedPrompt: string,
  task: string,
  allowedTools: string,
  cwd: string,
  debugEnabled: boolean,
  progress: StageProgress,
): Promise<DispatchResult> {
  progress.markRunning(index);
  const startTime = Date.now();

  const result = await dispatchExecutor(
    executor, index, preset, composedPrompt, task, allowedTools, cwd, debugEnabled,
  );

  const durationS = Math.round((Date.now() - startTime) / 1000);
  if (result.status === 'fulfilled') {
    progress.markDone(index, durationS);
  } else {
    progress.markFailed(index, durationS);
  }
  return result;
}

// ─── CLI ARG PARSING ────────────────────────────────────────────────────────

interface StageRunnerArgs {
  stageType: string;
  planPath: string;
  cwd: string;
  task: string;
}

function parseArgs(argv: string[]): StageRunnerArgs {
  const args = argv.slice(2);
  let stageType = '';
  let planPath = '';
  let cwd = '';
  let task = '';
  let taskFromStdin = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--stage-type':
        if (!next) throw new Error('--stage-type requires a value');
        stageType = next; i++; break;
      case '--plan':
        if (!next) throw new Error('--plan requires a value');
        planPath = next; i++; break;
      case '--cwd':
        if (!next) throw new Error('--cwd requires a value');
        cwd = next; i++; break;
      case '--task':
        if (!next) throw new Error('--task requires a value');
        task = next; i++; break;
      case '--task-stdin':
        taskFromStdin = true; break;
      default:
        break;
    }
  }

  if (!stageType) throw new Error('--stage-type is required');
  if (!planPath) throw new Error('--plan is required');
  if (!cwd) throw new Error('--cwd is required');
  if (!task && !taskFromStdin) throw new Error('--task or --task-stdin is required');

  // Stdin wins when both provided (avoids argv size limits + ps exposure)
  if (taskFromStdin) {
    const stdinBuf = fs.readFileSync(0, 'utf-8');
    if (!stdinBuf.trim()) throw new Error('No task provided on stdin');
    task = stdinBuf.trim();
  }

  return { stageType, planPath, cwd, task };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let parsedArgs: StageRunnerArgs;
  try {
    parsedArgs = parseArgs(process.argv);
  } catch (err) {
    emitError('validation', (err as Error).message, 1);
  }

  const { stageType, planPath, cwd, task } = parsedArgs;
  const debugEnabled = await isDebugEnabled();

  await vcpLog(cwd, {
    source: 'stage-runner', event: 'start', decision: 'info',
    details: `stage=${stageType} plan=${planPath}`,
  }, debugEnabled);

  // 1. Load config
  let config: DevBuddyConfig;
  try {
    config = loadDevBuddyConfig();
  } catch (err) {
    emitError('validation', `Failed to load config: ${(err as Error).message}`, 1);
  }

  const stageConfig = config.stages[stageType as StageType];
  if (!stageConfig || stageConfig.executors.length === 0) {
    emitError('validation', `No executors configured for stage '${stageType}'`, 1);
  }

  // 2. Load presets
  let presets: ReturnType<typeof readPresets>;
  try {
    presets = readPresets();
  } catch (err) {
    emitError('validation', `Failed to load presets: ${(err as Error).message}`, 1);
  }

  // 3. Resolve system prompts
  const stagesDir = path.join(path.dirname(import.meta.path), '..', 'stages');
  const builtInDir = path.join(path.dirname(import.meta.path), '..', 'system-prompts', 'built-in');
  const stageDef = loadStageDefinition(stageType, stagesDir);
  if (!stageDef) {
    emitError('validation', `Stage definition not found for '${stageType}' in ${stagesDir}`, 1);
  }

  // Derive allowed tools from stage definition
  const allowedTools = stageDef.tools.join(',');

  // Resolve presets and compose prompts for each executor
  const resolvedExecutors: Array<{
    executor: StageExecutor;
    preset: Preset;
    composedPrompt: string;
    index: number;
  }> = [];

  for (let i = 0; i < stageConfig.executors.length; i++) {
    const executor = stageConfig.executors[i];

    // Resolve preset
    const preset = presets.presets[executor.preset];
    if (!preset) {
      emitError('validation', `Preset '${executor.preset}' not found for executor ${i} in stage '${stageType}'`, 1);
    }

    // Resolve system prompt and compose
    const rolePrompt = getSystemPrompt(executor.system_prompt, builtInDir);
    if (!rolePrompt) {
      const available = discoverSystemPrompts(builtInDir).map(p => p.name);
      emitError('validation', `System prompt '${executor.system_prompt}' not found. Available: ${available.join(', ')}`, 1);
    }
    const composedPrompt = composePrompt(stageDef, rolePrompt);

    resolvedExecutors.push({ executor, preset, composedPrompt, index: i });
  }

  // 4. Build task with prior stage context
  const stageTask = buildStageTask(stageType, task, planPath);

  // 5. Segment executors
  const segments = segmentExecutors(stageConfig.executors);
  const allOutputs: ExecutorOutput[] = [];
  const isSynthesizer = (idx: number) =>
    stageConfig.executors.length > 1 && idx === stageConfig.executors.length - 1;

  // 5b. Initialize progress tracking — scope under ralph-{slug}/progress/ for ralph callers (§7)
  const slugMatch = path.basename(planPath).match(/^ralph-(.+)\.md$/);
  const slugHint = slugMatch ? slugMatch[1] : null;
  const progress = new StageProgress(
    stageType,
    resolvedExecutors.map(r => ({ index: r.index, executor: r.executor })),
    cwd,
    slugHint,
  );
  _activeProgress = progress;

  // 6. Execute segments in order
  for (const segment of segments) {
    // Build task for this segment — synthesizer gets prior outputs as context
    const segmentHasSynthesizer = segment.executors.some(e => isSynthesizer(e.index));
    let segmentTask = stageTask;
    if (segmentHasSynthesizer && allOutputs.length > 0) {
      segmentTask = stageTask + '\n\n---\n\n## Executor Outputs to Synthesize\n\nIMPORTANT: Merge ALL outputs below into a single comprehensive result. Do NOT drop, deprioritize, or omit any items from any executor. Every AC, finding, unit, or requirement from every executor must appear in your synthesis. If executors produce conflicting items, include both and note the conflict — do not resolve by dropping one side.\n\n' +
        allOutputs.map((o, i) => `### Output ${i + 1} (${o.system_prompt} via ${o.preset}/${o.model})\n\n${o.result}`).join('\n\n');
    }

    if (segment.parallel && segment.executors.length > 1) {
      // Parallel dispatch
      const promises = segment.executors.map(({ executor, index }) => {
        const resolved = resolvedExecutors[index];
        return runExecutorWithProgress(
          executor, index, resolved.preset, resolved.composedPrompt,
          segmentTask, allowedTools, cwd, debugEnabled, progress,
        );
      });

      const results = await Promise.allSettled(promises);

      let hasFatal = false;
      for (const r of results) {
        const dr = r.status === 'fulfilled' ? r.value : { executor_index: -1, status: 'rejected' as const, error: (r as any).reason?.message || 'Unknown error' };
        if (dr.status === 'fulfilled' && dr.result !== undefined) {
          const resolved = resolvedExecutors[dr.executor_index];
          allOutputs.push({
            executor_index: dr.executor_index,
            preset: resolved.executor.preset,
            model: resolved.executor.model,
            system_prompt: resolved.executor.system_prompt,
            result: dr.result,
          });
        } else {
          await vcpLog(cwd, {
            source: 'stage-runner', event: 'executor_failed', decision: 'warn',
            details: `executor=${dr.executor_index} error=${dr.error}`,
          }, debugEnabled);
          hasFatal = true;
        }
      }

      if (hasFatal && allOutputs.length === 0) {
        progress.writeTerminal('error');
        emitError('dispatch', 'All parallel executors in segment failed', 2, allOutputs);
      }
    } else {
      // Sequential dispatch (single executor)
      const { executor, index } = segment.executors[0];
      const resolved = resolvedExecutors[index];
      const result = await runExecutorWithProgress(
        executor, index, resolved.preset, resolved.composedPrompt,
        segmentTask, allowedTools, cwd, debugEnabled, progress,
      );

      if (result.status === 'fulfilled' && result.result !== undefined) {
        allOutputs.push({
          executor_index: result.executor_index,
          preset: resolved.executor.preset,
          model: resolved.executor.model,
          system_prompt: resolved.executor.system_prompt,
          result: result.result,
        });
      } else {
        await vcpLog(cwd, {
          source: 'stage-runner', event: 'executor_failed', decision: 'warn',
          details: `executor=${index} error=${result.error}`,
        }, debugEnabled);
        // If synthesizer failed, that's fatal
        if (isSynthesizer(index)) {
          progress.writeTerminal('error');
          emitError('synthesis', `Synthesizer executor failed: ${result.error}`, 2, allOutputs);
        }
      }
    }
  }

  // 7. Determine synthesis
  let synthesis: string | null = null;
  if (stageConfig.executors.length > 1) {
    // Last output is the synthesizer's output
    const synthOutput = allOutputs.find(o => o.executor_index === stageConfig.executors.length - 1);
    synthesis = synthOutput?.result || null;
  } else if (allOutputs.length === 1) {
    // Single executor — its output IS the synthesis
    synthesis = allOutputs[0].result;
  }

  await vcpLog(cwd, {
    source: 'stage-runner', event: 'complete', decision: 'info',
    details: `stage=${stageType} outputs=${allOutputs.length} synthesis=${synthesis ? 'yes' : 'no'}`,
  }, debugEnabled);

  progress.writeTerminal('success');
  emitSuccess(stageType, allOutputs, synthesis);
}

// ─── ENTRY POINT ────────────────────────────────────────────────────────────

// Module-level progress reference for fatal handler access
let _activeProgress: StageProgress | null = null;

// Guard: only run main when invoked directly (not imported by tests)
const isDirectRun = process.argv[1]?.endsWith('stage-runner.ts');
if (isDirectRun) {
  main().catch(async (err) => {
    _activeProgress?.writeTerminal('fatal');
    const msg = (err as Error).message;
    const debug = await isDebugEnabled().catch(() => false);
    await vcpLog(process.cwd(), {
      source: 'stage-runner', event: 'fatal', decision: 'error', details: msg,
    }, debug).catch(() => {});
    console.error(`[stage-runner] Fatal: ${msg}`);
    process.exit(2);
  });
}

// ─── EXPORTS (for testing) ─────────────────────────────────────────────────

export {
  buildStageTask,
  segmentExecutors,
  parseArgs,
  dispatchExecutor,
  runExecutorWithProgress,
  emitSuccess,
  emitError,
  killSiblings,
  StageProgress,
  main,
  type ExecutorOutput,
  type StageRunnerOutput,
  type StageRunnerError,
  type StageProgressState,
  type ExecutorProgress,
  type Segment,
  type StageRunnerArgs,
  type DispatchResult,
};
