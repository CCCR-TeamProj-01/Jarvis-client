import { z } from 'zod'
import type { ClientError, Result } from '../../shared/contracts/common'
import { idempotencyKeyFor, newUlid } from '../connection/ids'
import type { ServerClient, ServerResult } from '../connection/server-client'
import { clientError } from '../connection/server-errors'
import type { AssistantPort, AssistantReply, AssistantRespondOptions, TurnContext } from './ports'

export interface ServerAssistantOptions {
  client: ServerClient
  /** Monotonic milliseconds, for the overall wait. */
  now?(): number
  /** Resolves after `ms`, or early when aborted. Injected so waiting can be tested. */
  wait?(ms: number, signal?: AbortSignal): Promise<void>
  random?(size: number): Uint8Array
  /** The longest the adapter itself waits for one answer; the conversation's own limit applies first. */
  maxWaitMs?: number
}

const ConversationResponse = z.looseObject({ conversation_id: z.string().min(1) })
const SubmitResponse = z.looseObject({ poll_after_ms: z.number().int().positive().optional() })
const RequestStatusResponse = z.looseObject({
  processing_status: z.string(),
  error_code: z.string().nullable().optional(),
  assistant_messages: z
    .array(z.looseObject({ content: z.string().nullable().optional() }))
    .optional(),
  commands: z.array(z.looseObject({})).optional()
})
type RequestStatus = z.infer<typeof RequestStatusResponse>

const DEFAULT_MAX_WAIT_MS = 60_000
const POLL_MIN_MS = 500
const POLL_MAX_MS = 1_000
const BACKOFF_MAX_MS = 10_000
/** Failures in a row that end the wait; one passing error must not cost the answer. */
const MAX_POLL_FAILURES = 5
const MAX_LOST_ANSWERS = 2
const MAX_BUSY_RETRIES = 5
const BUSY_WAIT_MS = 1_000
/** Remembered local → server pairings; a conversation lasts minutes, so this is generous. */
const REMEMBERED = 64

const failure = (error: ClientError): { ok: false; error: ClientError } => ({ ok: false, error })

const serverFailed = (): ClientError => ({
  code: 'unavailable',
  message: '서버가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'
})

const defaultWait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

/**
 * The server answering what the user typed: it opens a server conversation per local one, submits
 * each input as a request and polls for the answer. Commands the server plans for this device are
 * not run here yet (that is the command poller's job), and voice is not sent: this carries text.
 *
 * The ID of the server conversation and of each server request live only in this object. A late
 * answer, after the conversation asked to stop, is simply not waited for.
 */
export class ServerAssistant implements AssistantPort {
  private readonly conversations = new Map<string, Promise<Result<string>>>()
  private readonly requests = new Map<string, string>()
  private readonly now: () => number
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly random: (size: number) => Uint8Array

  constructor(private readonly options: ServerAssistantOptions) {
    this.now = options.now ?? (() => performance.now())
    this.wait = options.wait ?? defaultWait
    this.random = options.random ?? ((size) => crypto.getRandomValues(new Uint8Array(size)))
  }

  async respond(
    turn: TurnContext,
    text: string,
    options?: AssistantRespondOptions
  ): Promise<Result<AssistantReply>> {
    const signal = options?.signal
    if (signal?.aborted) return failure(clientError('cancelled'))
    const requestId = this.requestIdFor(turn)
    const started = this.now()

    const submitted = await this.submit(turn.conversationId, requestId, text, signal)
    if (!submitted.ok) return submitted
    return this.awaitAnswer(requestId, submitted.value, started, signal)
  }

  // --- conversation ----------------------------------------------------------------------------

  /** One server conversation per local one; a failed creation is forgotten so it can be retried. */
  private conversationFor(localId: string, signal?: AbortSignal): Promise<Result<string>> {
    const known = this.conversations.get(localId)
    if (known) return known
    const creating = this.create(localId, signal).then((result) => {
      if (!result.ok) this.conversations.delete(localId)
      return result
    })
    this.conversations.set(localId, creating)
    this.trim(this.conversations)
    return creating
  }

