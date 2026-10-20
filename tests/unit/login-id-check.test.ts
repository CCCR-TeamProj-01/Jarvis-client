import { describe, expect, it } from 'vitest'
import {
  hasErrors,
  validateSignIn,
  validateSignUp
} from '../../src/renderer/ui/features/auth/auth-form'
import {
  initialLoginIdCheck,
  isLoginIdConfirmed,
  loginIdCheckReducer
} from '../../src/renderer/ui/features/auth/login-id-check'
import type {
  LoginIdCheckAction,
  LoginIdCheckState
} from '../../src/renderer/ui/features/auth/login-id-check'
import { newestAuthSnapshot } from '../../src/renderer/ui/features/auth/use-auth'

const run = (...actions: LoginIdCheckAction[]): LoginIdCheckState =>
  actions.reduce(loginIdCheckReducer, initialLoginIdCheck)

describe('duplicate-check state', () => {
  it('confirms only the exact ID that was answered', () => {
    const state = run(
      { type: 'edit', loginId: 'alice' },
      { type: 'start', token: 1 },
      { type: 'result', token: 1, loginId: 'alice', available: true }
    )
    expect(state.status).toBe('available')
    expect(isLoginIdConfirmed(state, 'alice')).toBe(true)
    expect(isLoginIdConfirmed(state, 'alice ')).toBe(false)
  })

  it('resets the result as soon as the ID is edited', () => {
    const state = run(
      { type: 'edit', loginId: 'alice' },
      { type: 'start', token: 1 },
      { type: 'result', token: 1, loginId: 'alice', available: true },
      { type: 'edit', loginId: 'alic' }
    )
    expect(state).toMatchObject({ status: 'unchecked', loginId: 'alic', activeToken: null })
  })

  it('ignores an old answer after A -> B -> A, even though the ID matches again', () => {
    const state = run(
      { type: 'edit', loginId: 'a' },
      { type: 'start', token: 1 },
      { type: 'edit', loginId: 'b' },
      { type: 'edit', loginId: 'a' },
      { type: 'result', token: 1, loginId: 'a', available: true }
    )
    expect(state.status).toBe('unchecked')
  })

  it('ignores responses that arrive out of order', () => {
    const state = run(
      { type: 'edit', loginId: 'a' },
      { type: 'start', token: 1 },
      { type: 'start', token: 2 },
      { type: 'result', token: 1, loginId: 'a', available: true },
      { type: 'result', token: 2, loginId: 'a', available: false }
    )
    expect(state.status).toBe('taken')
  })

  it('treats a failed check as an error, never as available', () => {
    const state = run(
      { type: 'edit', loginId: 'a' },
      { type: 'start', token: 1 },
      { type: 'failed', token: 1, loginId: 'a', message: '서버 오류' }
    )
    expect(state).toMatchObject({ status: 'error', message: '서버 오류' })
    expect(isLoginIdConfirmed(state, 'a')).toBe(false)
  })

  it('lets the server final decision override an earlier availability', () => {
    const state = run(
      { type: 'edit', loginId: 'a' },
      { type: 'start', token: 1 },
      { type: 'result', token: 1, loginId: 'a', available: true },
      { type: 'taken', loginId: 'a' }
    )
    expect(state.status).toBe('taken')
  })

  it('does not start a check for a blank ID', () => {
    expect(run({ type: 'edit', loginId: '  ' }, { type: 'start', token: 1 }).status).toBe(
      'unchecked'
    )
  })
})

describe('form validation', () => {
  const available = run(
    { type: 'edit', loginId: 'alice' },
    { type: 'start', token: 1 },
    { type: 'result', token: 1, loginId: 'alice', available: true }
  )

  it('requires an ID and a password to sign in', () => {
    expect(hasErrors(validateSignIn({ loginId: ' ', password: '' }))).toBe(true)
    expect(hasErrors(validateSignIn({ loginId: 'alice', password: 'x' }))).toBe(false)
  })

  it('does not trim or alter the password', () => {
    expect(validateSignIn({ loginId: 'alice', password: ' ' })).toEqual({})
  })

  it('requires a confirmed ID, a matching confirmation and non-empty password to sign up', () => {
    const base = { loginId: 'alice', password: 'pw', confirmation: 'pw', check: available }
    expect(validateSignUp(base)).toEqual({})
    expect(validateSignUp({ ...base, check: initialLoginIdCheck }).loginId).toMatch(/중복 확인/)
    expect(validateSignUp({ ...base, confirmation: 'other' }).confirmation).toMatch(/달라요/)
    expect(validateSignUp({ ...base, confirmation: '' }).confirmation).toMatch(/한 번 더/)
    expect(validateSignUp({ ...base, loginId: 'alice2' }).loginId).toMatch(/중복 확인/)
  })

  it('reports a taken ID distinctly', () => {
    const taken = run(
      { type: 'edit', loginId: 'alice' },
      { type: 'start', token: 1 },
      { type: 'result', token: 1, loginId: 'alice', available: false }
    )
    expect(
      validateSignUp({ loginId: 'alice', password: 'pw', confirmation: 'pw', check: taken }).loginId
    ).toMatch(/이미 사용 중/)
  })
})

describe('auth snapshot ordering', () => {
  const snapshot = (revision: number, sessionId = 's') =>
    ({ phase: 'signed_out', generation: { sessionId, revision }, user: null }) as const

  it('keeps the newest snapshot of a run and accepts a new run', () => {
    expect(newestAuthSnapshot(snapshot(3), snapshot(2))).toEqual(snapshot(3))
    expect(newestAuthSnapshot(snapshot(3), snapshot(4))).toEqual(snapshot(4))
    expect(newestAuthSnapshot(snapshot(3), snapshot(0, 'other'))).toEqual(snapshot(0, 'other'))
    expect(newestAuthSnapshot(null, snapshot(1))).toEqual(snapshot(1))
  })
})
