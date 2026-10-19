import { z } from 'zod'
import {
  GenerationSchema,
  IdentifierSchema,
  SequenceSchema,
  TimestampSchema,
  sameGeneration
} from './common'
import type { Generation } from './common'

export const HAND_LANDMARK_NAMES = [
  'wrist',
  'thumb_cmc',
  'thumb_mcp',
  'thumb_ip',
  'thumb_tip',
  'index_mcp',
  'index_pip',
  'index_dip',
  'index_tip',
  'middle_mcp',
  'middle_pip',
  'middle_dip',
  'middle_tip',
  'ring_mcp',
  'ring_pip',
  'ring_dip',
  'ring_tip',
  'pinky_mcp',
  'pinky_pip',
  'pinky_dip',
  'pinky_tip'
] as const

/** Unmirrored camera coordinates; z is wrist-relative engine depth, not screen depth. */
export const HandLandmarkSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  z: z.number().finite()
})
export const HandObservationSchema = z.strictObject({
  handId: IdentifierSchema,
  handedness: z.enum(['left', 'right', 'unknown']),
  confidence: z.number().min(0).max(1),
  landmarks: z.array(HandLandmarkSchema).length(HAND_LANDMARK_NAMES.length)
})
export type HandObservation = z.infer<typeof HandObservationSchema>

export const HandTrackingFrameSchema = z
  .strictObject({
    generation: GenerationSchema,
    sequence: SequenceSchema,
    /** Media Renderer performance.now() clock, also used by the frame age checker. */
    capturedAtMs: TimestampSchema,
    hands: z.array(HandObservationSchema).max(2)
  })
  .refine(
    (frame) => new Set(frame.hands.map((hand) => hand.handId)).size === frame.hands.length,
    'Hand IDs must be unique within a frame'
  )
export type HandTrackingFrame = z.infer<typeof HandTrackingFrameSchema>

export const HandTrackingEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('tracking.frame'), frame: HandTrackingFrameSchema }),
  z.strictObject({
    type: z.literal('tracking.lost'),
    generation: GenerationSchema,
    sequence: SequenceSchema,
    reason: z.enum(['no_hand', 'stale', 'engine_error', 'permission_revoked'])
  })
])
export type HandTrackingEvent = z.infer<typeof HandTrackingEventSchema>

/** Global desktop logical coordinates; negative monitor positions are valid. */
export const DesktopPointSchema = z.strictObject({
  displayId: IdentifierSchema,
  x: z.number().finite(),
  y: z.number().finite()
})
export type DesktopPoint = z.infer<typeof DesktopPointSchema>

export const DisplayBoundsSchema = z.strictObject({
  displayId: IdentifierSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
  scaleFactor: z.number().positive()
})
export type DisplayBounds = z.infer<typeof DisplayBoundsSchema>

export const GestureSnapshotSchema = z
  .strictObject({
    phase: z.enum(['off', 'tracking', 'lost', 'suspended']),
    generation: GenerationSchema.nullable(),
    activeHandId: IdentifierSchema.nullable(),
    displayId: IdentifierSchema.nullable()
  })
  .refine(
    (snapshot) => (snapshot.phase === 'off') === (snapshot.generation === null),
    'A non-off gesture mode requires its generation'
  )
export type GestureSnapshot = z.infer<typeof GestureSnapshotSchema>

export const ActiveHandPolicySchema = z.enum(['left', 'right', 'auto_lock'])
export type ActiveHandPolicy = z.infer<typeof ActiveHandPolicySchema>

export const InputObservationSchema = z.strictObject({
  status: z.enum(['observed', 'dispatched', 'unknown']),
  position: DesktopPointSchema.optional()
})
export type InputObservation = z.infer<typeof InputObservationSchema>

/** Call in the capture clock domain; Main independently checks generation and sequence. */
export function canUseTrackingFrame(
  frame: HandTrackingFrame,
  options: {
    generation: Generation
    afterSequence: number | null
    nowMs: number
    maxAgeMs: number
  }
): boolean {
  const age = options.nowMs - frame.capturedAtMs
  return (
    sameGeneration(frame.generation, options.generation) &&
    (options.afterSequence === null || frame.sequence > options.afterSequence) &&
    Number.isFinite(age) &&
    Number.isFinite(options.maxAgeMs) &&
    age >= 0 &&
    options.maxAgeMs >= 0 &&
    age <= options.maxAgeMs
  )
}
