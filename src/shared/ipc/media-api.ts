import { z } from 'zod'
import {
  ClientErrorSchema,
  GenerationSchema,
  IdentifierSchema,
  resultSchema
} from '../contracts/common'
import type { Unsubscribe } from '../contracts/common'
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

export const MediaCommandSchema = z.discriminatedUnion('type', [
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
    z.strictObject({ type: z.literal('audio.pcm'), chunk: PcmChunkSchema }),
    z.strictObject({ type: z.literal('audio.utterance'), utterance: CompletedUtteranceSchema }),
    z.strictObject({ type: z.literal('audio.playback'), event: PlaybackEventSchema })
  ])
  .refine(
    (event) =>
      !(
        (event.type === 'camera.state' || event.type === 'audio.capture.state') &&
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
