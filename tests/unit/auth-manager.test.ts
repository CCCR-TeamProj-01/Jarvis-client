import { describe, expect, it, vi } from 'vitest'
import { AuthManager } from '../../src/main/auth/auth-manager'
import { DEV_ACCOUNT, DevAuthGateway } from '../../src/main/auth/dev-auth-gateway'
import type { DevOperation } from '../../src/main/auth/dev-auth-gateway'
import { MemoryCredentialStore } from '../../src/main/auth/memory-credential-store'
import type { CredentialStorePort, SessionCredential } from '../../src/main/auth/ports'
import type { AuthEvent, AuthSnapshot } from '../../src/shared/contracts/auth'
import type { ClientError } from '../../src/shared/contracts/common'

const unavailableError: ClientError = { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
const demoCredential: SessionCredential = { opaque: `dev-session:${DEV_ACCOUNT.userId}` }

/** Lets a test hold a gateway call open and release it later. */
function holdGate() {
  const held = new Map<DevOperation, () => void>()
  const waiting = new Set<DevOperation>()
  return {
    gate: (operation: DevOperation) => {
      if (!waiting.has(operation)) return Promise.resolve()
      return new Promise<void>((resolve) => held.set(operation, resolve))
    },
    hold: (operation: DevOperation) => waiting.add(operation),
    release: (operation: DevOperation) => {
      waiting.delete(operation)
      held.get(operation)?.()
      held.delete(operation)
    }
  }
}

function setup(
  options: { credential?: SessionCredential | null; store?: CredentialStorePort } = {}
) {
  let unixMs = 1_000_000
  const timers: { callback: () => void; at: number; cancelled: boolean }[] = []
  const gate = holdGate()
  const failNext: Partial<Record<DevOperation, ClientError>> = {}
  const gateway = new DevAuthGateway({
    nowUnixMs: () => unixMs,
    sessionLifetimeMs: 10_000,
    gate: gate.gate,
    failNext
  })
  const store = options.store ?? new MemoryCredentialStore(options.credential ?? null)
  const manager = new AuthManager({
    gateway,
    store,
    sessionId: 'run-1',
    nowUnixMs: () => unixMs,
    schedule: (callback, delayMs) => {
      const timer = { callback, at: unixMs + delayMs, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
  const events: AuthEvent[] = []
  manager.subscribe((event) => events.push(event))
  const generations: AuthSnapshot[] = []
  manager.onGenerationChange((snapshot) => generations.push(snapshot))
  let request = 0
  const context = () => ({
    requestId: `req-${++request}`,
    generation: manager.getSnapshot().generation
  })
  return {
    manager,
    store,
    gateway,
    gate,
    failNext,
    events,
    generations,
    context,
    advance(ms: number) {
      unixMs += ms
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= unixMs) {
          timer.cancelled = true
          timer.callback()
        }
      }
    },
    activeTimers: () => timers.filter((timer) => !timer.cancelled).length
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const errorCodes = (events: AuthEvent[]) =>
  events.flatMap((event) => (event.type === 'auth.error' ? [event.error.code] : []))

async function signedIn(ctx: ReturnType<typeof setup>) {
  await ctx.manager.start()
  const result = await ctx.manager.signIn({
    ...ctx.context(),
    input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
  })
  expect(result.ok).toBe(true)
  return result
}

describe('startup', () => {
  it('begins in checking and signs nobody in', () => {
    const { manager } = setup()
    expect(manager.getSnapshot()).toMatchObject({ phase: 'checking', user: null })
    expect(manager.isSignedIn()).toBe(false)
    expect(manager.requireSignedIn()).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
  })

  it('moves to signed_out when nothing is stored', async () => {
    const { manager } = setup()
    await manager.start()
    expect(manager.getSnapshot().phase).toBe('signed_out')
  })

  it('never treats a stored credential as a login until the server confirms it', async () => {
    const ctx = setup({ credential: demoCredential })
    ctx.gate.hold('restore')
    const started = ctx.manager.start()
    await flush()
    expect(ctx.manager.getSnapshot().phase).toBe('checking')
    expect(ctx.manager.isSignedIn()).toBe(false)
    ctx.gate.release('restore')
    await started
    expect(ctx.manager.getSnapshot()).toMatchObject({
      phase: 'signed_in',
      user: { loginId: DEV_ACCOUNT.loginId }
    })
  })

  it('removes a credential the server rejects and reports it', async () => {
    const ctx = setup({ credential: { opaque: 'dev-session:unknown' } })
    await ctx.manager.start()
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
    expect(await ctx.store.load()).toEqual({ ok: true, value: null })
    expect(errorCodes(ctx.events)).toEqual(['session_expired'])
  })

  it('keeps the credential and stays blocked on a transient failure, then retries', async () => {
    const ctx = setup({ credential: demoCredential })
    ctx.failNext.restore = unavailableError
    await ctx.manager.start()
    expect(ctx.manager.getSnapshot().phase).toBe('checking')
    expect(ctx.manager.isSignedIn()).toBe(false)
    expect(await ctx.store.load()).toEqual({ ok: true, value: demoCredential })
    expect(errorCodes(ctx.events)).toEqual(['unavailable'])

    const retried = await ctx.manager.restore(ctx.context())
    expect(retried).toMatchObject({ ok: true, value: { snapshot: { phase: 'signed_in' } } })
  })

  it('allows signing in as another account while restoration is stuck', async () => {
    const ctx = setup({ credential: demoCredential })
    ctx.failNext.restore = unavailableError
    await ctx.manager.start()
    await ctx.manager.signUp({ ...ctx.context(), input: { loginId: 'other', password: 'pw' } })
    const result = await ctx.manager.signIn({
      ...ctx.context(),
      input: { loginId: 'other', password: 'pw' }
    })
    expect(result).toMatchObject({ ok: true, value: { snapshot: { user: { loginId: 'other' } } } })
    expect(await ctx.store.load()).toMatchObject({
      ok: true,
      value: { opaque: expect.any(String) }
    })
  })

  it('does not sign in when the stored credential cannot be read', async () => {
    const store: CredentialStorePort = {
      load: async () => ({
        ok: false,
        error: { code: 'credential_unavailable', message: '읽을 수 없습니다.' }
      }),
      save: async () => ({ ok: true, value: undefined }),
      clear: async () => ({ ok: true, value: undefined })
    }
    const ctx = setup({ store })
    await ctx.manager.start()
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
    expect(errorCodes(ctx.events)).toEqual(['credential_unavailable'])
  })
})

describe('sign in and sign up', () => {
  it('signs in, persists the credential and publishes a new generation', async () => {
    const ctx = setup()
    const before = (await ctx.manager.start(), ctx.manager.getSnapshot().generation)
    const result = await signedIn(ctx)
    expect(result).toMatchObject({ ok: true, value: { persistence: { status: 'stored' } } })
    expect(ctx.manager.requireSignedIn()).toMatchObject({ ok: true })
    expect(ctx.manager.getSnapshot().generation.revision).toBeGreaterThan(before.revision)
    expect(await ctx.store.load()).toMatchObject({
      ok: true,
      value: { opaque: expect.any(String) }
    })
  })

  it('reports wrong credentials without changing state', async () => {
    const ctx = setup()
    await ctx.manager.start()
    const generation = ctx.manager.getSnapshot().generation
    const result = await ctx.manager.signIn({
      ...ctx.context(),
      input: { loginId: DEV_ACCOUNT.loginId, password: 'wrong' }
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } })
    expect(ctx.manager.getSnapshot().generation).toEqual(generation)
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
  })

  it('distinguishes a communication error from wrong credentials', async () => {
    const ctx = setup()
    await ctx.manager.start()
    ctx.failNext.signIn = unavailableError
    const result = await ctx.manager.signIn({
      ...ctx.context(),
      input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('rejects a second concurrent sign-in instead of racing', async () => {
    const ctx = setup()
    await ctx.manager.start()
    ctx.gate.hold('signIn')
    const input = { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    const first = ctx.manager.signIn({ ...ctx.context(), input })
    await flush()
    const second = await ctx.manager.signIn({ ...ctx.context(), input })
    expect(second).toMatchObject({ ok: false, error: { code: 'conflict' } })
    ctx.gate.release('signIn')
    expect(await first).toMatchObject({ ok: true })
  })

  it('refuses requests from a stale generation and when already signed in', async () => {
    const ctx = setup()
    await ctx.manager.start()
    const stale = ctx.context()
    await signedIn(ctx)
    const input = { loginId: 'x', password: 'y' }
    expect(await ctx.manager.signIn({ ...stale, input })).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    expect(await ctx.manager.signIn({ ...ctx.context(), input })).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    expect(
      await ctx.manager.checkLoginId({ ...ctx.context(), input: { loginId: 'x' } })
    ).toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it('still signs in when the credential cannot be saved, and says so', async () => {
    const store: CredentialStorePort = {
      load: async () => ({ ok: true, value: null }),
      save: async () => ({
        ok: false,
        error: { code: 'credential_unavailable', message: '보관할 수 없습니다.' }
      }),
      clear: vi.fn<CredentialStorePort['clear']>(async () => ({ ok: true, value: undefined }))
    }
    const ctx = setup({ store })
    await ctx.manager.start()
    const result = await ctx.manager.signIn({
      ...ctx.context(),
      input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    })
    expect(result).toMatchObject({
      ok: true,
      value: { persistence: { status: 'unavailable', error: { code: 'credential_unavailable' } } }
    })
    expect(ctx.manager.isSignedIn()).toBe(true)
    // The old account's credential must not survive a failed save for the new one.
    expect(store.clear).toHaveBeenCalled()
  })

  it('checks and creates accounts, leaving the final uniqueness decision to the server', async () => {
    const ctx = setup()
    await ctx.manager.start()
    expect(
      await ctx.manager.checkLoginId({ ...ctx.context(), input: { loginId: 'fresh' } })
    ).toEqual({ ok: true, value: { loginId: 'fresh', available: true } })
    expect(
      await ctx.manager.checkLoginId({ ...ctx.context(), input: { loginId: DEV_ACCOUNT.loginId } })
    ).toEqual({ ok: true, value: { loginId: DEV_ACCOUNT.loginId, available: false } })
    // Someone else took "fresh" after the check: signing up still fails.
    await ctx.manager.signUp({ ...ctx.context(), input: { loginId: 'fresh', password: 'a' } })
    expect(
      await ctx.manager.signUp({ ...ctx.context(), input: { loginId: 'fresh', password: 'b' } })
    ).toMatchObject({ ok: false, error: { code: 'login_id_taken' } })
  })

  it('never reports a failed duplicate check as available', async () => {
    const ctx = setup()
    await ctx.manager.start()
    ctx.failNext.checkLoginId = unavailableError
    expect(
      await ctx.manager.checkLoginId({ ...ctx.context(), input: { loginId: 'fresh' } })
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })
})

describe('invalidating late results', () => {
  it('ignores a sign-in that completes after sign-out', async () => {
    const ctx = setup()
    await ctx.manager.start()
    ctx.gate.hold('signIn')
    const pending = ctx.manager.signIn({
      ...ctx.context(),
      input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    })
    await flush()
    await ctx.manager.signOut(ctx.context())
    ctx.gate.release('signIn')
    expect(await pending).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
    expect(await ctx.store.load()).toEqual({ ok: true, value: null })
  })

  it('does not leave a credential behind when sign-out races the save', async () => {
    let releaseSave: () => void = () => undefined
    const base = new MemoryCredentialStore()
    const store: CredentialStorePort = {
      load: () => base.load(),
      save: async (credential) => {
        await new Promise<void>((resolve) => {
          releaseSave = resolve
        })
        return base.save(credential)
      },
      clear: () => base.clear()
    }
    const ctx = setup({ store })
    await ctx.manager.start()
    const pending = ctx.manager.signIn({
      ...ctx.context(),
      input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    })
    await flush()
    await flush()
    await ctx.manager.signOut(ctx.context())
    releaseSave()
    expect(await pending).toMatchObject({ ok: false })
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
    expect(await store.load()).toEqual({ ok: true, value: null })
  })

  it('ignores a restore that completes after sign-out', async () => {
    const ctx = setup({ credential: demoCredential })
    ctx.gate.hold('restore')
    const started = ctx.manager.start()
    await flush()
    await ctx.manager.signOut(ctx.context())
    ctx.gate.release('restore')
    await started
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
    expect(ctx.manager.isSignedIn()).toBe(false)
  })

  it('drops a duplicate-check answer that arrives after the generation changed', async () => {
    const ctx = setup()
    await ctx.manager.start()
    ctx.gate.hold('checkLoginId')
    const pending = ctx.manager.checkLoginId({ ...ctx.context(), input: { loginId: 'fresh' } })
    await flush()
    await signedIn(ctx)
    ctx.gate.release('checkLoginId')
    expect(await pending).toMatchObject({ ok: false, error: { code: 'conflict' } })
  })
})

describe('sign-out', () => {
  it('blocks locally before the server answers and clears the credential', async () => {
    const ctx = setup()
    await signedIn(ctx)
    ctx.gate.hold('signOut')
    const request = ctx.context()
    const result = await ctx.manager.signOut(request)
    expect(result).toEqual({ ok: true, value: undefined })
    expect(ctx.manager.isSignedIn()).toBe(false)
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
    expect(await ctx.store.load()).toEqual({ ok: true, value: null })
    expect(ctx.gateway.calls).toContain('signOut')
    ctx.gate.release('signOut')
  })

  it('works even from a stale generation', async () => {
    const ctx = setup()
    await ctx.manager.start()
    const stale = ctx.context()
    await signedIn(ctx)
    expect(await ctx.manager.signOut(stale)).toEqual({ ok: true, value: undefined })
    expect(ctx.manager.isSignedIn()).toBe(false)
  })

  it('stays blocked and reports it when the credential cannot be removed', async () => {
    const base = new MemoryCredentialStore()
    const store: CredentialStorePort = {
      load: () => base.load(),
      save: (credential) => base.save(credential),
      clear: async () => ({
        ok: false,
        error: { code: 'credential_unavailable', message: '삭제하지 못했습니다.' }
      })
    }
    const ctx = setup({ store })
    await signedIn(ctx)
    const result = await ctx.manager.signOut(ctx.context())
    expect(result).toMatchObject({ ok: false, error: { code: 'credential_unavailable' } })
    expect(ctx.manager.isSignedIn()).toBe(false)
    expect(errorCodes(ctx.events)).toContain('credential_unavailable')
  })

  it('does not wait for or depend on the remote logout', async () => {
    const ctx = setup()
    await signedIn(ctx)
    ctx.failNext.signOut = unavailableError
    expect(await ctx.manager.signOut(ctx.context())).toEqual({ ok: true, value: undefined })
  })
})

describe('account isolation and expiry', () => {
  it('notifies subsystems on every generation change, including account switches', async () => {
    const ctx = setup()
    await signedIn(ctx)
    const afterLogin = ctx.generations.length
    await ctx.manager.signOut(ctx.context())
    await ctx.manager.signUp({ ...ctx.context(), input: { loginId: 'other', password: 'pw' } })
    await ctx.manager.signIn({ ...ctx.context(), input: { loginId: 'other', password: 'pw' } })
    const revisions = ctx.generations.map((snapshot) => snapshot.generation.revision)
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(ctx.generations.length).toBeGreaterThan(afterLogin)
    expect(ctx.generations.at(-1)).toMatchObject({ phase: 'signed_in', user: { loginId: 'other' } })
    expect(ctx.generations.some((snapshot) => snapshot.phase === 'signed_out')).toBe(true)
  })

  it('re-verifies at expiry and blocks protected features in between', async () => {
    const ctx = setup()
    await signedIn(ctx)
    expect(ctx.activeTimers()).toBe(1)
    ctx.gate.hold('restore')
    ctx.advance(10_000)
    await flush()
    expect(ctx.manager.getSnapshot().phase).toBe('checking')
    expect(ctx.manager.isSignedIn()).toBe(false)
    ctx.gate.release('restore')
    await flush()
    await flush()
    expect(ctx.manager.getSnapshot()).toMatchObject({ phase: 'signed_in' })
    expect(ctx.activeTimers()).toBe(1)
  })

  it('signs out when the server refuses to renew', async () => {
    const ctx = setup()
    await signedIn(ctx)
    ctx.failNext.restore = {
      code: 'session_expired',
      message: '로그인 정보가 만료되었습니다.'
    }
    ctx.advance(10_000)
    await flush()
    await flush()
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
    expect(errorCodes(ctx.events)).toContain('session_expired')
    expect(await ctx.store.load()).toEqual({ ok: true, value: null })
  })

  it('stays blocked and recoverable when renewal fails transiently', async () => {
    const ctx = setup()
    await signedIn(ctx)
    ctx.failNext.restore = unavailableError
    ctx.advance(10_000)
    await flush()
    await flush()
    expect(ctx.manager.getSnapshot().phase).toBe('checking')
    expect(ctx.manager.isSignedIn()).toBe(false)
    expect(await ctx.manager.restore(ctx.context())).toMatchObject({ ok: true })
  })

  it('signs out and clears when the server rejects the session mid-use', async () => {
    const ctx = setup()
    await signedIn(ctx)
    await ctx.manager.handleSessionRejected({ code: 'session_expired', message: '만료' })
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
    expect(await ctx.store.load()).toEqual({ ok: true, value: null })
    expect(ctx.activeTimers()).toBe(0)
  })

  it('rejects a session that is already expired instead of looping on it', async () => {
    const expired = new DevAuthGateway({ nowUnixMs: () => 0, sessionLifetimeMs: 1 })
    const manager = new AuthManager({
      gateway: expired,
      store: new MemoryCredentialStore(),
      sessionId: 'run-2',
      nowUnixMs: () => 1_000,
      schedule: () => () => undefined
    })
    await manager.start()
    const result = await manager.signIn({
      requestId: 'r',
      generation: manager.getSnapshot().generation,
      input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(manager.isSignedIn()).toBe(false)
  })

  it('stops timers, aborts work and silences listeners on dispose', async () => {
    const ctx = setup()
    await signedIn(ctx)
    ctx.manager.dispose()
    expect(ctx.activeTimers()).toBe(0)
    const events = ctx.events.length
    await ctx.manager.signOut(ctx.context())
    expect(ctx.events.length).toBe(events)
    expect(
      await ctx.manager.signIn({ ...ctx.context(), input: { loginId: 'a', password: 'b' } })
    ).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})

describe('snapshots', () => {
  it('never exposes credentials or tokens', async () => {
    const ctx = setup()
    const result = await signedIn(ctx)
    const serialized = JSON.stringify([ctx.manager.getSnapshot(), ctx.events, result])
    expect(serialized).not.toContain('dev-session')
    expect(serialized).not.toContain(DEV_ACCOUNT.password)
  })

  it('returns defensive copies', async () => {
    const ctx = setup()
    await ctx.manager.start()
    const snapshot = ctx.manager.getSnapshot() as { phase: string }
    snapshot.phase = 'signed_in'
    expect(ctx.manager.getSnapshot().phase).toBe('signed_out')
  })
})
