/**
 * A2A-lite (Agent-to-Agent lite) protocol types.
 *
 * Uses 'id' field (not 'task_id') for forward compatibility with full A2A spec (#76).
 * Optional 'context_id' for future A2A grouping.
 *
 * Zero imports from other type modules (C21).
 */

export type TaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'auth_required';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface DataPart {
  type: 'data';
  mimeType: string;
  data: string;
}

export interface FilePart {
  type: 'file';
  name: string;
  mimeType?: string;
  bytes: string;
}

export type Part = TextPart | DataPart | FilePart;

export interface Message {
  role: 'user' | 'agent';
  parts: Part[];
}

export interface TaskError {
  code: string;
  message: string;
  error_id?: string;
}

/**
 * A task in the A2A-lite protocol.
 * Uses 'id' (not 'task_id') for forward compat with full A2A spec.
 * Optional 'context_id' for future grouping support.
 */
export interface Task {
  id: string;
  context_id?: string;
  status: TaskStatus;
  messages: Message[];
  result?: Message;
  error?: TaskError;
  created_at: string;
  updated_at: string;
}

export interface TaskSendRequest {
  message: Message;
}

export interface TaskSendResponse {
  task: Task;
}

export interface TaskStatusResponse {
  task: Task;
}

export interface ErrorResponse {
  error: TaskError;
}
