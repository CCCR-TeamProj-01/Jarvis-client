import { z } from 'zod'
import {
  AudioBytesSchema,
  ClientErrorSchema,
  GenerationSchema,
  IdentifierSchema,
  SequenceSchema,
  resultSchema
} from '../contracts/common'
import type { Unsubscribe } from '../contracts/common'
import { HandTrackingEventSchema } from '../contracts/gesture'
import { SensorDeviceSchema, SensorKindSchema } from '../contracts/sensors'
import {
  AudioCaptureStartSchema,
  CompletedUtteranceSchema,
  PcmChunkSchema,
  PlaybackEventSchema,
  PlaybackRequestSchema,
  UtteranceRangeSchema
} from '../contracts/speech'

export const CameraStartSchema = z.strictObject({
  generation: GenerationSchema,
  leaseId: IdentifierSchema,
  /** Omitted selects the system default device. */
  deviceId: IdentifierSchema.optional()
})
export type CameraStart = z.infer<typeof CameraStartSchema>

/** Hand tracking runs on the camera stream the sensor layer already opened. */
export const HandTrackingStartSchema = z.strictObject({
  generation: GenerationSchema,
  /** The hand landmark model, read by Main so the page needs no file access of its own. */
  model: AudioBytesSchema.refine((bytes) => bytes.byteLength > 0, 'Model must not be empty'),
  maxFps: z.number().int().min(1).max(60).optional()
})
export type HandTrackingStart = z.infer<typeof HandTrackingStartSchema>

/** The largest preview picture taken and the longest side it may have; it is a small picture for the screen, not the camera's. */
export const HAND_PREVIEW_MAX_BYTES = 200_000
export const HAND_PREVIEW_MAX_SIDE = 640

/**
 * One small JPEG of the camera picture a hand observation came from, produced only while the
 * recognition view is open. `sequence` is the sequence of the observation made from the same picture.
 */
export const HandPreviewSchema = z.strictObject({
  generation: GenerationSchema,
  sequence: SequenceSchema,
  width: z.number().int().min(16).max(HAND_PREVIEW_MAX_SIDE),
  height: z.number().int().min(16).max(HAND_PREVIEW_MAX_SIDE),
  jpeg: AudioBytesSchema.refine(
    (bytes) => bytes.byteLength > 0 && bytes.byteLength <= HAND_PREVIEW_MAX_BYTES,
    'A preview must be a non-empty small picture'
  )
})
export type HandPreview = z.infer<typeof HandPreviewSchema>

export const MediaCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('handtracking.start'), request: HandTrackingStartSchema }),
  /** Starts or stops the preview pictures of a running hand tracking; tracking itself is not affected. */
  z.strictObject({
    type: z.literal('handtracking.preview'),
    generation: GenerationSchema,
    enabled: z.boolean()
  }),
  z.strictObject({ type: z.literal('handtracking.stop'), generation: GenerationSchema }),
  z.strictObject({ type: z.literal('devices.list'), kind: SensorKindSchema }),
  z.strictObject({ type: z.literal('camera.start'), request: CameraStartSchema }),
  z.strictObject({ type: z.literal('camera.stop'), generation: GenerationSchema }),
  z.strictObject({ type: z.literal('audio.capture.start'), request: AudioCaptureStartSchema }),
  z.strictObject({ type: z.literal('audio.capture.stop'), generation: GenerationSchema }),
  z.strictObject({ type: z.literal('audio.buffer.clear'), generation: GenerationSchema }),
  z.strictObject({ type: z.literal('audio.utterance.extract'), range: UtteranceRangeSchema }),
  z.strictObject({ type: z.literal('audio.playback.start'), request: PlaybackRequestSchema }),
  z.strictObject({
    type: z.literal('audio.playback.stop'),
    generation: GenerationSchema,
    playbackId: IdentifierSchema
  })
])
export type MediaCommand = z.infer<typeof MediaCommandSchema>

export const MediaCommandEnvelopeSchema = z.strictObject({
  commandId: IdentifierSchema,
  command: MediaCommandSchema
})
export type MediaCommandEnvelope = z.infer<typeof MediaCommandEnvelopeSchema>

export const MediaEventSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('media.command_result'),
      commandId: IdentifierSchema,
      result: resultSchema(z.null())
    }),
    z.strictObject({
      type: z.literal('media.devices'),
      commandId: IdentifierSchema,
      result: resultSchema(z.array(SensorDeviceSchema))
    }),
    /** Hot-plug notification: the devices of one kind changed. */
    z.strictObject({
      type: z.literal('media.devices_changed'),
      kind: SensorKindSchema,
      devices: z.array(SensorDeviceSchema)
    }),
    z.strictObject({
      type: z.literal('camera.state'),
      generation: GenerationSchema,
      state: z.enum(['started', 'stopped', 'failed']),
      error: ClientErrorSchema.optional()
    }),
    z.strictObject({
      type: z.literal('audio.capture.state'),
      generation: GenerationSchema,
      state: z.enum(['started', 'stopped', 'failed']),
      error: ClientErrorSchema.optional()
    }),
    z.strictObject({ type: z.literal('hand.tracking'), event: HandTrackingEventSchema }),
    z.strictObject({ type: z.literal('hand.preview'), preview: HandPreviewSchema }),
    z.strictObject({
      type: z.literal('handtracking.state'),
      generation: GenerationSchema,
      state: z.enum(['started', 'stopped', 'failed']),
      error: ClientErrorSchema.optional()
    }),
    z.strictObject({ type: z.literal('audio.pcm'), chunk: PcmChunkSchema }),
    z.strictObject({ type: z.literal('audio.utterance'), utterance: CompletedUtteranceSchema }),
    z.strictObject({ type: z.literal('audio.playback'), event: PlaybackEventSchema })
  ])
  .refine(
    (event) =>
      !(
        (event.type === 'camera.state' ||
          event.type === 'audio.capture.state' ||
          event.type === 'handtracking.state') &&
        event.state === 'failed' &&
        event.error === undefined
      ),
    'Failed media lifecycle events require an error'
  )
export type MediaEvent = z.infer<typeof MediaEventSchema>

export interface BootstrapMediaApi {
  readonly platform: string
}

/** Only the trusted Media Renderer receives commands and publishes these allowlisted events. */
export interface MediaApi extends BootstrapMediaApi {
  subscribeCommands(listener: (command: MediaCommandEnvelope) => void): Unsubscribe
  publish(event: MediaEvent): void
}
