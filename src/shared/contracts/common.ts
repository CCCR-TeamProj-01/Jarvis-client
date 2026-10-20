import { z } from 'zod'

export const IdentifierSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), 'Identifiers must not have surrounding whitespace')

export const SequenceSchema = z.number().int().nonnegative()
export const TimestampSchema = z.number().nonnegative()

export const GenerationSchema = z.strictObject({
  sessionId: IdentifierSchema,
  revision: SequenceSchema
})
export type Generation = z.infer<typeof GenerationSchema>

export const ClientErrorSchema = z.strictObject({
  code: z.enum([
    'permission_denied',
    'device_unavailable',
    'unsupported',
    'invalid_input',
    'not_found',
    'cancelled',
    'expired',
    'conflict',
    'unavailable',
    'internal'
  ]),
  message: z.string().min(1)
})
export type ClientError = z.infer<typeof ClientErrorSchema>

export type Result<T> = { ok: true; value: T } | { ok: false; error: ClientError }
export type Unsubscribe = () => void

export function resultSchema<S extends z.ZodType>(value: S) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: ClientErrorSchema })
  ])
}

/** Binary payloads stay out of JSON messages and logs; accepts cloned cross-realm byte arrays. */
export const AudioBytesSchema = z.custom<Uint8Array>(
  (value) =>
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]',
  { error: 'Expected Uint8Array audio bytes', abort: true }
)

export function sameGeneration(left: Generation, right: Generation): boolean {
  return left.sessionId === right.sessionId && left.revision === right.revision
}
