/**
 * Command protocol for the pipeline driver state machine.
 *
 * The driver (pipeline-driver.ts) outputs one command per `next` call.
 * The executor (SKILL.md) executes the command via Claude Code tools,
 * then reports back via `report --result-file <path>`.
 *
 * Discriminant field: 'action'
 * Zero imports from other type modules to prevent circular deps.
 */

// ─── Base Types ──────────────────────────────────────────────────────────────

/** Fields present on every command. */
export interface CommandBase {
  /** Unique ID for correlation + replay. Format: `cmd-{timestamp}-{random}`. */
  command_id: string;
  /** Monotonic counter. Executor rejects commands with stale versions. */
  state_version: number;
  /** Discriminated union tag. */
  action: string;
}

// ─── Task Management ─────────────────────────────────────────────────────────

export interface CreateTeamCmd extends CommandBase {
  action: 'create_team';
  team_name: string;
}

export interface DeleteTeamCmd extends CommandBase {
  action: 'delete_team';
  team_name: string;
}

export interface CreateTaskCmd extends CommandBase {
  action: 'create_task';
  subject: string;
  description: string;
  activeForm: string;
}

export interface UpdateTaskCmd extends CommandBase {
  action: 'update_task';
  taskId: string;
  status?: 'in_progress' | 'completed';
  /** For progressive enrichment and task description rewrites. */
  description?: string;
  activeForm?: string;
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
}

export interface ListTasksCmd extends CommandBase {
  action: 'list_tasks';
}

export interface GetTaskCmd extends CommandBase {
  action: 'get_task';
  taskId: string;
}

// ─── Agent Dispatch ──────────────────────────────────────────────────────────

export interface SpawnAgentCmd extends CommandBase {
  action: 'spawn_agent';
  /** e.g., "general-purpose", "dev-buddy:implementer" */
  subagent_type: string;
  name: string;
  model?: string;
  /** Path to temp file with full prompt (avoids shell arg size limits). */
  prompt_file: string;
}

export interface SpawnTeammateCmd extends CommandBase {
  action: 'spawn_teammate';
  subagent_type: string;
  /** Teammate name (e.g., "technical-analyst"). */
  name: string;
  /** Pipeline team name. */
  team_name: string;
  model?: string;
  prompt_file: string;
}

export interface SpawnBackgroundCmd extends CommandBase {
  action: 'spawn_background';
  command: string;
  timeout_ms: number;
  /** For API review stages: path to review-guidelines.md. */
  system_prompt_file?: string;
  /** Links background task to a pipeline stage for tracking. */
  stage_index?: number;
}

export interface WaitForTaskCmd extends CommandBase {
  action: 'wait_for_task';
  task_id: string;
  timeout_ms: number;
  /** If true, re-poll when TaskOutput returns still_running. */
  poll_on_still_running: boolean;
  /** Max poll attempts before escalating. Default 3. */
  max_poll_attempts: number;
}

// ─── Team Communication ──────────────────────────────────────────────────────

export interface SendMessageCmd extends CommandBase {
  action: 'send_message';
  recipient: string;
  /** Path to temp file with message content. */
  content_file: string;
  summary: string;
}

export interface ReceiveMessagesCmd extends CommandBase {
  action: 'receive_messages';
  // Executor drains auto-delivered messages and reports summaries.
}

export interface ShutdownTeammateCmd extends CommandBase {
  action: 'shutdown_teammate';
  recipient: string;
  /** Default 2. Non-responsive after retries → continue pipeline. */
  max_retries: number;
}

// ─── User Interaction ────────────────────────────────────────────────────────

export interface AskUserCmd extends CommandBase {
  action: 'ask_user';
  question: string;
  options?: Array<{ label: string; description: string }>;
  /** Why this question is being asked (shown as context). */
  context?: string;
}

export interface ShowStatusCmd extends CommandBase {
  action: 'show_status';
  message: string;
}

// ─── File Operations ─────────────────────────────────────────────────────────

export interface ReadFileCmd extends CommandBase {
  action: 'read_file';
  path: string;
}

export interface WriteFileCmd extends CommandBase {
  action: 'write_file';
  path: string;
  content_file: string;
  /** When true, this file signals completion (e.g., manifest). */
  write_last?: boolean;
}

