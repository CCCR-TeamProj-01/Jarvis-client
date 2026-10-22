import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AuthManager } from '../../src/main/auth/auth-manager'
import { deviceInfoFrom } from '../../src/main/auth/device-info'
import { MemoryCredentialStore } from '../../src/main/auth/memory-credential-store'
import { ServerAuthGateway } from '../../src/main/auth/server-auth-gateway'
import { AccessTokenHolder, decodeSession } from '../../src/main/auth/server-session'
import { ServerClient } from '../../src/main/connection/server-client'
import { startFakeServer, stopAllFakeServers } from '../fixtures/fake-auth-server'

const DEVICE_KEY = '3f0c2a52-6a41-4f1d-8d58-0f6f1f2c9b11'
const PASSWORD = 'correct-horse-battery'
const MARGIN_MS = 60_000

/** The app's wiring in miniature: one client for signing in, another that keeps the token fresh. */
async function signedInApp() {
  const { fake, baseUrl } = await startFakeServer()
  fake.users.set('jarvis', PASSWORD)
  const clock = { nowMs: Date.parse('2026-10-22T00:00:00Z') }
  const tokens = new AccessTokenHolder()
  const fetchLike = (input: string, init: RequestInit) => fetch(input, init)
  const authClient = new ServerClient({
    baseUrl,
    fetch: fetchLike,
    accessToken: () => tokens.get()
  })
  const store = new MemoryCredentialStore()
  const manager = new AuthManager({
    gateway: new ServerAuthGateway({
      client: authClient,
      tokens,
      device: () =>
        deviceInfoFrom({
          deviceKey: DEVICE_KEY,
          hostname: 'pc',
          platform: 'win32',
          appVersion: '0.1.0'
        }),
      nowUnixMs: () => clock.nowMs
    }),
    store,
    sessionId: 'session-1',
    nowUnixMs: () => clock.nowMs,
    schedule: () => () => undefined
  })
  const api = new ServerClient({
    baseUrl,
    fetch: fetchLike,
    accessToken: async () => {
      if (tokens.expiringSoon(clock.nowMs, MARGIN_MS)) await manager.renewSession()
      return tokens.get()
    },
    renewAccessToken: async () => (await manager.renewSession()).ok
  })
  await manager.start()
  const login = await manager.signIn({
    requestId: 'r1',
    generation: manager.getSnapshot().generation,
    input: { loginId: 'jarvis', password: PASSWORD }
  })
  if (!login.ok) throw new Error('sign-in failed')
  fake.calls.length = 0
  const ping = () =>
    api.request({ method: 'GET', path: '/ping', response: z.object({ ok: z.boolean() }) })
  return { fake, clock, manager, store, api, ping, tokens }
}

afterEach(stopAllFakeServers)

describe('calls made while signed in', () => {
  it('uses the stored token while it is good', async () => {
    const { ping, fake } = await signedInApp()
    expect(await ping()).toMatchObject({ ok: true })
    expect(fake.calls.map((call) => call.path)).toEqual(['/ping'])
  })

  it('renews shortly before the token ends, keeps the new credential, and the user notices nothing', async () => {
    const { ping, fake, clock, manager, store } = await signedInApp()
    const generation = manager.getSnapshot().generation
    const before = await store.load()
    clock.nowMs += 3600 * 1000 - 30_000
    expect(await ping()).toMatchObject({ ok: true })
    expect(fake.calls.map((call) => call.path)).toEqual(['/auth/refresh', '/ping'])
    expect(manager.getSnapshot()).toMatchObject({ phase: 'signed_in', generation })
    const after = await store.load()
    expect(after).not.toEqual(before)
    expect(after.ok && after.value && decodeSession(after.value)).toMatchObject({
      loginId: 'jarvis'
    })
    // The renewed token is the one in use now, so nothing needs renewing again.
    fake.calls.length = 0
    expect(await ping()).toMatchObject({ ok: true })
    expect(fake.calls.map((call) => call.path)).toEqual(['/ping'])
  })

  it('renews once and repeats the call when the server has dropped a token that looks valid', async () => {
    const { ping, fake, tokens } = await signedInApp()
    fake.revokedAccess.add(tokens.get()!)
    expect(await ping()).toMatchObject({ ok: true })
    expect(fake.calls.map((call) => call.path)).toEqual([
      '/ping',
      '/auth/me',
      '/auth/refresh',
      '/ping'
    ])
  })

  it('signs the user out when the session itself has been ended, without repeating the call', async () => {
    const { ping, fake, manager, store } = await signedInApp()
    fake.endAllSessions()
    expect(await ping()).toMatchObject({ ok: false, error: { code: 'session_expired' } })
    expect(manager.getSnapshot().phase).toBe('signed_out')
    expect(await store.load()).toEqual({ ok: true, value: null })
    expect(fake.calls.filter((call) => call.path === '/ping')).toHaveLength(1)
  })

  it('renews only once for calls that run at the same time', async () => {
    const { ping, fake, clock } = await signedInApp()
    clock.nowMs += 3600 * 1000 - 30_000
    const results = await Promise.all([ping(), ping(), ping()])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(fake.count('/auth/refresh')).toBe(1)
  })
})
