import { describe, expect, it } from 'vitest'
import {
  AuthSnapshotSchema,
  CheckLoginIdRequestSchema,
  SignInInputSchema,
  SignInResultSchema,
  SignUpRequestSchema,
  isCurrentAuthRequest
} from '../../src/shared/contracts/auth'
import { ClientSnapshotSchema, UiCommandSchema } from '../../src/shared/contracts/interaction'
import { authGeneration, authUser, clientSnapshot } from '../fixtures/contracts'

const context = { requestId: 'auth-request-1', generation: authGeneration }

describe('authentication inputs', () => {
  it.each(['', ' ', '\t\n'])('rejects blank login ID %j', (loginId) => {
    expect(SignInInputSchema.safeParse({ loginId, password: 'example-password' }).success).toBe(
      false
    )
  })

  it('rejects an empty password without trimming or normalizing credentials', () => {
    expect(SignInInputSchema.safeParse({ loginId: 'tester', password: '' }).success).toBe(false)
    const input = { loginId: ' Tester ', password: ' example-password ' }
    expect(SignInInputSchema.parse(input)).toEqual(input)
  })

  it.each(['passwordConfirmation', 'confirmPassword', 'token', 'userId', 'phase'])(
    'rejects %s in a signup request',
    (field) => {
      const request = { ...context, input: { loginId: 'tester', password: 'example-password' } }
      expect(SignUpRequestSchema.safeParse(request).success).toBe(true)
      expect(
        SignUpRequestSchema.safeParse({
          ...request,
          input: { ...request.input, [field]: 'injected' }
        }).success
      ).toBe(false)
    }
  )

  it('requires a request ID and generation for duplicate checks', () => {
    const request = { ...context, input: { loginId: 'tester' } }
    expect(CheckLoginIdRequestSchema.safeParse(request).success).toBe(true)
    expect(CheckLoginIdRequestSchema.safeParse({ input: request.input }).success).toBe(false)
    expect(CheckLoginIdRequestSchema.safeParse({ ...request, authenticated: true }).success).toBe(
      false
    )
  })
})

describe('public authentication state', () => {
  it('requires a verified user only in signed_in state', () => {
    expect(
      AuthSnapshotSchema.safeParse({
        phase: 'signed_in',
        generation: authGeneration,
        user: authUser
      }).success
    ).toBe(true)
    expect(
      AuthSnapshotSchema.safeParse({ phase: 'signed_in', generation: authGeneration, user: null })
        .success
    ).toBe(false)
    for (const phase of ['checking', 'signed_out']) {
      expect(
        AuthSnapshotSchema.safeParse({ phase, generation: authGeneration, user: null }).success
      ).toBe(true)
      expect(
        AuthSnapshotSchema.safeParse({ phase, generation: authGeneration, user: authUser }).success
      ).toBe(false)
    }
  })

  it.each(['password', 'passwordHash', 'accessToken', 'refreshToken', 'credential'])(
    'rejects public user secret %s',
    (field) => {
      expect(
        AuthSnapshotSchema.safeParse({
          phase: 'signed_in',
          generation: authGeneration,
          user: { ...authUser, [field]: 'secret' }
        }).success
      ).toBe(false)
    }
  )

  it('distinguishes a successful login from failure to persist it', () => {
    const snapshot = { phase: 'signed_in', generation: authGeneration, user: authUser }
    expect(
      SignInResultSchema.safeParse({ snapshot, persistence: { status: 'stored' } }).success
    ).toBe(true)
    expect(
      SignInResultSchema.safeParse({ snapshot, persistence: { status: 'unavailable' } }).success
    ).toBe(false)
    expect(
      SignInResultSchema.safeParse({
        snapshot,
        persistence: {
          status: 'unavailable',
          error: { code: 'credential_unavailable', message: 'Protected storage unavailable' }
        }
      }).success
    ).toBe(true)
    expect(
      SignInResultSchema.safeParse({
        snapshot: { ...snapshot, phase: 'signed_out', user: null },
        persistence: { status: 'stored' }
      }).success
    ).toBe(false)
  })

  it.each(['checking', 'signed_out'] as const)(
    'keeps %s snapshots on authentication screens',
    (phase) => {
      const snapshot = clientSnapshot({
        auth: { phase, generation: authGeneration, user: null },
        screen: 'login'
      })
      expect(ClientSnapshotSchema.safeParse(snapshot).success).toBe(true)
      expect(ClientSnapshotSchema.safeParse({ ...snapshot, screen: 'signup' }).success).toBe(true)
      for (const screen of [
        'conversation',
        'gesture',
        'input',
        'result',
        'confirmation',
        'settings'
      ]) {
        expect(ClientSnapshotSchema.safeParse({ ...snapshot, screen }).success).toBe(false)
      }
    }
  )

  it('keeps authenticated offline state separate from logout', () => {
    expect(
      ClientSnapshotSchema.safeParse(clientSnapshot({ connection: 'offline', screen: 'input' }))
        .success
    ).toBe(true)
    expect(UiCommandSchema.safeParse({ type: 'auth.open', screen: 'signup' }).success).toBe(true)
    expect(UiCommandSchema.safeParse({ type: 'auth.open', screen: 'settings' }).success).toBe(false)
    expect(
      UiCommandSchema.safeParse({ type: 'auth.open', screen: 'login', authenticated: true }).success
    ).toBe(false)
  })
})

describe('authentication request identity', () => {
  it('drops responses from a previous request even when the login ID returns to the same value', () => {
    const input = { loginId: 'tester' }
    const previous = { ...context, input }
    const latest = { ...context, requestId: 'auth-request-3', input }
    expect(isCurrentAuthRequest(previous, latest)).toBe(false)
    expect(isCurrentAuthRequest(latest, latest)).toBe(true)
  })

  it('drops results after logout or switching authentication sessions', () => {
    expect(
      isCurrentAuthRequest(context, { ...context, generation: { ...authGeneration, revision: 2 } })
    ).toBe(false)
    expect(
      isCurrentAuthRequest(context, {
        ...context,
        generation: { ...authGeneration, sessionId: 'auth-2' }
      })
    ).toBe(false)
  })
})
