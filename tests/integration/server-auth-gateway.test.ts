import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthManager } from '../../src/main/auth/auth-manager'
import { deviceInfoFrom } from '../../src/main/auth/device-info'
import { MemoryCredentialStore } from '../../src/main/auth/memory-credential-store'
import { ServerAuthGateway } from '../../src/main/auth/server-auth-gateway'
import { AccessTokenHolder, decodeSession } from '../../src/main/auth/server-session'
import { ServerClient } from '../../src/main/connection/server-client'
import type { AuthSnapshot } from '../../src/shared/contracts/auth'
import {
  ACCESS_LIFETIME_S,
  REFRESH_LIFETIME_S,
  startFakeServer,
  stopAllFakeServers,
  stopServer
} from '../fixtures/fake-auth-server'

const DEVICE_KEY = '3f0c2a52-6a41-4f1d-8d58-0f6f1f2c9b11'
const PASSWORD = 'correct-horse-battery'

afterEach(stopAllFakeServers)

async function setup(options: { deviceReady?: boolean; refreshRetryWindowMs?: number } = {}) {
  const { fake, server, baseUrl } = await startFakeServer()

  const clock = { nowMs: Date.parse('2026-10-22T00:00:00Z') }
  const tokens = new AccessTokenHolder()
  const client = new ServerClient({
    baseUrl,
    fetch: (input, init) => fetch(input, init),
    accessToken: () => tokens.get()
  })
  const gateway = new ServerAuthGateway({
    client,
    tokens,
    device: () =>
      deviceInfoFrom({
        deviceKey: options.deviceReady === false ? null : DEVICE_KEY,
        hostname: '집 데스크톱',
        platform: 'win32',
        appVersion: '0.1.0'
      }),
    nowUnixMs: () => clock.nowMs,
    ...(options.refreshRetryWindowMs === undefined
      ? {}
      : { refreshRetryWindowMs: options.refreshRetryWindowMs })
  })
  const manager = (store = new MemoryCredentialStore()) =>
    new AuthManager({
      gateway,
      store,
      sessionId: 'session-1',
      nowUnixMs: () => clock.nowMs,
      schedule: () => () => undefined
    })
  return { fake, gateway, client, tokens, clock, server, manager }
}

async function signedIn(options: Parameters<typeof setup>[0] = {}) {
  const context = await setup(options)
  context.fake.users.set('jarvis', PASSWORD)
  const result = await context.gateway.signIn({ loginId: 'jarvis', password: PASSWORD })
  if (!result.ok) throw new Error('sign-in failed')
  return { ...context, session: result.value }
}

