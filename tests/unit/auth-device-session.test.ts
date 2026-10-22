import { describe, expect, it } from 'vitest'
import { deviceInfoFrom } from '../../src/main/auth/device-info'
import { createAuthGateway } from '../../src/main/auth/create-auth-gateway'
import { DevAuthGateway } from '../../src/main/auth/dev-auth-gateway'
import { ServerAuthGateway } from '../../src/main/auth/server-auth-gateway'
import { AccessTokenHolder, decodeSession, encodeSession } from '../../src/main/auth/server-session'
import type { StoredSession } from '../../src/main/auth/server-session'
import { unavailableAuthGateway } from '../../src/main/auth/unavailable-auth-gateway'
import { ServerClient } from '../../src/main/connection/server-client'

const KEY = '3f0c2a52-6a41-4f1d-8d58-0f6f1f2c9b11'

describe('device info', () => {
  const info = (over: Partial<Parameters<typeof deviceInfoFrom>[0]> = {}) =>
    deviceInfoFrom({
      deviceKey: KEY,
      hostname: '집 데스크톱',
      platform: 'win32',
      appVersion: '0.1.0',
      ...over
    })

  it('describes this machine in the server vocabulary', () => {
    expect(info()).toEqual({
      ok: true,
      value: {
        deviceKey: KEY,
        deviceName: '집 데스크톱',
        platform: 'windows',
        clientVersion: '0.1.0'
      }
    })
    expect(info({ platform: 'darwin' })).toMatchObject({ ok: true, value: { platform: 'macos' } })
  })

  it('cleans the name and falls back when nothing usable is left', () => {
    expect(info({ hostname: '  Do\u0000yun\n\tBook  ' })).toMatchObject({
      ok: true,
      value: { deviceName: 'Do yun Book' }
    })
    expect(info({ hostname: 'x'.repeat(300) })).toMatchObject({
      ok: true,
      value: { deviceName: 'x'.repeat(100) }
    })
    expect(info({ hostname: '\u0001 \u0002', platform: 'darwin' })).toMatchObject({
      ok: true,
      value: { deviceName: 'Mac' }
    })
    expect(info({ hostname: '' })).toMatchObject({ ok: true, value: { deviceName: 'Windows PC' } })
    expect(info({ appVersion: '1'.repeat(80) })).toMatchObject({
      ok: true,
      value: { clientVersion: '1'.repeat(32) }
    })
  })

  it('refuses without an installation key or on an OS the server does not know', () => {
    expect(info({ deviceKey: null })).toMatchObject({
      ok: false,
      error: { code: 'device_unavailable' }
    })
    expect(info({ platform: 'linux' })).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })
})

describe('stored session', () => {
  const session: StoredSession = {
    v: 1,
    sessionId: 'sess-1',
    deviceKey: KEY,
    userId: 'user-1',
    loginId: 'jarvis',
    accessToken: 'acc.token',
    refreshToken: 'ref.token',
    accessExpiresAtUnixMs: 2_000_000,
    refreshExpiresAtUnixMs: 9_000_000
  }

  it('round-trips through the opaque credential', () => {
    expect(decodeSession(encodeSession(session))).toEqual(session)
  })

  it('rejects anything this adapter did not write', () => {
    for (const opaque of [
      'dev-session:dev-user-demo',
      '',
      'not json',
      '{}',
      JSON.stringify({ ...session, v: 2 }),
      JSON.stringify({ ...session, deviceKey: 'not-a-uuid' }),
      JSON.stringify({ ...session, accessToken: '' }),
      JSON.stringify({ ...session, extra: 1 }),
      JSON.stringify({ ...session, refreshExpiresAtUnixMs: 'soon' })
    ])
      expect(decodeSession({ opaque })).toBeNull()
  })

  it('keeps the access token in memory only', () => {
    const holder = new AccessTokenHolder()
    expect(holder.get()).toBeNull()
    holder.set('abc')
    expect(holder.get()).toBe('abc')
    holder.clear()
    expect(holder.get()).toBeNull()
  })
})

describe('gateway selection', () => {
  const tokens = new AccessTokenHolder()
  const server = {
    client: new ServerClient({
      baseUrl: 'http://127.0.0.1:1/api/v1',
      fetch: async () => new Response(),
      accessToken: () => null
    }),
    tokens,
    device: () =>
      deviceInfoFrom({ deviceKey: KEY, hostname: 'h', platform: 'darwin', appVersion: '1' })
  }
  const select = (over: object) =>
    createAuthGateway({ isPackaged: false, env: {}, nowUnixMs: () => 0, ...over })

  it('uses the configured server, the stand-in only when asked for, and otherwise nothing', () => {
    expect(select({ server })).toBeInstanceOf(ServerAuthGateway)
    expect(select({ server: null })).toBe(unavailableAuthGateway)
    expect(select({})).toBe(unavailableAuthGateway)
    // The explicit stand-in beats a configured server so choosing it is always deliberate.
    expect(select({ server, env: { JARVIS_DEV_AUTH: '1' } })).toBeInstanceOf(DevAuthGateway)
    expect(select({ server, env: { JARVIS_DEV_AUTH: 'true' } })).toBeInstanceOf(ServerAuthGateway)
  })

  it('never uses the stand-in in a packaged build', () => {
    expect(select({ isPackaged: true, env: { JARVIS_DEV_AUTH: '1' } })).toBe(unavailableAuthGateway)
    expect(select({ isPackaged: true, server })).toBeInstanceOf(ServerAuthGateway)
  })
})