  private async create(localId: string, signal?: AbortSignal): Promise<Result<string>> {
    // The same key on every attempt: a lost answer returns the conversation made the first time.
    const idempotencyKey = idempotencyKeyFor('conversation', localId)
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.options.client.request({
        method: 'POST',
        path: '/conversations',
        idempotencyKey,
        response: ConversationResponse,
        ...signalOf(signal)
      })
      if (result.ok) return { ok: true, value: result.value.conversation_id }
      if (!this.mayRepeat(result) || attempt >= MAX_LOST_ANSWERS || signal?.aborted)
        return failure(result.error)
      await this.wait(300, signal)
    }
  }

  // --- submitting ------------------------------------------------------------------------------

  private async submit(
    localConversationId: string,
    requestId: string,
    text: string,
    signal?: AbortSignal
  ): Promise<Result<number | undefined>> {
    let lost = 0
    let busy = 0
    let recreated = false
    for (;;) {
      const conversation = await this.conversationFor(localConversationId, signal)
      if (!conversation.ok) return conversation
      const result = await this.options.client.request({
        method: 'POST',
        path: `/conversations/${encodeURIComponent(conversation.value)}/messages`,
        body: { request_id: requestId, input_method: 'text', content: text },
        response: SubmitResponse,
        ...signalOf(signal)
      })
      if (result.ok) return { ok: true, value: result.value.poll_after_ms }
      if (signal?.aborted) return failure(clientError('cancelled'))

      // The same request ID and text again: the server treats it as the request it already has.
      if (this.mayRepeat(result) && lost < MAX_LOST_ANSWERS) {
        lost += 1
        await this.wait(300, signal)
        continue
      }
      // The previous request of this conversation is still being worked on.
      if (result.detail.serverCode === 'CONVERSATION_BUSY' && busy < MAX_BUSY_RETRIES) {
        busy += 1
        await this.wait(BUSY_WAIT_MS, signal)
        continue
      }
      // The server no longer has the conversation: start a new one, once.
      if (result.error.code === 'not_found' && !recreated) {
        recreated = true
        this.conversations.delete(localConversationId)
        continue
      }
      return failure(result.error)
    }
  }

  /** A failure with no answer may have been processed; repeating is safe because of the IDs. */
  private mayRepeat(result: Extract<ServerResult<unknown>, { ok: false }>): boolean {
    return result.detail.delivery === 'no_response'
  }

  // --- waiting for the answer ------------------------------------------------------------------

  private async awaitAnswer(
    requestId: string,
    hint: number | undefined,
    started: number,
    signal?: AbortSignal
  ): Promise<Result<AssistantReply>> {
    const maxWait = this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    let delay = Math.min(Math.max(hint ?? POLL_MIN_MS, POLL_MIN_MS), POLL_MAX_MS)
    let failures = 0
    for (;;) {
      await this.wait(delay, signal)
      if (signal?.aborted) return failure(clientError('cancelled'))
      if (this.now() - started > maxWait) return failure(clientError('expired'))

      const result = await this.options.client.request({
        method: 'GET',
        path: `/requests/${encodeURIComponent(requestId)}`,
        response: RequestStatusResponse,
        ...signalOf(signal)
      })
      if (!result.ok) {
        if (result.error.code === 'cancelled') return failure(result.error)
        if (!this.transient(result.error)) return failure(result.error)
        failures += 1
        if (failures >= MAX_POLL_FAILURES) return failure(result.error)
        delay = Math.min(
          Math.max(delay * 2, result.detail.retryAfterMs ?? 0, POLL_MIN_MS),
          BACKOFF_MAX_MS
        )
        continue
      }
      failures = 0
      const settled = this.reply(result.value)
      if (settled) return settled
      delay = Math.min(delay + 100, POLL_MAX_MS)
    }
  }

  private transient(error: ClientError): boolean {
    return (
      error.code === 'unavailable' || error.code === 'rate_limited' || error.code === 'internal'
    )
  }

  /** The answer once the server is done, or null while it is still working. */
  private reply(status: RequestStatus): Result<AssistantReply> | null {
    switch (status.processing_status) {
      case 'success': {
        const parts = (status.assistant_messages ?? [])
          .map((message) => (message.content ?? '').trim())
          .filter((content) => content !== '')
        const hasCommands = (status.commands ?? []).length > 0
        // The commands themselves reach this device through the command poller, not this reply.
        if (parts.length === 0)
          return hasCommands
            ? { ok: true, value: { text: '요청을 처리했어요.' } }
            : failure(clientError('internal'))
        return { ok: true, value: { text: parts.join('\n') } }
      }
      case 'rejected':
        return failure({ code: 'permission_denied', message: '이 요청은 처리할 수 없어요.' })
      case 'failed':
        return failure(serverFailed())
      default:
        // queued, processing, or a state this client does not know yet: keep waiting.
        return null
    }
  }

  // --- identifiers -----------------------------------------------------------------------------

  /** One server request ID per turn, the same on every attempt of that turn. */
  private requestIdFor(turn: TurnContext): string {
    const key = `${turn.conversationId}:${turn.requestId}`
    const known = this.requests.get(key)
    if (known) return known
    const created = `req_${newUlid(Date.now(), this.random)}`
    this.requests.set(key, created)
    this.trim(this.requests)
    return created
  }

  private trim(map: Map<string, unknown>): void {
    while (map.size > REMEMBERED) {
      const oldest = map.keys().next().value
      if (oldest === undefined) return
      map.delete(oldest)
    }
  }
}

const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {})