export interface WriteMultiFileCmd extends CommandBase {
  action: 'write_multi_file';
  /** Section files written first, in order. */
  files: Array<{ path: string; content_file: string }>;
  /** Manifest path — written LAST to signal completion. */
  manifest_path: string;
  manifest_content_file: string;
}

// ─── Control Flow ────────────────────────────────────────────────────────────

export interface ParallelBatchCmd extends CommandBase {
  action: 'parallel_batch';
  /** Commands to execute in parallel (e.g., specialist spawns). */
  commands: PipelineCommand[];
}

export interface NoopCmd extends CommandBase {
  action: 'noop';
  /** Describes the internal action the driver completed. */
  message: string;
}

export interface DoneCmd extends CommandBase {
  action: 'done';
  summary: string;
  terminal_state: TerminalState;
  terminal_reason?: string;
}

export interface EscalateCmd extends CommandBase {
  action: 'escalate';
  error: string;
  context: string;
  recovery_options?: Array<{ label: string; description: string }>;
}

export interface PauseCmd extends CommandBase {
  action: 'pause';
  reason: string;
  /** What the user must do to resume the pipeline. */
  resume_condition: string;
}

// ─── Union Type ──────────────────────────────────────────────────────────────

export type PipelineCommand =
  | CreateTeamCmd
  | DeleteTeamCmd
  | CreateTaskCmd
  | UpdateTaskCmd
  | ListTasksCmd
  | GetTaskCmd
  | SpawnAgentCmd
  | SpawnTeammateCmd
  | SpawnBackgroundCmd
  | WaitForTaskCmd
  | SendMessageCmd
  | ReceiveMessagesCmd
  | ShutdownTeammateCmd
  | AskUserCmd
  | ShowStatusCmd
  | ReadFileCmd
  | WriteFileCmd
  | WriteMultiFileCmd
  | ParallelBatchCmd
  | NoopCmd
  | DoneCmd
  | EscalateCmd
  | PauseCmd;

/** All valid action strings for exhaustive switch matching. */
export type ActionType = PipelineCommand['action'];

/** Distributive Omit — preserves discriminated union narrowing for emitCommand. */
type DistributeOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
export type CommandPayload = DistributeOmit<PipelineCommand, 'command_id' | 'state_version'>;

// ─── Terminal States ─────────────────────────────────────────────────────────

export type TerminalState =
  | 'completed'
  | 'plan_rejected'
  | 'code_rejected'
  | 'implementation_failed'
  | 'max_iterations_reached'
  | 'user_aborted';

// ─── Report Protocol ─────────────────────────────────────────────────────────

export interface CommandReport {
  /** Must match the command being acknowledged. */
  command_id: string;
  ok: boolean;
  /** Path to temp file with result payload (for large results). */
  result_file?: string;
  error?: string;

  // ── Action-specific result fields ──

  /** Returned by create_task. */
  taskId?: string;
  /** Returned by spawn_background. */
  task_id?: string;
  /** Returned by ask_user. */
  answer?: string;
  /** Returned by receive_messages. */
  messages?: Array<{ from: string; summary: string }>;
  /** Returned by list_tasks. */
  tasks?: Array<{ id: string; subject: string; status: string; blockedBy: string[] }>;
  /** Returned by get_task. */
  task?: { id: string; subject: string; description: string; status: string; blockedBy: string[] };
  /** Returned by read_file. */
  content?: string;

  // ── Interruption ──

  /** True if user sent a message mid-pipeline. */
  interrupted?: boolean;
  user_message?: string;

  // ── Background task completion ──

  exit_code?: number;
  /** "complete" | "error" | "timeout" */
  event?: string;
  /** True if background task is still running (triggers re-poll). */
  still_running?: boolean;

  // ── Parallel batch ──

  /** Per-command results for parallel_batch. Keyed by command_id. */
  batch_results?: Record<string, CommandReport>;
}

// ─── Command Factory Helpers ─────────────────────────────────────────────────

let commandCounter = 0;

/** Generate a unique command ID. */
export function makeCommandId(): string {
  commandCounter++;
  return `cmd-${Date.now()}-${commandCounter}`;
}
