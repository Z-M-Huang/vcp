/**
 * Session health state machine types.
 *
 * 4-state health model:
 *   starting -> ready (warmup success)
 *   ready -> dead (error detected)
 *   dead -> ready (respawn success)
 *   dead -> failed (auth/config error OR rate limit exceeded: 3 respawns in 5-min window)
 *
 * respawn_timestamps uses number[] for sliding-window rate limiting (C23).
 * Zero imports from other type modules (C21).
 */

/**
 * Session health states.
 *
 * - 'starting': Server has started, warming up V2 Agent SDK session
 * - 'ready': Session is live and serving requests
 * - 'dead': Session encountered an error, auto-respawn will be attempted
 * - 'failed': Terminal state — auth/config error or respawn rate limit exceeded
 */
export type SessionHealth = 'starting' | 'ready' | 'dead' | 'failed';

export interface SessionState {
  health: SessionHealth;
  uptime_ms: number;
  started_at: string;
  last_activity_at: string;
  task_count: number;
  /** Timestamps of respawn attempts (Unix ms) for sliding-window rate limiting */
  respawn_timestamps: number[];
  /** Error message if health is 'dead' or 'failed' */
  error?: string;
}

export interface SessionConfig {
  /** Name of the preset to use for this session (required) */
  preset_name: string;
  /** Working directory for the session (default: process.cwd()) */
  cwd?: string;
  /** Idle timeout in minutes before auto-shutdown (default: 60) */
  idle_timeout_minutes: number;
  /** Comma-separated list of allowed tools for the V2 Agent SDK session */
  allowed_tools?: string;
  /** Per-task timeout in milliseconds (default: 300000 = 5 minutes) */
  task_timeout_ms?: number;
}

export interface SessionStartupOutput {
  status: 'ready';
  port: number;
  token: string;
}
