import { z } from 'zod'
import { ClientErrorSchema, GenerationSchema, IdentifierSchema, sameGeneration } from './common'

/**
 * What the server accepts as account input (REST API spec, 2026-10-22). It lives here so the form
 * and the contract judge input by the same numbers. Nothing is trimmed or case-folded: input that
 * does not fit is refused, not repaired.
 */
export const LOGIN_ID_RULE = { min: 3, max: 32 } as const
export const PASSWORD_RULE = { signUpMin: 15, max: 128 } as const

const LOGIN_ID_PATTERN = new RegExp(`^[A-Za-z0-9_]{${LOGIN_ID_RULE.min},${LOGIN_ID_RULE.max}}$`)

/** Length as the user sees it: one per character, not per UTF-16 unit (an emoji is one). */
export const characterCount = (value: string): number => Array.from(value).length

/** English letters, digits and `_` only. Spaces, including surrounding ones, make it invalid. */
export const isValidLoginId = (value: string): boolean => LOGIN_ID_PATTERN.test(value)

/** Signing in accepts any password the server could have stored. */
export const isValidSignInPassword = (value: string): boolean =>
  characterCount(value) >= 1 && characterCount(value) <= PASSWORD_RULE.max

/** A new password must be long enough; its characters are not restricted. */
export const isValidSignUpPassword = (value: string): boolean =>
  characterCount(value) >= PASSWORD_RULE.signUpMin && characterCount(value) <= PASSWORD_RULE.max

/** An ID that came from the server (user, results): only checked to be present, never re-judged. */
export const LoginIdSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'Login ID must not be blank')

/** An ID the user typed. */
export const LoginIdInputSchema = z
  .string()
  .refine(isValidLoginId, 'Login ID must be 3 to 32 letters, digits or underscores')
export const SignInPasswordSchema = z
  .string()
  .refine(isValidSignInPassword, 'Password must be 1 to 128 characters')
export const SignUpPasswordSchema = z
  .string()
  .refine(isValidSignUpPassword, 'Password must be 15 to 128 characters')

export const AuthUserSchema = z.strictObject({
  userId: IdentifierSchema,
  loginId: LoginIdSchema
})
export type AuthUser = z.infer<typeof AuthUserSchema>

export const CheckLoginIdInputSchema = z.strictObject({ loginId: LoginIdInputSchema })
export type CheckLoginIdInput = z.infer<typeof CheckLoginIdInputSchema>

export const SignInInputSchema = z.strictObject({
  loginId: LoginIdInputSchema,
  password: SignInPasswordSchema
})
export type SignInInput = z.infer<typeof SignInInputSchema>

/** Password confirmation belongs to the UI form and must not cross IPC. */
export const SignUpInputSchema = z.strictObject({
  loginId: LoginIdInputSchema,
  password: SignUpPasswordSchema
})
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
