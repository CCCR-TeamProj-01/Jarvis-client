import { z } from 'zod'
import { ClientErrorSchema, GenerationSchema, SequenceSchema } from '../../shared/contracts/common'
import { VadEventSchema } from '../../shared/contracts/speech'
import { VadPolicySchema } from './vad-policy'

/** Main -> worker. PCM is signed 16-bit little endian, mono, 16 kHz. */
export const VadWorkerRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('init'), modelPath: z.string().min(1) }),
  z.strictObject({
    type: z.literal('start'),
    generation: GenerationSchema,
    firstSample: SequenceSchema,
    policy: VadPolicySchema
  }),
  z.strictObject({
    type: z.literal('pcm'),
    startSample: SequenceSchema,
    audio: z.custom<Uint8Array>((value) => value instanceof Uint8Array)
  }),
  z.strictObject({ type: z.literal('stop') })
])
export type VadWorkerRequest = z.infer<typeof VadWorkerRequestSchema>

/** Worker -> Main. */
export const VadWorkerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('event'), event: VadEventSchema }),
  z.strictObject({ type: z.literal('error'), error: ClientErrorSchema })
])
export type VadWorkerMessage = z.infer<typeof VadWorkerMessageSchema>

export const VAD_SAMPLE_RATE_HZ = 16_000
