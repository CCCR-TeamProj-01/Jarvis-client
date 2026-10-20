import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import type { LocalExecutionOptions, MonotonicClock } from '../ports'
import type {
  AssistantPort,
  AssistantReply,
  ConversationNotice,
  ConversationPort,
  ConversationSnapshot,
  StartGate,
  TurnModality,
  TurnResult
} from './ports'

/** Provisional limits until reference devices and a measurement method are agreed. */
export interface ConversationPolicy {
  /** Upper bound for the assistant to answer one request. */
  responseTimeoutMs: number
  /** A conversation nothing is using ends after this long without activity. */
  idleTimeoutMs: number
}

export const DEFAULT_CONVERSATION_POLICY: ConversationPolicy = {
  responseTimeoutMs: 20_000,
  idleTimeoutMs: 5 * 60_000
}

interface ConversationManagerOptions {
  gate: StartGate
  assistant: AssistantPort
  clock: MonotonicClock
  createId(): string
  /** Returns a cancel function. Injected so timeouts can be tested without real timers. */
  schedule(callback: () => void, delayMs: number): () => void
  policy?: Partial<ConversationPolicy>
}

interface Conversation {
  id: string
  version: number
  abort: AbortController
  requestId: string | null
  holds: number
  cancelIdle: (() => void) | null
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

const IDLE: ConversationSnapshot = {
  phase: 'idle',
  conversationId: null,
  version: 0,
  request: { requestId: null, phase: 'idle' }
}

/**
 * Owns the conversation: its identity, the requests in it and how each one is answered. It is
 * indifferent to how the user's words arrived, so typing and talking share one conversation.
 * Ending it is local and immediate; an answer that comes back afterwards belongs to a
 * conversation that no longer exists and is dropped.
 */
export class ConversationManager implements ConversationPort {
  private readonly policy: ConversationPolicy
  private current: Conversation | null = null
  private snapshot: ConversationSnapshot = IDLE
  /** Versions keep increasing across conversations, so no snapshot ever repeats. */
  private lastVersion = 0
  private readonly listeners = new Set<(snapshot: ConversationSnapshot) => void>()
  private readonly noticeListeners = new Set<(notice: ConversationNotice) => void>()

  constructor(private readonly options: ConversationManagerOptions) {
    this.policy = { ...DEFAULT_CONVERSATION_POLICY, ...options.policy }
  }

  isActive(): boolean {
    return this.current !== null
  }

  getSnapshot(): ConversationSnapshot {
    return structuredClone(this.snapshot)
  }

