import { z } from 'zod'
import { ClientErrorSchema, SequenceSchema, TimestampSchema } from './common'

/**
 * The Google Calendar connection, as the calendar tab shows it. Main talks to the server and to
 * the browser; the window only draws this and asks for the few things below. No token, address
 * or server wording is in it.
 */

export const GoogleConnectionSchema = z.strictObject({
  /** `reconnect_required`: the server holds a connection it can no longer use. */
  status: z.enum(['active', 'reconnect_required']),
  connectedAt: TimestampSchema,
  /** When the server last imported successfully, or null if it never has. Server time. */
  lastSyncedAt: TimestampSchema.nullable()
})
export type GoogleConnection = z.infer<typeof GoogleConnectionSchema>

/** What the last thing that finished came to, for a line of text. */
export const GOOGLE_OUTCOMES = [
  'connected',
  'synced',
  /** The import was started, but the server did not say it finished in time. */
  'sync_unconfirmed',
  'disconnected',
  /** The consent was not finished before the address expired. */
  'connect_expired',
  'connect_cancelled'
] as const
export const GoogleOutcomeSchema = z.enum(GOOGLE_OUTCOMES)
export type GoogleOutcome = z.infer<typeof GoogleOutcomeSchema>

/**
 * `availability`: `unavailable` when there is no server to ask. `read`: the state of reading the
 * connection from the server. `activity`: what is going on now; only one thing at a time.
 */
export const GoogleConnectionSnapshotSchema = z
  .strictObject({
    /** Rises with every change, so a late snapshot can be told from the current one. */
    revision: SequenceSchema,
    availability: z.enum(['ready', 'unavailable']),
    read: z.enum(['idle', 'loading', 'ready', 'failed']),
    connection: GoogleConnectionSchema.nullable(),
    activity: z.enum(['none', 'authorizing', 'syncing', 'disconnecting']),
    /** While `authorizing`: until when the browser can finish the consent, on this machine's clock. */
    authorizeUntil: TimestampSchema.nullable(),
    outcome: z.strictObject({ kind: GoogleOutcomeSchema, at: TimestampSchema }).nullable(),
    error: ClientErrorSchema.nullable()
  })
  .refine((state) => (state.activity === 'authorizing') === (state.authorizeUntil !== null), {
    message: 'A deadline goes with, and only with, waiting for the consent'
  })
export type GoogleConnectionSnapshot = z.infer<typeof GoogleConnectionSnapshotSchema>

export const GOOGLE_ACTIONS = [
  'refresh',
  'connect',
  'cancel_connect',
  'sync',
  'disconnect'
] as const
export const GoogleActionSchema = z.enum(GOOGLE_ACTIONS)
export type GoogleAction = z.infer<typeof GoogleActionSchema>

export const GoogleCommandRequestSchema = z.strictObject({ action: GoogleActionSchema })
export type GoogleCommandRequest = z.infer<typeof GoogleCommandRequestSchema>

export const GoogleConnectionEventSchema = z.strictObject({
  type: z.literal('google.state_changed'),
  snapshot: GoogleConnectionSnapshotSchema
})
export type GoogleConnectionEvent = z.infer<typeof GoogleConnectionEventSchema>
