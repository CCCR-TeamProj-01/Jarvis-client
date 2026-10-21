import { z } from 'zod'
import { ClientErrorSchema, GenerationSchema } from '../../shared/contracts/common'
import { PcmChunkSchema, WakeWordEventSchema } from '../../shared/contracts/speech'

export const WAKE_SAMPLE_RATE = 16_000
export const WAKE_KEYWORD = '자비스'

export const WakeWorkerRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('init'),
    modelPath: z.string().min(1),
    libraryPath: z.string().min(1)
  }),
  z.strictObject({ type: z.literal('start'), generation: GenerationSchema }),
  z.strictObject({
    type: z.literal('pcm'),
    chunk: PcmChunkSchema.refine(
      (c) => c.format.sampleRateHz === WAKE_SAMPLE_RATE && c.audio.byteLength <= 32_000
    )
  }),
  z.strictObject({ type: z.literal('stop') })
])
export type WakeWorkerRequest = z.infer<typeof WakeWorkerRequestSchema>
export const WakeWorkerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({
    type: z.literal('consumed'),
    generation: GenerationSchema,
    sequence: z.number().int().nonnegative()
  }),
  z.strictObject({ type: z.literal('event'), event: WakeWordEventSchema }),
  z.strictObject({ type: z.literal('error'), error: ClientErrorSchema })
])
export type WakeWorkerMessage = z.infer<typeof WakeWorkerMessageSchema>