describe('sign-up', () => {
  it('sends only the credentials and shows the ID the server stored', async () => {
    const { gateway, fake } = await setup()
    expect(await gateway.signUp({ loginId: 'Jarvis_User', password: PASSWORD })).toEqual({
      ok: true,
      value: { loginId: 'jarvis_user' }
    })
    expect(fake.calls[0]).toMatchObject({
      method: 'POST',
      path: '/auth/register',
      body: { username: 'Jarvis_User', password: PASSWORD },
      authorization: undefined
    })
    expect(fake.calls).toHaveLength(1)
  })

  it('tells a taken ID and bad input apart', async () => {
    const { gateway, fake } = await setup()
    fake.users.set('taken', PASSWORD)
    expect(await gateway.signUp({ loginId: 'taken', password: PASSWORD })).toMatchObject({
      ok: false,
      error: { code: 'login_id_taken' }
    })
    expect(await gateway.signUp({ loginId: 'ab', password: PASSWORD })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
  })
})

describe('login ID check', () => {
  it('asks the server and reports whether the ID is free', async () => {
    const { gateway, fake } = await setup()
    fake.users.set('taken', PASSWORD)
    expect(await gateway.checkLoginId({ loginId: 'Free_Name' })).toEqual({
      ok: true,
      value: { loginId: 'Free_Name', available: true }
    })
    expect(await gateway.checkLoginId({ loginId: 'Taken' })).toEqual({
      ok: true,
      value: { loginId: 'Taken', available: false }
    })
    expect(fake.calls[0]).toMatchObject({
      method: 'POST',
      path: '/auth/username-checks',
      body: { username: 'Free_Name' },
      authorization: undefined
    })
  })

  it('never turns a failed check into "available"', async () => {
    const { gateway, fake, server } = await setup()
    expect(await gateway.checkLoginId({ loginId: 'ab' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    fake.rateLimitChecks = true
    expect(await gateway.checkLoginId({ loginId: 'free_name' })).toMatchObject({
      ok: false,
      error: { code: 'rate_limited' }
    })
    await stopServer(server)
    expect(await gateway.checkLoginId({ loginId: 'free_name' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
  })

  it('still honours a cancelled request', async () => {
    const { gateway, fake } = await setup()
    const controller = new AbortController()
    controller.abort()
    expect(
      await gateway.checkLoginId({ loginId: 'free_name' }, { signal: controller.signal })
    ).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('sign-in', () => {
  it('registers this device with the login and keeps the tokens inside the credential', async () => {
    const { session, fake, clock, tokens } = await signedIn()
    expect(fake.calls[0]!.body).toEqual({
      username: 'jarvis',
      password: PASSWORD,
      device: {
        device_key: DEVICE_KEY,
        device_name: '집 데스크톱',
        platform: 'windows',
        client_version: '0.1.0'
      }
    })
    expect(fake.calls[0]!.authorization).toBeUndefined()
    expect(session.user).toEqual({ userId: 'uuid-jarvis', loginId: 'jarvis' })
    // The app sees the session end with the refresh token, not every hour with the access token.
    expect(session.expiresAtUnixMs).toBe(clock.nowMs + REFRESH_LIFETIME_S * 1000)
    const stored = decodeSession(session.credential)!
    expect(stored).toMatchObject({
      deviceKey: DEVICE_KEY,
      userId: 'uuid-jarvis',
      loginId: 'jarvis'
    })
    expect(stored.accessExpiresAtUnixMs).toBe(clock.nowMs + ACCESS_LIFETIME_S * 1000)
    expect(tokens.get()).toBe(stored.accessToken)
    expect(JSON.stringify(session.user)).not.toContain(stored.accessToken)
  })

  it('reports wrong credentials without echoing anything', async () => {
    const { gateway, fake } = await setup()
    fake.users.set('jarvis', PASSWORD)
    const result = await gateway.signIn({ loginId: 'jarvis', password: 'wrong-password-1' })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } })
    expect(JSON.stringify(result)).not.toContain('wrong-password-1')
  })

  it('does not call the server before this installation has a key', async () => {
    const { gateway, fake } = await setup({ deviceReady: false })
    expect(await gateway.signIn({ loginId: 'jarvis', password: PASSWORD })).toMatchObject({
      ok: false,
      error: { code: 'device_unavailable' }
    })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('restore', () => {
  it('confirms a session whose access token is still good with one read, and renews nothing', async () => {
    const { gateway, fake, session } = await signedIn()
    fake.calls.length = 0
    const restored = await gateway.restore(session.credential)
    expect(restored).toMatchObject({ ok: true, value: { user: { loginId: 'jarvis' } } })
    expect(fake.calls.map((call) => call.path)).toEqual(['/auth/me'])
    expect(fake.calls[0]!.authorization).toMatch(/^Bearer acc_/)
  })

  it('renews an expired access token first and then needs no second request', async () => {
    const { gateway, fake, session, clock } = await signedIn()
    fake.calls.length = 0
    clock.nowMs += 2 * 3600 * 1000
    const restored = await gateway.restore(session.credential)
    if (!restored.ok) throw new Error('restore failed')
    expect(fake.calls.map((call) => call.path)).toEqual(['/auth/refresh'])
    expect(fake.calls[0]!.body).toEqual({
      refresh_token: decodeSession(session.credential)!.refreshToken
    })
    const next = decodeSession(restored.value.credential)!
    expect(next.refreshToken).not.toBe(decodeSession(session.credential)!.refreshToken)
    expect(next.accessExpiresAtUnixMs).toBe(clock.nowMs + ACCESS_LIFETIME_S * 1000)
    expect(restored.value.user).toEqual({ userId: 'uuid-jarvis', loginId: 'jarvis' })
    // The rotated credential is the one to keep: it works, the old one no longer does.
    fake.calls.length = 0
    expect(await gateway.restore(restored.value.credential)).toMatchObject({ ok: true })
    expect(fake.calls.map((call) => call.path)).toEqual(['/auth/me'])
  })

  it('renews once when the server has dropped an access token that looks valid', async () => {
    const { gateway, fake, session } = await signedIn()
    fake.revokedAccess.add(decodeSession(session.credential)!.accessToken)
    fake.calls.length = 0
    const restored = await gateway.restore(session.credential)
    expect(restored).toMatchObject({ ok: true })
    expect(fake.calls.map((call) => call.path)).toEqual(['/auth/me', '/auth/refresh'])
  })

  it('treats a session the server no longer accepts as expired', async () => {
    const { gateway, fake, session, clock } = await signedIn()
    clock.nowMs += 2 * 3600 * 1000
    const old = session.credential
    // A first renewal retires the old refresh token; using it again after the grace looks like a leak.
    fake.graceMs = -1
    expect(await gateway.restore(old)).toMatchObject({ ok: true })
    expect(await gateway.restore(old)).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
    expect(fake.count('/auth/refresh')).toBe(2)
  })

  it('keeps the credential when the server cannot be reached before a renewal', async () => {
    const { gateway, session, clock, server } = await signedIn()
    clock.nowMs += 2 * 3600 * 1000
    await stopServer(server)
    expect(await gateway.restore(session.credential)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
  })

  it('repeats a renewal whose answer was lost once, and the server forgives it', async () => {
    const { gateway, fake, session, clock } = await signedIn()
    clock.nowMs += 2 * 3600 * 1000
    fake.refreshOnce = ['drop']
    fake.calls.length = 0
    const restored = await gateway.restore(session.credential)
    expect(restored).toMatchObject({ ok: true, value: { user: { loginId: 'jarvis' } } })
    expect(fake.count('/auth/refresh')).toBe(2)
    // Both attempts carried the same (old) token, and the pair that was kept is the second one.
    const old = decodeSession(session.credential)!.refreshToken
    expect(fake.calls.map((call) => call.body?.refresh_token)).toEqual([old, old])
    fake.calls.length = 0
    if (!restored.ok) throw new Error('restore failed')
    expect(await gateway.restore(restored.value.credential)).toMatchObject({ ok: true })
    expect(fake.calls.map((call) => call.path)).toEqual(['/auth/me'])
  })

  it('gives up for good when the repeat is unanswered too', async () => {
    const { gateway, fake, session, clock } = await signedIn()
    clock.nowMs += 2 * 3600 * 1000
    fake.refreshMode = 'drop'
    fake.calls.length = 0
    expect(await gateway.restore(session.credential)).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
    expect(fake.count('/auth/refresh')).toBe(2)
  })

  it('does not repeat a renewal once the grace window may have closed', async () => {
    const { gateway, fake, session, clock } = await signedIn({ refreshRetryWindowMs: 0 })
    clock.nowMs += 2 * 3600 * 1000
    fake.refreshMode = 'drop'
    fake.calls.length = 0
    expect(await gateway.restore(session.credential)).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
    expect(fake.count('/auth/refresh')).toBe(1)
  })

  it('ends in sign-in when the server does not forgive the repeat', async () => {
    const { gateway, fake, session, clock } = await signedIn()
    clock.nowMs += 2 * 3600 * 1000
    fake.graceMs = -1
    fake.refreshOnce = ['drop']
    fake.calls.length = 0
    expect(await gateway.restore(session.credential)).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
    expect(fake.count('/auth/refresh')).toBe(2)
  })

  it('treats a renewal whose answer is unreadable as lost, and a server error as passing', async () => {
    const { gateway, fake, session, clock } = await signedIn()
    clock.nowMs += 2 * 3600 * 1000
    fake.refreshMode = 'broken'
    expect(await gateway.restore(session.credential)).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })

    const second = await signedIn()
    second.clock.nowMs += 2 * 3600 * 1000
    second.fake.refreshMode = 'error503'
    expect(await second.gateway.restore(second.session.credential)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    // The server refused before retiring anything, so the same credential can be tried again.
    second.fake.refreshMode = 'ok'
    expect(await second.gateway.restore(second.session.credential)).toMatchObject({ ok: true })
  })

  it('does not accept a session from another installation or a damaged one, and asks nothing', async () => {
    const { gateway, fake, session } = await signedIn()
    fake.calls.length = 0
    const other = {
      opaque: session.credential.opaque.replace(DEVICE_KEY, '11111111-2222-4333-8444-555555555555')
    }
    for (const credential of [
      other,
      { opaque: 'garbage' },
      { opaque: 'dev-session:dev-user-demo' }
    ])
      expect(await gateway.restore(credential)).toMatchObject({
        ok: false,
        error: { code: 'session_expired' }
      })
    expect(fake.calls).toHaveLength(0)
  })

  it('shares one renewal between callers that ask at the same time', async () => {
    const { gateway, fake, session, clock } = await signedIn()
    clock.nowMs += 2 * 3600 * 1000
    fake.calls.length = 0
    const [first, second] = await Promise.all([
      gateway.restore(session.credential),
      gateway.restore(session.credential)
    ])
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true })
    expect(fake.count('/auth/refresh')).toBe(1)
    expect(first).toEqual(second)
  })
})

describe('sign-out', () => {
  it('ends the server session with the current token', async () => {
    const { gateway, fake, session, tokens } = await signedIn()
    fake.calls.length = 0
    expect(await gateway.signOut(session.credential)).toEqual({ ok: true, value: undefined })
    expect(fake.calls.map((call) => call.path)).toEqual(['/auth/logout'])
    expect(tokens.get()).toBeNull()
    expect(await gateway.restore(session.credential)).toMatchObject({ ok: false })
  })

  it('renews an expired access token before it can end the session', async () => {
    const { gateway, fake, session, clock } = await signedIn()
    clock.nowMs += 2 * 3600 * 1000
    fake.calls.length = 0
    expect(await gateway.signOut(session.credential)).toEqual({ ok: true, value: undefined })
    expect(fake.calls.map((call) => call.path)).toEqual(['/auth/refresh', '/auth/logout'])
  })

  it('counts a session the server has already ended as done, and reports an unreachable server', async () => {
    const { gateway, fake, session } = await signedIn()
    fake.revokedAccess.add(decodeSession(session.credential)!.accessToken)
    expect(await gateway.signOut(session.credential)).toEqual({ ok: true, value: undefined })

    const down = await signedIn()
    await stopServer(down.server)
    expect(await down.gateway.signOut(down.session.credential)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(down.tokens.get()).toBeNull()
  })
})

describe('with the app’s own login state', () => {
  it('signs in, keeps the credential and comes back after a restart, even a day later', async () => {
    const context = await setup()
    context.fake.users.set('jarvis', PASSWORD)
    const store = new MemoryCredentialStore()
    const phases: AuthSnapshot['phase'][] = []

    const first = context.manager(store)
    first.subscribe((event) => {
      if (event.type === 'auth.state_changed') phases.push(event.snapshot.phase)
    })
    await first.start()
    const generation = first.getSnapshot().generation
    expect(first.getSnapshot().phase).toBe('signed_out')
    const login = await first.signIn({
      requestId: 'r1',
      generation,
      input: { loginId: 'jarvis', password: PASSWORD }
    })
    expect(login).toMatchObject({ ok: true, value: { persistence: { status: 'stored' } } })
    expect(first.getSnapshot()).toMatchObject({ phase: 'signed_in', user: { loginId: 'jarvis' } })
    const saved = (await store.load()) as { ok: true; value: { opaque: string } }
    expect(decodeSession(saved.value)).not.toBeNull()

    const restarted = context.manager(store)
    await restarted.start()
    expect(restarted.getSnapshot()).toMatchObject({
      phase: 'signed_in',
      user: { loginId: 'jarvis' }
    })

    context.clock.nowMs += 24 * 3600 * 1000
    const nextDay = context.manager(store)
    await nextDay.start()
    expect(nextDay.getSnapshot().phase).toBe('signed_in')
    const renewed = (await store.load()) as { ok: true; value: { opaque: string } }
    expect(renewed.value.opaque).not.toBe(saved.value.opaque)

    expect(await nextDay.signOut()).toMatchObject({ ok: true })
    expect(await store.load()).toEqual({ ok: true, value: null })
    // The app does not wait for the server when signing out; the request still goes out.
    await vi.waitFor(() => expect(context.fake.count('/auth/logout')).toBe(1))
  })

  it('goes back to sign-in when the renewal answer is lost, instead of retrying a retired token', async () => {
    const context = await setup()
    context.fake.users.set('jarvis', PASSWORD)
    const store = new MemoryCredentialStore()
    const first = context.manager(store)
    await first.start()
    await first.signIn({
      requestId: 'r1',
      generation: first.getSnapshot().generation,
      input: { loginId: 'jarvis', password: PASSWORD }
    })
    context.clock.nowMs += 2 * 3600 * 1000
    context.fake.refreshMode = 'drop'
    const restarted = context.manager(store)
    await restarted.start()
    expect(restarted.getSnapshot().phase).toBe('signed_out')
    expect(await store.load()).toEqual({ ok: true, value: null })
    // The lost answer is repeated once; the repeat is lost too, so the session ends in sign-in.
    expect(context.fake.count('/auth/refresh')).toBe(2)
  })
})

describe('secrets', () => {
  it('never leaves a password or token in a failure', async () => {
    const context = await signedIn()
    const stored = decodeSession(context.session.credential)!
    context.clock.nowMs += 2 * 3600 * 1000
    context.fake.refreshMode = 'broken'
    const results = [
      await context.gateway.signIn({ loginId: 'jarvis', password: 'wrong-password-1' }),
      await context.gateway.signUp({ loginId: 'jarvis', password: PASSWORD }),
      await context.gateway.restore(context.session.credential)
    ]
    const text = JSON.stringify(results)
    for (const secret of ['wrong-password-1', PASSWORD, stored.accessToken, stored.refreshToken])
      expect(text).not.toContain(secret)
  })
})
