import { z } from 'zod'
import { IdentifierSchema, SequenceSchema } from './common'

/** What a status pill looks like. The words come with it; the overlay renders and decides nothing. */
export const OverlayKindSchema = z.enum([
  'listening',
  'thinking',
  'speaking',
  'done',
  'error',
  'pointing',
  'holding',
  'searching',
  'clicking',
  'paused'
])
export type OverlayKind = z.infer<typeof OverlayKindSchema>

export const OverlayPillSchema = z.strictObject({
  /** Changes whenever the pill is a new one, so a repeated look can be told from a continuing one. */
  id: IdentifierSchema,
  kind: OverlayKindSchema,
  text: z.string().min(1).max(120),
  /** The pill carries a stop button; only these ever receive the pointer. */
  stoppable: z.boolean()
})
export type OverlayPill = z.infer<typeof OverlayPillSchema>

/** Two places on screen: the voice and result pill at the top, the gesture pill in a corner. */
export const OverlayStateSchema = z.strictObject({
  revision: SequenceSchema,
  voice: OverlayPillSchema.nullable(),
  gesture: OverlayPillSchema.nullable()
})
export type OverlayState = z.infer<typeof OverlayStateSchema>

export const EMPTY_OVERLAY: OverlayState = { revision: 0, voice: null, gesture: null }
