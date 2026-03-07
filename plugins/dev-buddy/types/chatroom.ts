/**
 * Chatroom type definitions for multi-model deliberation.
 *
 * Zero imports from other type modules (C21).
 */

export interface ChatroomParticipant {
  preset: string;
  model: string;
}

export interface ChatroomConfig {
  participants: ChatroomParticipant[];
  max_rounds: number;
}
