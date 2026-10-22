import { describe, expect, it } from 'vitest'
import {
  AuthSnapshotSchema,
  AuthUserSchema,
  CheckLoginIdInputSchema,
  CheckLoginIdRequestSchema,
  SignInInputSchema,
  SignInResultSchema,
  SignUpInputSchema,
  SignUpRequestSchema,
  characterCount,
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

  it('rejects an empty password and keeps a password exactly as typed', () => {
    expect(SignInInputSchema.safeParse({ loginId: 'tester', password: '' }).success).toBe(false)
    const input = { loginId: 'Tester', password: ' example-password ' }
    expect(SignInInputSchema.parse(input)).toEqual(input)
    expect(
      SignUpInputSchema.parse({ loginId: 'Tester', password: ' 앞뒤 공백도 그대로 쓰는 비밀번호 ' })
    ).toEqual({
      loginId: 'Tester',
      password: ' 앞뒤 공백도 그대로 쓰는 비밀번호 '
    })
  })

  describe('login ID rule', () => {
    const accepted = ['abc', 'Jarvis_User', 'a_1', '_', 'x'.repeat(3), 'a'.repeat(32), '123']
    const refused = [
      'ab',
      'a'.repeat(33),
      ' jarvis',
      'jarvis ',
      'jar vis',
      'jarvis\n',
      'jarvis-user',
      'jarvis.user',
      '자비스유저',
      'jarvis유저',
      'jarvis@example',
      'ｊａｒｖｉｓ'
    ]

    it.each(accepted)('accepts %j to type, check and sign in', (loginId) => {
      expect(CheckLoginIdInputSchema.safeParse({ loginId }).success).toBe(loginId.length >= 3)
      expect(SignInInputSchema.safeParse({ loginId, password: 'x' }).success).toBe(
        loginId.length >= 3
      )
    })

    it.each(refused)(
      'refuses %j everywhere the user types an ID, without repairing it',
      (loginId) => {
        expect(CheckLoginIdInputSchema.safeParse({ loginId }).success).toBe(false)
        expect(SignInInputSchema.safeParse({ loginId, password: 'x' }).success).toBe(false)
        expect(SignUpInputSchema.safeParse({ loginId, password: 'x'.repeat(15) }).success).toBe(
          false
        )
      }
    )

    it('does not re-judge an ID that came from the server', () => {
      expect(
        AuthUserSchema.safeParse({ userId: 'u1', loginId: 'legacy-name.with.dots' }).success
      ).toBe(true)
      expect(AuthUserSchema.safeParse({ userId: 'u1', loginId: ' ' }).success).toBe(false)
    })
  })

  describe('password rule', () => {
    const sign = (password: string) =>
      SignInInputSchema.safeParse({ loginId: 'tester', password }).success
    const register = (password: string) =>
      SignUpInputSchema.safeParse({ loginId: 'tester', password }).success

    it('counts characters as the user sees them', () => {
      expect(characterCount('abc')).toBe(3)
      expect(characterCount('한글')).toBe(2)
      expect(characterCount('😀😀')).toBe(2)
      expect(characterCount('')).toBe(0)
    })

    it('needs 15 to 128 characters to sign up', () => {
      expect(register('x'.repeat(14))).toBe(false)
      expect(register('x'.repeat(15))).toBe(true)
      expect(register('x'.repeat(128))).toBe(true)
      expect(register('x'.repeat(129))).toBe(false)
      expect(register('')).toBe(false)
    })

    it('accepts any characters, including spaces, symbols, Korean and emoji', () => {
      expect(register(' '.repeat(15))).toBe(true)
      expect(register('!@#$%^&*()_+-=[]{}|;:\'",.<>/?`~')).toBe(true)
      expect(register('가나다라마바사아자차카타파하가')).toBe(true)
      expect(register('😀'.repeat(15))).toBe(true)
      // 15 characters, although 30 UTF-16 units: the length is what the user sees.
      expect(register('😀'.repeat(14))).toBe(false)
      expect(register('😀'.repeat(128))).toBe(true)
      expect(register('😀'.repeat(129))).toBe(false)
    })

    it('needs only 1 to 128 characters to sign in, so an existing account is never locked out', () => {
      expect(sign('')).toBe(false)
      expect(sign('x')).toBe(true)
      expect(sign('demo1234')).toBe(true)
      expect(sign('x'.repeat(128))).toBe(true)
      expect(sign('x'.repeat(129))).toBe(false)
      expect(sign(' ')).toBe(true)
    })
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
