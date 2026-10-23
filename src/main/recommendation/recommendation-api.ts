import { z } from 'zod'
import type { ClientError, Result } from '../../shared/contracts/common'
import {
  MAX_RECOMMENDATION_APP_NAME_CHARS,
  MAX_RECOMMENDATION_REASON_CHARS,
  MAX_RECOMMENDATION_TARGETS
} from '../../shared/contracts/recommendation'
import type { RecommendationAnswer } from '../../shared/contracts/recommendation'
import type { ServerClient } from '../connection/server-client'
import { EmptyResponse } from '../connection/server-client'
import { ServerIdSchema } from '../connection/server-ids'
import { ServerTimeSchema } from '../connection/server-time'

/** One recommendation as the server offers it. */
export interface PendingRecommendation {
  recommendationId: string
  reason: string
  /** The server's deadline, in the server's own clock. */
  expiresAtServerMs: number
  targets: { position: number; appCode: string | null; displayName: string }[]
}

/** What became of an answer to a recommendation. */
export type RespondOutcome =
  | { kind: 'recorded' }
  /** The server will not take an answer for it any more. */
  | {
      kind: 'gone'
      reason: 'expired' | 'already_responded' | 'not_found' | 'target_unavailable'
    }
  | { kind: 'failed'; error: ClientError }

export interface RecommendationApiPort {
  /** The one recommendation to show, or null when there is none. */
  pending(signal?: AbortSignal): Promise<Result<PendingRecommendation | null>>
  respond(
    recommendationId: string,
    answer: RecommendationAnswer,
    signal?: AbortSignal
  ): Promise<RespondOutcome>
}

const TargetSchema = z.looseObject({
  position: z.number().int().nonnegative(),
  app_code: z.string().max(32).nullish(),
  display_name: z.string().trim().min(1).max(MAX_RECOMMENDATION_APP_NAME_CHARS)
})
const PendingSchema = z.looseObject({
  recommendation_id: ServerIdSchema,
  reason: z.string().trim().min(1).max(MAX_RECOMMENDATION_REASON_CHARS),
  expires_at: ServerTimeSchema,
  targets: z.array(TargetSchema).min(1).max(MAX_RECOMMENDATION_TARGETS)
})
/** `200` with a recommendation, or `204` without a body when there is none. */
const PendingAnswerSchema = z.union([PendingSchema, EmptyResponse])
const ReceiptSchema = z.looseObject({})

/** The device's recommendations over REST (the server's spec; not yet answered by a real server). */
export class RecommendationApi implements RecommendationApiPort {
  constructor(private readonly client: ServerClient) {}

  async pending(signal?: AbortSignal): Promise<Result<PendingRecommendation | null>> {
    const response = await this.client.request({
      method: 'GET',
      path: '/recommendations/pending',
      response: PendingAnswerSchema,
      ...(signal ? { signal } : {})
    })
    if (!response.ok) return { ok: false, error: response.error }
    const found = response.value
    if (found === undefined) return { ok: true, value: null }
    return {
      ok: true,
      value: {
        recommendationId: found.recommendation_id,
        reason: found.reason,
        expiresAtServerMs: Date.parse(found.expires_at),
        targets: found.targets
          .map((target) => ({
            position: target.position,
            appCode: target.app_code ?? null,
            displayName: target.display_name
          }))
          .sort((a, b) => a.position - b.position)
      }
    }
  }

  async respond(
    recommendationId: string,
    answer: RecommendationAnswer,
    signal?: AbortSignal
  ): Promise<RespondOutcome> {
    // The ID comes from the server's own answer, which only holds numbers; check anyway.
    if (!/^\d{1,16}$/.test(recommendationId)) {
      return { kind: 'gone', reason: 'not_found' }
    }
    const result = await this.client.request({
      method: 'POST',
      path: `/recommendations/${recommendationId}/responses`,
      body: { response: answer.response, pause_today: answer.pauseToday },
      response: ReceiptSchema,
      ...(signal ? { signal } : {})
    })
    if (result.ok) return { kind: 'recorded' }
    if (result.detail.delivery === 'responded') {
      if (result.detail.status === 410) return { kind: 'gone', reason: 'expired' }
      // Nothing it suggested can be opened here any more (an app was turned off since). The server
      // keeps the card pending, but answering it again would only fail the same way.
      if (result.detail.serverCode === 'RECOMMENDATION_TARGET_UNAVAILABLE')
        return { kind: 'gone', reason: 'target_unavailable' }
      if (result.detail.status === 409) return { kind: 'gone', reason: 'already_responded' }
      if (result.detail.status === 404) return { kind: 'gone', reason: 'not_found' }
    }
    return { kind: 'failed', error: result.error }
  }
}
