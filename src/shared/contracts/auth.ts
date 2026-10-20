import { z } from 'zod'
import { ClientErrorSchema, GenerationSchema, IdentifierSchema, sameGeneration } from './common'

/** Transport checks only. Character/length policy will be agreed with the server. No normalization. */
export const LoginIdSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'Login ID must not be blank')
export const PasswordSchema = z.string().min(1)

export const AuthUserSchema = z.strictObject({
  userId: IdentifierSchema,
  loginId: LoginIdSchema
})
export type AuthUser = z.infer<typeof AuthUserSchema>

export const CheckLoginIdInputSchema = z.strictObject({ loginId: LoginIdSchema })
export type CheckLoginIdInput = z.infer<typeof CheckLoginIdInputSchema>

export const SignInInputSchema = z.strictObject({
  loginId: LoginIdSchema,
  password: PasswordSchema
})
export type SignInInput = z.infer<typeof SignInInputSchema>

/** Password confirmation belongs to the UI form and must not cross IPC. */
export const SignUpInputSchema = SignInInputSchema
export type SignUpInput = z.infer<typeof SignUpInputSchema>

/** Main owns this generation and checks the sender and current generation before handling input. */
export const AuthRequestContextSchema = z.strictObject({
  requestId: IdentifierSchema,
  generation: GenerationSchema
})
export type AuthRequestContext = z.infer<typeof AuthRequestContextSchema>

export const CheckLoginIdRequestSchema = z.strictObject({
  ...AuthRequestContextSchema.shape,
  input: CheckLoginIdInputSchema
})
export type CheckLoginIdRequest = z.infer<typeof CheckLoginIdRequestSchema>

export const SignInRequestSchema = z.strictObject({
  ...AuthRequestContextSchema.shape,
  input: SignInInputSchema
})
export type SignInRequest = z.infer<typeof SignInRequestSchema>

export const SignUpRequestSchema = z.strictObject({
  ...AuthRequestContextSchema.shape,
  input: SignUpInputSchema
})
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>

/** Unavailability is an error Result, never an available/duplicate answer. */
export const CheckLoginIdResultSchema = z.strictObject({
  loginId: LoginIdSchema,
  available: z.boolean()
})
export type CheckLoginIdResult = z.infer<typeof CheckLoginIdResultSchema>

export const SignUpResultSchema = z.strictObject({ loginId: LoginIdSchema })
export type SignUpResult = z.infer<typeof SignUpResultSchema>

export const SignedInAuthSnapshotSchema = z.strictObject({
  phase: z.literal('signed_in'),
  generation: GenerationSchema,
  user: AuthUserSchema
})

export const AuthSnapshotSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('checking'), generation: GenerationSchema, user: z.null() }),
  z.strictObject({ phase: z.literal('signed_out'), generation: GenerationSchema, user: z.null() }),
  SignedInAuthSnapshotSchema
])
export type AuthSnapshot = z.infer<typeof AuthSnapshotSchema>

/** A login may succeed for this run even if saving its recovery credential fails. */
export const CredentialPersistenceSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('stored') }),
  z.strictObject({
    status: z.literal('unavailable'),
    error: ClientErrorSchema.extend({ code: z.literal('credential_unavailable') })
  })
])
export const SignInResultSchema = z.strictObject({
  snapshot: SignedInAuthSnapshotSchema,
  persistence: CredentialPersistenceSchema
})
export type SignInResult = z.infer<typeof SignInResultSchema>

export const AuthEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('auth.state_changed'), snapshot: AuthSnapshotSchema }),
  z.strictObject({
    type: z.literal('auth.error'),
    generation: GenerationSchema,
    requestId: IdentifierSchema.nullable(),
    error: ClientErrorSchema
  })
])
export type AuthEvent = z.infer<typeof AuthEventSchema>

/** Compare the captured request, not just its login ID (including A -> B -> A changes). */
export function isCurrentAuthRequest(
  request: AuthRequestContext,
  current: AuthRequestContext
): boolean {
  return (
    request.requestId === current.requestId &&
    sameGeneration(request.generation, current.generation)
  )
}
