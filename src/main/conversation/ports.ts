import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import type { LocalExecutionOptions } from '../ports'

/** Identifies one request inside a conversation, so late answers can be told apart and dropped. */
export interface TurnContext {
  conversationId: string
  requestId: string
}

export interface AssistantReply {
  /** What to show; also the fallback when the audio cannot be produced or played. */
  text: string
  audio?: { mimeType: string; bytes: Uint8Array }
  /** The assistant decided the conversation is over. */
  endConversation?: boolean
}

/**
 * The server's answer to something the user said or typed. It does not matter to the server (or
 * to this boundary) whether the words arrived by voice or by keyboard.
 */
export interface AssistantPort {
  respond(
    turn: TurnContext,
    text: string,
    options?: LocalExecutionOptions
  ): Promise<Result<AssistantReply>>
}

export type TurnModality = 'speech' | 'text'

export interface ConversationSnapshot {
  phase: 'idle' | 'active'
  conversationId: string | null
  /** Advances with every change, so anything older is recognisably stale. */
  version: number
  request: { requestId: string | null; phase: 'idle' | 'processing' }
}

/** Words for the user. Audio never appears here. */
export type ConversationNotice =
  | { type: 'user'; requestId: string; text: string; modality: TurnModality }
  | { type: 'assistant'; requestId: string; text: string }
  | { type: 'problem'; error: ClientError }

export interface TurnResult {
  requestId: string
  reply: AssistantReply
}

/** Whether a conversation may start right now (signed in, not paused). */
export interface StartGate {
  check(): Result<void>
}

export interface ConversationPort {
  /** Start a conversation. One already running is returned unchanged. */
  start(): Result<{ conversationId: string }>
  /**
   * Submit what the user said or typed. Starts a conversation if there is none. One request at a
   * time: a second one while the first is being worked on is refused.
   */
  submit(
    input: { text: string; modality: TurnModality },
    options?: LocalExecutionOptions
  ): Promise<Result<TurnResult>>
  /** Keep the conversation from timing out while something (a voice session) is using it. */
  hold(): () => void
  /** End the conversation now: cancel the request in progress and ignore its late answer. */
  end(): Promise<Result<void>>
  isActive(): boolean
  getSnapshot(): ConversationSnapshot
  subscribe(listener: (snapshot: ConversationSnapshot) => void): Unsubscribe
  subscribeNotices(listener: (notice: ConversationNotice) => void): Unsubscribe
}
