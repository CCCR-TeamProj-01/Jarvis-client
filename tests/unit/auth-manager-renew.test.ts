import { describe, expect, it, vi } from 'vitest'
import { AuthManager } from '../../src/main/auth/auth-manager'
import { MemoryCredentialStore } from '../../src/main/auth/memory-credential-store'
import type {
  AuthenticatedSession,
  AuthGatewayPort,
  CredentialStorePort,
  SessionCredential
} from '../../src/main/auth/ports'
import type { AuthEvent } from '../../src/shared/contracts/auth'
import type { ClientError, Result } from '../../src/shared/contracts/common'

const USER = { userId: 'user-1', loginId: 'jarvis' }
const NOW = 1_000_000

const session = (
  opaque: string,
  expiresAtUnixMs = NOW + 30 * 24 * 3600 * 1000
): AuthenticatedSession => ({
  user: USER,
  credential: { opaque },
  expiresAtUnixMs
})

/** A gateway whose renewal can be held open and answered later. */
function setup(options: { store?: CredentialStorePort } = {}) {
  const store = options.store ?? new MemoryCredentialStore()
  const restores: {
    credential: SessionCredential
    resolve(result: Result<AuthenticatedSession>): void
  }[] = []
  let next: Result<AuthenticatedSession> | null = null
  const gateway: AuthGatewayPort = {
    checkLoginId: async () => ({ ok: true, value: { loginId: 'x', available: true } }),
    signUp: async () => ({ ok: true, value: { loginId: 'x' } }),
    signIn: async () => ({ ok: true, value: session('cred-1') }),
    restore: vi.fn<AuthGatewayPort['restore']>(
      (credential: SessionCredential) =>
        new Promise<Result<AuthenticatedSession>>((resolve) => {
          if (next) return resolve(next)
          restores.push({ credential, resolve })
        })
    ),
    signOut: async () => ({ ok: true, value: undefined })
  }
  const scheduled: number[] = []
  const events: AuthEvent[] = []
  const manager = new AuthManager({
    gateway,
    store,
    sessionId: 'session-1',
    nowUnixMs: () => NOW,
    schedule: (_callback, delayMs) => {
      scheduled.push(delayMs)
      return () => undefined
    }
  })
  manager.subscribe((event) => events.push(event))
  return {
    manager,
    store,
    gateway,
    restores,
    scheduled,
    events,
    answerWith(result: Result<AuthenticatedSession>) {
      next = result
    },
    async signIn() {
      await manager.start()
      const result = await manager.signIn({
        requestId: 'r1',
        generation: manager.getSnapshot().generation,
        input: { loginId: 'jarvis', password: 'pw' }
      })
      if (!result.ok) throw new Error('sign-in failed')
    }
  }
}

const expired: ClientError = { code: 'session_expired', message: '만료' }

