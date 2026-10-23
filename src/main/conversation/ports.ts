import type { ResultOutcome } from '../../shared/contracts/interaction'
import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import type { Capability, ToolExecutionReport } from '../../shared/contracts/tools'
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

/** One tool the assistant wants run on this device while it works on a request. */
export interface ToolRequest {
  /** Chosen by the assistant. The same ID is never run twice, so a repeat gets the first result. */
  executionId: string
  /** Not trusted until validated; anything outside the known tools is refused. */
  command: unknown
  /** How long the request stays worth running, counted from the moment it arrives. */
  expiresInMs?: number
  /** The device view it was made against; availability is rechecked right before running anyway. */
  capabilityRevision?: number
}

/**
 * What the assistant can do on this device during one request. It stops working when the request
 * ends: a call after that, or after the conversation was cancelled, is refused without running.
 */
export interface AssistantTools {
  capabilities(): { revision: number; capabilities: Capability[] }
  execute(request: ToolRequest): Promise<ToolExecutionReport>
}

export interface AssistantRespondOptions extends LocalExecutionOptions {
  tools?: AssistantTools
}

/**
 * The server's answer to something the user said or typed. It does not matter to the server (or
 * to this boundary) whether the words arrived by voice or by keyboard.
 */
export interface AssistantPort {
  respond(
    turn: TurnContext,
    text: string,
    options?: AssistantRespondOptions
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
  | {
      type: 'tool'
      requestId: string
      executionId: string
      text: string
      ok: boolean
      /** How far it is known to have gone: it happened, was only requested, is not known, or failed. */
      outcome: ResultOutcome
    }
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
    input: {
      text: string
      modality: TurnModality
      /** Reuse an ID already given to this turn (for example to its speech recognition). */
      requestId?: string
    },
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
