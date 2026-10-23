import { z } from 'zod'
import { ClientErrorSchema, SequenceSchema, TimestampSchema } from './common'
import { ReadStateSchema } from './devices'

/**
 * What the user allowed about collecting their app activity, as the settings tab shows it. Main
 * talks to the server and applies a withdrawal on this computer at once; the window only draws this
 * and asks for the few things below. No token and no server wording is in it.
 */

export const CollectionValuesSchema = z.strictObject({
  /** Activity from commands this app ran may be recorded. */
  activity: z.boolean(),
  /** What else runs on the computer may be looked at. Needs `activity`. */
  external: z.boolean()
})
export type CollectionValues = z.infer<typeof CollectionValuesSchema>

export const COLLECTION_FLAGS = ['activity', 'external'] as const
export const CollectionFlagSchema = z.enum(COLLECTION_FLAGS)
export type CollectionFlag = z.infer<typeof CollectionFlagSchema>

/**
 * `settings` is what the server holds, as last read or confirmed; null until it was read.
 * `stopped` is what was withdrawn on this computer and is no longer collected here, whether or not
 * the server has been told: a flag is on only when the server says so and it is not stopped here.
 */
export const COLLECTION_OUTCOMES = ['saved', 'failed', 'unconfirmed'] as const
export const CollectionOutcomeSchema = z.enum(COLLECTION_OUTCOMES)
export type CollectionOutcomeKind = z.infer<typeof CollectionOutcomeSchema>

export const CollectionSnapshotSchema = z.strictObject({
  /** Rises with every change, so a late snapshot can be told from the current one. */
  revision: SequenceSchema,
  availability: z.enum(['ready', 'unavailable']),
  read: ReadStateSchema,
  settings: CollectionValuesSchema.nullable(),
  stopped: CollectionValuesSchema,
  saving: z.boolean(),
  outcome: z
    .strictObject({
      kind: CollectionOutcomeSchema,
      /** The flag that was asked for, and whether it was to be turned on. */
      flag: CollectionFlagSchema,
      on: z.boolean(),
      at: TimestampSchema,
      error: ClientErrorSchema.nullable()
    })
    .nullable(),
  /** Why the settings could not be read. */
  error: ClientErrorSchema.nullable()
})
export type CollectionSnapshot = z.infer<typeof CollectionSnapshotSchema>

export const CollectionCommandRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('refresh') }),
  z.strictObject({ action: z.literal('set'), flag: CollectionFlagSchema, on: z.boolean() })
])
export type CollectionCommandRequest = z.infer<typeof CollectionCommandRequestSchema>

export const CollectionEventSchema = z.strictObject({
  type: z.literal('collection.state_changed'),
  snapshot: CollectionSnapshotSchema
})
export type CollectionEvent = z.infer<typeof CollectionEventSchema>

/** Whether a flag is on now: the server says so and it was not withdrawn here. External also needs activity. */
export function collectionIsOn(
  flag: CollectionFlag,
  settings: CollectionValues | null,
  stopped: CollectionValues
): boolean {
  if (settings === null) return false
  const activity = settings.activity && !stopped.activity
  if (flag === 'activity') return activity
  return activity && settings.external && !stopped.external
}
