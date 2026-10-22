import { z } from 'zod'
import type { Result } from '../../shared/contracts/common'
import type { ServerClient, ServerResult } from '../connection/server-client'
import type { CommandResult } from './command-result'
import { ServerCommandSchema } from './server-command'
import type { ServerCommand } from './server-command'

/**
 * One pending item. A well-formed item becomes a command. One that is not well-formed but still
 * names itself is refused (the server is waiting for an answer to it); one that does not is skipped,
 * because there is nothing to answer.
 */
export type PendingItem =
  | { kind: 'command'; command: ServerCommand }
  | { kind: 'malformed'; commandId: string; attemptNo: number }

export interface PendingPage {
  items: PendingItem[]
  /** How long the server asks to wait before the next poll, when it says. */
  pollAfterMs?: number
}

/** What happened to a result that was sent. */
export type SendOutcome =
  | { kind: 'stored' }
  /** The server will never take this result (not ours, already different, or malformed). */
  | { kind: 'refused' }
  /** It may be tried again later. */
  | { kind: 'retry'; retryAfterMs?: number }

export interface CommandApiPort {
  pending(
    limit: number,
    signal?: AbortSignal
  ): Promise<Result<PendingPage> & { retryAfterMs?: number }>
  send(commandId: string, result: CommandResult, signal?: AbortSignal): Promise<SendOutcome>
}

const PendingEnvelopeSchema = z.looseObject({
  items: z.array(z.unknown()),
  poll_after_ms: z.number().int().nonnegative().optional()
})
const ItemIdsSchema = z.looseObject({
  command_id: z.number().refine((value) => Number.isSafeInteger(value) && value >= 0),
  attempt_no: z.number().int().positive().default(1)
})
const ReceiptSchema = z.looseObject({})

/** Answers the server gives when a result can never be accepted: do not send it again. */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([403, 404, 409, 422])

/** The device's commands over REST. It never logs or returns a command's arguments. */
export class CommandApi implements CommandApiPort {
  constructor(private readonly client: ServerClient) {}

  async pending(
    limit: number,
    signal?: AbortSignal
  ): Promise<Result<PendingPage> & { retryAfterMs?: number }> {
    const response = await this.client.request({
      method: 'GET',
      path: '/device/commands/pending',
      query: { limit },
      response: PendingEnvelopeSchema,
      signal
    })
    if (!response.ok)
      return { ok: false, error: response.error, retryAfterMs: response.detail.retryAfterMs }
    const items: PendingItem[] = []
    for (const raw of response.value.items) {
      const command = ServerCommandSchema.safeParse(raw)
      if (command.success) {
        items.push({ kind: 'command', command: command.data })
        continue
      }
      const ids = ItemIdsSchema.safeParse(raw)
      if (ids.success)
        items.push({
          kind: 'malformed',
          commandId: String(ids.data.command_id),
          attemptNo: ids.data.attempt_no
        })
    }
    return { ok: true, value: { items, pollAfterMs: response.value.poll_after_ms } }
  }

  async send(commandId: string, result: CommandResult, signal?: AbortSignal): Promise<SendOutcome> {
    // The ID comes from the journal, which only holds numbers the server sent; check anyway.
    if (!/^\d{1,16}$/.test(commandId)) return { kind: 'refused' }
    const response: ServerResult<unknown> = await this.client.request({
      method: 'POST',
      path: `/commands/${commandId}/results`,
      body: result,
      response: ReceiptSchema,
      signal
    })
    if (response.ok) return { kind: 'stored' }
    if (
      response.detail.delivery === 'responded' &&
      REFUSED_STATUSES.has(response.detail.status ?? 0)
    )
      return { kind: 'refused' }
    return { kind: 'retry', retryAfterMs: response.detail.retryAfterMs }
  }
}
