import { z } from 'zod'
import {
  AuthSnapshotSchema,
  CheckLoginIdResultSchema,
  SignInResultSchema,
  SignUpResultSchema
} from '../contracts/auth'
import type {
  AuthEvent,
  AuthRequestContext,
  AuthSnapshot,
  CheckLoginIdRequest,
  CheckLoginIdResult,
  SignInRequest,
  SignInResult,
  SignUpRequest,
  SignUpResult
} from '../contracts/auth'
import { resultSchema } from '../contracts/common'
import type { Result, Unsubscribe } from '../contracts/common'

export const AuthSnapshotResponseSchema = resultSchema(AuthSnapshotSchema)
export const CheckLoginIdResponseSchema = resultSchema(CheckLoginIdResultSchema)
export const SignUpResponseSchema = resultSchema(SignUpResultSchema)
export const SignInResponseSchema = resultSchema(SignInResultSchema)
export const SignOutResponseSchema = resultSchema(z.void())

/** UI-only API. Tokens and credential storage never cross this boundary. */
export interface AuthApi {
  checkLoginId(request: CheckLoginIdRequest): Promise<Result<CheckLoginIdResult>>
  signUp(request: SignUpRequest): Promise<Result<SignUpResult>>
  signIn(request: SignInRequest): Promise<Result<SignInResult>>
  /** Retry restoration using Main's protected credential after a transient failure. */
  restore(request: AuthRequestContext): Promise<Result<SignInResult>>
  /** Local invalidation/cleanup must not await the remote logout response. */
  signOut(request: AuthRequestContext): Promise<Result<void>>
  getSnapshot(): Promise<Result<AuthSnapshot>>
  subscribe(listener: (event: AuthEvent) => void): Unsubscribe
}