  subscribe(listener: (snapshot: ConversationSnapshot) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeNotices(listener: (notice: ConversationNotice) => void): Unsubscribe {
    this.noticeListeners.add(listener)
    return () => {
      this.noticeListeners.delete(listener)
    }
  }

  start(): Result<{ conversationId: string }> {
    if (this.current) return { ok: true, value: { conversationId: this.current.id } }
    const gate = this.options.gate.check()
    if (!gate.ok) return gate
    const conversation: Conversation = {
      id: this.options.createId(),
      version: 0,
      abort: new AbortController(),
      requestId: null,
      holds: 0,
      cancelIdle: null
    }
    this.current = conversation
    this.armIdle(conversation)
    this.publish(conversation)
    return { ok: true, value: { conversationId: conversation.id } }
  }

  async submit(
    input: { text: string; modality: TurnModality },
    execution?: LocalExecutionOptions
  ): Promise<Result<TurnResult>> {
    const text = input.text.trim()
    if (text.length === 0) return failure('invalid_input', '내용을 입력해 주세요.')
    if (execution?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const started = this.start()
    if (!started.ok) return started
    const conversation = this.current!
    if (conversation.requestId !== null)
      return failure('conflict', '이전 요청을 처리하고 있어요. 잠시 후 다시 시도해 주세요.')

    const requestId = this.options.createId()
    conversation.requestId = requestId
    this.touch(conversation)
    this.publish(conversation)
    this.notice({ type: 'user', requestId, text, modality: input.modality })

    const reply = await this.ask(conversation, requestId, text, execution)
    // The conversation may have been ended, or another begun, while the assistant was working.
    if (this.current !== conversation) return failure('cancelled', '대화가 종료되었습니다.')
    conversation.requestId = null
    this.touch(conversation)
    if (!reply.ok) {
      this.publish(conversation)
      this.notice({ type: 'problem', error: reply.error })
      return reply
    }
    this.notice({ type: 'assistant', requestId, text: reply.value.text })
    // The assistant may end the conversation; the caller still gets the reply to deliver.
    if (reply.value.endConversation) this.finish(conversation)
    else this.publish(conversation)
    return { ok: true, value: { requestId, reply: reply.value } }
  }

  hold(): () => void {
    const conversation = this.current
    if (!conversation) return () => undefined
    conversation.holds += 1
    conversation.cancelIdle?.()
    conversation.cancelIdle = null
    let released = false
    return () => {
      if (released) return
      released = true
      conversation.holds -= 1
      if (this.current === conversation) this.touch(conversation)
    }
  }

  async end(): Promise<Result<void>> {
    if (this.current) this.finish(this.current)
    return { ok: true, value: undefined }
  }

  // --- internals -------------------------------------------------------------------------------

  private async ask(
    conversation: Conversation,
    requestId: string,
    text: string,
    execution?: LocalExecutionOptions
  ): Promise<Result<AssistantReply>> {
    const limit = new AbortController()
    const forward = () => limit.abort()
    conversation.abort.signal.addEventListener('abort', forward, { once: true })
    execution?.signal?.addEventListener('abort', forward, { once: true })
    let timedOut = false
    const cancelTimer = this.options.schedule(() => {
      timedOut = true
      limit.abort()
    }, this.policy.responseTimeoutMs)
    try {
      return await Promise.race([
        this.options.assistant.respond({ conversationId: conversation.id, requestId }, text, {
          signal: limit.signal,
          deadlineMs: this.options.clock.now() + this.policy.responseTimeoutMs
        }),
        new Promise<Result<never>>((resolve) =>
          limit.signal.addEventListener(
            'abort',
            () =>
              resolve(
                timedOut
                  ? failure('expired', '응답이 너무 오래 걸려 중단했어요.')
                  : failure('cancelled', '요청이 취소되었습니다.')
              ),
            { once: true }
          )
        )
      ])
    } finally {
      cancelTimer()
      conversation.abort.signal.removeEventListener('abort', forward)
      execution?.signal?.removeEventListener('abort', forward)
    }
  }

  private finish(conversation: Conversation): void {
    if (this.current !== conversation) return
    this.current = null
    conversation.cancelIdle?.()
    conversation.cancelIdle = null
    conversation.abort.abort()
    this.snapshot = { ...IDLE, version: ++this.lastVersion }
    this.emit()
  }

  /** Activity restarts the inactivity clock, unless something is holding the conversation open. */
  private touch(conversation: Conversation): void {
    conversation.cancelIdle?.()
    conversation.cancelIdle = null
    this.armIdle(conversation)
  }

  private armIdle(conversation: Conversation): void {
    if (conversation.holds > 0 || conversation.requestId !== null) return
    conversation.cancelIdle = this.options.schedule(
      () => this.finish(conversation),
      this.policy.idleTimeoutMs
    )
  }

  private publish(conversation: Conversation): void {
    if (this.current !== conversation) return
    conversation.version = ++this.lastVersion
    this.snapshot = {
      phase: 'active',
      conversationId: conversation.id,
      version: conversation.version,
      request:
        conversation.requestId === null
          ? { requestId: null, phase: 'idle' }
          : { requestId: conversation.requestId, phase: 'processing' }
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(this.snapshot))
      } catch {
        /* Observers cannot prevent state transitions or other observers. */
      }
    }
  }

  private notice(notice: ConversationNotice): void {
    for (const listener of [...this.noticeListeners]) {
      try {
        listener(notice)
      } catch {
        /* Observers cannot prevent state transitions or other observers. */
      }
    }
  }
}
