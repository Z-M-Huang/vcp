/**
 * Chatroom type definitions for multi-model deliberation.
 *
 * Zero imports from other type modules (C21).
 */

export interface ChatroomParticipant {
  /** Optional system prompt for participant persona (e.g., 'code-reviewer', 'planner'). If omitted, uses general-purpose behavior. */
  system_prompt?: string;
  preset: string;
  model: string;
}

export interface ChatroomConfig {
  participants: ChatroomParticipant[];
  max_rounds: number;
}
