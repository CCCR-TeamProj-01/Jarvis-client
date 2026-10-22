import { z } from 'zod'
import { IdentifierSchema, TimestampSchema } from './common'

/**
 * What the user can do with a recommendation; the server records one of these. `snoozed` is "later":
 * the server holds that app combination back for a while. How long a rejection or a snooze holds
 * is the server's rule, not the client's.
 */
export const RECOMMENDATION_RESPONSES = ['approved', 'snoozed', 'rejected', 'dismissed'] as const
export const RecommendationResponseSchema = z.enum(RECOMMENDATION_RESPONSES)
export type RecommendationResponse = z.infer<typeof RecommendationResponseSchema>

export const MAX_RECOMMENDATION_REASON_CHARS = 200
export const MAX_RECOMMENDATION_APP_NAME_CHARS = 100
export const MAX_RECOMMENDATION_TARGETS = 10

export const RecommendationTargetSchema = z.strictObject({
  position: z.number().int().nonnegative(),
  appCode: z.string().min(1).nullable(),
  displayName: z.string().min(1).max(MAX_RECOMMENDATION_APP_NAME_CHARS)
})
export type RecommendationTarget = z.infer<typeof RecommendationTargetSchema>

/**
 * The recommendation on offer, as the window shows it. The text comes from the server and is
 * shown as plain text only. Nothing here runs anything: approving asks the server, and the
 * commands it creates arrive like any other command.
 */
export const RecommendationCardSchema = z.strictObject({
  recommendationId: IdentifierSchema,
  reason: z.string().min(1).max(MAX_RECOMMENDATION_REASON_CHARS),
  targets: z.array(RecommendationTargetSchema).min(1).max(MAX_RECOMMENDATION_TARGETS),
  /** Display only, on this machine's clock. Main enforces the server's deadline itself. */
  expiresAtUnixMs: TimestampSchema,
  /** `responding` while the answer is on its way to the server. */
  phase: z.enum(['offered', 'responding'])
})
export type RecommendationCard = z.infer<typeof RecommendationCardSchema>
