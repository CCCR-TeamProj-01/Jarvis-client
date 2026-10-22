import { afterEach, describe, expect, it } from 'vitest'
import { decodeSession } from '../../src/main/auth/server-session'
import { stopAllFakeServers } from '../fixtures/fake-jarvis-server'
import { signedInApp } from '../fixtures/signed-in-app'

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
