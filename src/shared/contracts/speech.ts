import { z } from 'zod'
import {
  AudioBytesSchema,
  ClientErrorSchema,
  GenerationSchema,
  IdentifierSchema,
  SequenceSchema,
  sameGeneration
} from './common'

export const PcmFormatSchema = z.strictObject({
  encoding: z.literal('pcm_s16le'),
  sampleRateHz: z.number().int().positive(),
  channels: z.literal(1)
})
export type PcmFormat = z.infer<typeof PcmFormatSchema>

export const PcmChunkSchema = z
  .strictObject({
    generation: GenerationSchema,
    sequence: SequenceSchema,
    startSample: SequenceSchema,
    format: PcmFormatSchema,
    audio: AudioBytesSchema
  })
  .refine(
    (chunk) => chunk.audio.byteLength > 0 && chunk.audio.byteLength % 2 === 0,
    'PCM chunks need a nonempty whole number of 16-bit samples'
  )
export type PcmChunk = z.infer<typeof PcmChunkSchema>

export const UtteranceRangeSchema = z.strictObject({
  utteranceId: IdentifierSchema,
  generation: GenerationSchema,
  startSample: SequenceSchema,
  sampleCount: z.number().int().positive()
})
export type UtteranceRange = z.infer<typeof UtteranceRangeSchema>

/** Local capture data. Remote protocol/authentication identifiers belong in a later adapter. */
export const CompletedUtteranceSchema = z
  .strictObject({
    ...UtteranceRangeSchema.shape,
    format: PcmFormatSchema,
    audio: AudioBytesSchema
  })
  .refine(
    (utterance) => utterance.audio.byteLength === utterance.sampleCount * 2,
    'Utterance sample count and PCM byte length must match'
  )
export type CompletedUtterance = z.infer<typeof CompletedUtteranceSchema>

export const AudioCaptureStartSchema = z.strictObject({
  generation: GenerationSchema,
  leaseId: IdentifierSchema,
  format: PcmFormatSchema
})
export type AudioCaptureStart = z.infer<typeof AudioCaptureStartSchema>

export const WakeWordEventSchema = z
  .strictObject({
    generation: GenerationSchema,
    keyword: z.string().min(1),
    keywordStartSample: SequenceSchema,
    keywordEndSample: SequenceSchema,
    detectedAtSample: SequenceSchema
  })
  .refine(
    (event) =>
      event.keywordStartSample < event.keywordEndSample &&
      event.keywordEndSample <= event.detectedAtSample,
    'Wake-word boundaries must precede their detection position'
  )
export type WakeWordEvent = z.infer<typeof WakeWordEventSchema>

export const VadEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('speech.started'),
    generation: GenerationSchema,
    startSample: SequenceSchema
  }),
  z.strictObject({
    type: z.literal('speech.completed'),
    range: UtteranceRangeSchema,
    reason: z.enum(['silence', 'max_duration'])
  }),
  z.strictObject({
    type: z.literal('speech.empty'),
    generation: GenerationSchema,
    reason: z.enum(['timeout', 'silence'])
  })
])
export type VadEvent = z.infer<typeof VadEventSchema>

export const PlaybackRequestSchema = z.strictObject({
  playbackId: IdentifierSchema,
  generation: GenerationSchema,
  mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i),
  audio: AudioBytesSchema.refine(
    (audio) => audio.byteLength > 0,
    'Playback audio must not be empty'
  )
})
export type PlaybackRequest = z.infer<typeof PlaybackRequestSchema>

const PlaybackIdentityFields = {
  playbackId: IdentifierSchema,
  generation: GenerationSchema
}
export const PlaybackEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...PlaybackIdentityFields, type: z.literal('playback.started') }),
  z.strictObject({ ...PlaybackIdentityFields, type: z.literal('playback.ended') }),
  z.strictObject({ ...PlaybackIdentityFields, type: z.literal('playback.stopped') }),
  z.strictObject({
    ...PlaybackIdentityFields,
    type: z.literal('playback.failed'),
    error: ClientErrorSchema
  })
])
export type PlaybackEvent = z.infer<typeof PlaybackEventSchema>

export const SpeechPhaseSchema = z.enum([
  'idle',
  'wake_detected',
  'awaiting_speech',
  'listening',
  'transcribing',
  'processing',
  'speaking',
  'awaiting_followup'
])
export const SpeechSnapshotSchema = z
  .strictObject({
    phase: SpeechPhaseSchema,
    generation: GenerationSchema.nullable()
  })
  .refine(
    (snapshot) => (snapshot.phase === 'idle') === (snapshot.generation === null),
    'An active speech session requires its generation'
  )
export type SpeechSnapshot = z.infer<typeof SpeechSnapshotSchema>

/** A PCM gap ends the current collection; it must not be silently stitched into an utterance. */
export function isContiguousPcm(previous: PcmChunk, next: PcmChunk): boolean {
  return (
    sameGeneration(previous.generation, next.generation) &&
    next.sequence === previous.sequence + 1 &&
    next.startSample === previous.startSample + previous.audio.byteLength / 2 &&
    next.format.sampleRateHz === previous.format.sampleRateHz &&
    next.format.encoding === previous.format.encoding &&
    next.format.channels === previous.format.channels
  )
}

export function utteranceDurationMs(utterance: CompletedUtterance): number {
  return (utterance.sampleCount / utterance.format.sampleRateHz) * 1000
}