describe('renewing a signed-in session', () => {
  it('keeps the rotated credential and changes nothing the user can see', async () => {
    const t = setup()
    await t.signIn()
    const before = t.manager.getSnapshot()
    t.events.length = 0
    t.scheduled.length = 0
    t.answerWith({ ok: true, value: session('cred-2', NOW + 2 * 3600 * 1000) })

    expect(await t.manager.renewSession()).toEqual({ ok: true, value: undefined })
    expect(t.gateway.restore).toHaveBeenCalledWith({ opaque: 'cred-1' })
    expect(await t.store.load()).toEqual({ ok: true, value: { opaque: 'cred-2' } })
    expect(t.manager.getSnapshot()).toEqual(before)
    expect(t.events).toEqual([])
    // The end of the session moved, so the expiry check is set again for the new time.
    expect(t.scheduled).toEqual([2 * 3600 * 1000])

    // The next renewal starts from the credential that was kept.
    t.answerWith({ ok: true, value: session('cred-3') })
    await t.manager.renewSession()
    expect(t.gateway.restore).toHaveBeenLastCalledWith({ opaque: 'cred-2' })
  })

  it('does not write the store again when nothing was rotated', async () => {
    const t = setup()
    await t.signIn()
    const save = vi.spyOn(t.store, 'save')
    t.answerWith({ ok: true, value: session('cred-1') })
    expect(await t.manager.renewSession()).toMatchObject({ ok: true })
    expect(save).not.toHaveBeenCalled()
  })

  it('shares one renewal between callers that ask while it runs', async () => {
    const t = setup()
    await t.signIn()
    const first = t.manager.renewSession()
    const second = t.manager.renewSession()
    expect(t.restores).toHaveLength(1)
    t.restores[0]!.resolve({ ok: true, value: session('cred-2') })
    expect(await first).toEqual(await second)
    expect(t.gateway.restore).toHaveBeenCalledTimes(1)
    // Once finished, a later call starts a new renewal.
    void t.manager.renewSession()
    expect(t.restores).toHaveLength(2)
  })

  it('signs the user out only when the server has ended the session', async () => {
    const ended = setup()
    await ended.signIn()
    ended.answerWith({ ok: false, error: expired })
    expect(await ended.manager.renewSession()).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
    expect(ended.manager.getSnapshot().phase).toBe('signed_out')
    expect(await ended.store.load()).toEqual({ ok: true, value: null })

    const passing = setup()
    await passing.signIn()
    passing.answerWith({ ok: false, error: { code: 'unavailable', message: '불가' } })
    expect(await passing.manager.renewSession()).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(passing.manager.getSnapshot().phase).toBe('signed_in')
    expect(await passing.store.load()).toEqual({ ok: true, value: { opaque: 'cred-1' } })
  })

  it('refuses when nobody is signed in, without asking the gateway', async () => {
    const t = setup()
    await t.manager.start()
    expect(await t.manager.renewSession()).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(t.gateway.restore).not.toHaveBeenCalled()
  })

  it('throws the answer away when the user signs out while it is on its way', async () => {
    const t = setup()
    await t.signIn()
    const renewal = t.manager.renewSession()
    await t.manager.signOut()
    t.restores[0]!.resolve({ ok: true, value: session('cred-2') })
    expect(await renewal).toMatchObject({ ok: false })
    expect(await t.store.load()).toEqual({ ok: true, value: null })
    expect(t.manager.getSnapshot().phase).toBe('signed_out')
  })

  it('does not revive a session that was signed out while an unchanged credential came back', async () => {
    const t = setup()
    await t.signIn()
    const renewal = t.manager.renewSession()
    await t.manager.signOut()
    t.scheduled.length = 0
    t.restores[0]!.resolve({ ok: true, value: session('cred-1') })
    expect(await renewal).toMatchObject({ ok: false })
    // Nothing was scheduled for a session that no longer exists, and a later renewal has nothing to use.
    expect(t.scheduled).toEqual([])
    expect(await t.manager.renewSession()).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
  })

  it('does not leave a credential behind when the user signs out while it is being saved', async () => {
    let release: () => void = () => undefined
    const inner = new MemoryCredentialStore()
    const store: CredentialStorePort = {
      load: () => inner.load(),
      clear: () => inner.clear(),
      save: async (credential) => {
        if (credential.opaque === 'cred-2')
          await new Promise<void>((resolve) => (release = resolve))
        return inner.save(credential)
      }
    }
    const t = setup({ store })
    await t.signIn()
    t.answerWith({ ok: true, value: session('cred-2') })
    const renewal = t.manager.renewSession()
    await vi.waitFor(() => expect(release).not.toBe(undefined))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const signOut = t.manager.signOut()
    release()
    await signOut
    expect(await renewal).toMatchObject({ ok: false })
    await vi.waitFor(async () => expect(await inner.load()).toEqual({ ok: true, value: null }))
  })

  it('goes on with the session but forgets the stored credential when it cannot be saved', async () => {
    const inner = new MemoryCredentialStore()
    const store: CredentialStorePort = {
      load: () => inner.load(),
      clear: () => inner.clear(),
      save: async (credential) =>
        credential.opaque === 'cred-2'
          ? { ok: false, error: { code: 'credential_unavailable', message: '저장 실패' } }
          : inner.save(credential)
    }
    const t = setup({ store })
    await t.signIn()
    t.events.length = 0
    t.answerWith({ ok: true, value: session('cred-2') })
    expect(await t.manager.renewSession()).toMatchObject({ ok: true })
    expect(t.manager.getSnapshot().phase).toBe('signed_in')
    // The stored credential is the old, now retired one: keeping it would break the next start.
    await vi.waitFor(async () => expect(await inner.load()).toEqual({ ok: true, value: null }))
    expect(t.events).toEqual([
      expect.objectContaining({
        type: 'auth.error',
        error: expect.objectContaining({ code: 'credential_unavailable' })
      })
    ])
  })

  it('never accepts another account answering for the session', async () => {
    const t = setup()
    await t.signIn()
    t.answerWith({
      ok: true,
      value: { ...session('cred-2'), user: { userId: 'someone-else', loginId: 'other' } }
    })
    expect(await t.manager.renewSession()).toMatchObject({ ok: false })
    expect(t.manager.getSnapshot().phase).toBe('signed_out')
    expect(await t.store.load()).toEqual({ ok: true, value: null })
  })
})
