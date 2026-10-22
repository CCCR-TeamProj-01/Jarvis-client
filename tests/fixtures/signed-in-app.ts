import { z } from 'zod'
import { AuthManager } from '../../src/main/auth/auth-manager'
import { deviceInfoFrom } from '../../src/main/auth/device-info'
import { MemoryCredentialStore } from '../../src/main/auth/memory-credential-store'
import { ServerAuthGateway } from '../../src/main/auth/server-auth-gateway'
import { AccessTokenHolder } from '../../src/main/auth/server-session'
import { ServerClient } from '../../src/main/connection/server-client'
import { startFakeServer } from './fake-jarvis-server'

export const DEVICE_KEY = '3f0c2a52-6a41-4f1d-8d58-0f6f1f2c9b11'
export const PASSWORD = 'correct-horse-battery'
const MARGIN_MS = 60_000

/** The app's wiring in miniature: one client for signing in, another that keeps the token fresh. */
export async function signedInApp() {
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
