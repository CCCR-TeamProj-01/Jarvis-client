import { z } from 'zod'
import { ClientErrorSchema, SequenceSchema } from './common'
import { HandLandmarkSchema, HAND_LANDMARK_NAMES } from './gesture'
import { IdentifierSchema } from './common'
import { HAND_PREVIEW_MAX_BYTES, HAND_PREVIEW_MAX_SIDE } from '../ipc/media-api'
import { AudioBytesSchema } from './common'

/**
 * What the recognition view shows: the camera picture with the hands the app sees on it, and how it
 * judges them. The judgement is the one the cursor control makes, from the same code and the same
 * thresholds, so what is on the screen is what the control would do. Nothing here is sent to the
 * server or kept.
 */

export const PointingReasonSchema = z.enum(['pointing', 'index_short', 'finger_open', 'no_measure'])
export type PointingReasonValue = z.infer<typeof PointingReasonSchema>

export const ReachSchema = z.strictObject({
  index: z.number(),
  middle: z.number(),
  ring: z.number(),
  pinky: z.number()
})
export type Reach = z.infer<typeof ReachSchema>

export const HandAnalysisSchema = z.strictObject({
  handId: IdentifierSchema,
  handedness: z.enum(['left', 'right', 'unknown']),
  confidence: z.number().min(0).max(1),
  /** The hand the cursor control would follow. */
  active: z.boolean(),
  landmarks: z.array(HandLandmarkSchema).length(HAND_LANDMARK_NAMES.length),
  /** Thumb–index distance over hand size; null if the hand could not be measured. */
  pinch: z.number().nullable(),
  pinched: z.boolean(),
  /** How far each finger reaches; null if the hand could not be measured. */
  reach: ReachSchema.nullable(),
  pointing: z.boolean(),
  reason: PointingReasonSchema,
  /** For `finger_open`: the finger that is not folded. */
  openFinger: z.enum(['middle', 'ring', 'pinky']).nullable()
})
export type HandAnalysis = z.infer<typeof HandAnalysisSchema>

/** The numbers the judgement uses, so the view can show how far a value is from its limit. */
export const ThresholdsSchema = z.strictObject({
  pinchEnter: z.number(),
  pinchExit: z.number(),
  indexEnter: z.number(),
  indexKeep: z.number(),
  othersEnter: z.number(),
  othersKeep: z.number()
})
export type Thresholds = z.infer<typeof ThresholdsSchema>

/** `source`: who runs the tracking it shows, the view itself or the cursor control. */
export const DiagnosticsSnapshotSchema = z.strictObject({
  /** Rises with every change, so a late snapshot can be told from the current one. */
  revision: SequenceSchema,
  availability: z.enum(['ready', 'unavailable']),
  state: z.enum(['off', 'starting', 'on', 'failed']),
  source: z.enum(['own', 'control']).nullable(),
  /** Camera pictures are coming. */
  preview: z.boolean(),
  error: ClientErrorSchema.nullable(),
  thresholds: ThresholdsSchema
})
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotSchema>

export const DiagnosticsPictureSchema = z.strictObject({
  width: z.number().int().min(16).max(HAND_PREVIEW_MAX_SIDE),
  height: z.number().int().min(16).max(HAND_PREVIEW_MAX_SIDE),
  jpeg: AudioBytesSchema.refine(
    (bytes) => bytes.byteLength > 0 && bytes.byteLength <= HAND_PREVIEW_MAX_BYTES,
    'A picture must be non-empty and small'
  )
})
export type DiagnosticsPicture = z.infer<typeof DiagnosticsPictureSchema>

export const DiagnosticsFrameSchema = z.strictObject({
  sequence: SequenceSchema,
  hands: z.array(HandAnalysisSchema).max(2),
  /** Frames the hand tracking has been giving each second lately; null until it can be told. */
  fps: z.number().nonnegative().nullable(),
  /** The picture the hands were found on, when one was made for this frame. */
  picture: DiagnosticsPictureSchema.nullable()
})
export type DiagnosticsFrame = z.infer<typeof DiagnosticsFrameSchema>

export const DiagnosticsCommandRequestSchema = z.strictObject({
  action: z.enum(['start', 'stop'])
})
export type DiagnosticsCommandRequest = z.infer<typeof DiagnosticsCommandRequestSchema>

export const DiagnosticsEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('gesture_diagnostics.state_changed'),
    snapshot: DiagnosticsSnapshotSchema
  }),
  z.strictObject({ type: z.literal('gesture_diagnostics.frame'), frame: DiagnosticsFrameSchema })
])
export type DiagnosticsEvent = z.infer<typeof DiagnosticsEventSchema>
