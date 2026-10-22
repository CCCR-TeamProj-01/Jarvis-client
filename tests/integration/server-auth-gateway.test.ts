import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthManager } from '../../src/main/auth/auth-manager'
import { deviceInfoFrom } from '../../src/main/auth/device-info'
import { MemoryCredentialStore } from '../../src/main/auth/memory-credential-store'
import { ServerAuthGateway } from '../../src/main/auth/server-auth-gateway'
import { AccessTokenHolder, decodeSession } from '../../src/main/auth/server-session'
import { ServerClient } from '../../src/main/connection/server-client'
import type { AuthSnapshot } from '../../src/shared/contracts/auth'

const DEVICE_KEY = '3f0c2a52-6a41-4f1d-8d58-0f6f1f2c9b11'
const PASSWORD = 'correct-horse-battery'
const ACCESS_LIFETIME_S = 3600
const REFRESH_LIFETIME_S = 2_592_000

type RefreshMode = 'ok' | 'drop' | 'broken' | 'error503'

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
  authorization: string | undefined
}

/**
 * A stand-in for the server's authentication: it rotates refresh tokens, treats a retired one as a
 * leak and revokes the session, and can lose, break or fail a refresh answer on demand.
 */
class FakeAuthServer {
  readonly users = new Map<string, string>()
  readonly calls: Call[] = []
  readonly retired = new Set<string>()
  readonly revokedAccess = new Set<string>()
  refreshMode: RefreshMode = 'ok'
  private sessions: {
    id: string
    user: string
    access: string
    refresh: string
    revoked: boolean
  }[] = []
  private counter = 0

  count(path: string): number {
    return this.calls.filter((call) => call.path === path).length
  }

  handle(request: IncomingMessage, response: ServerResponse, raw: string): void {
    const body = raw === '' ? null : (JSON.parse(raw) as Record<string, unknown>)
    const path = (request.url ?? '').replace('/api/v1', '')
    this.calls.push({
      method: request.method ?? '',
      path,
      body,
      authorization: request.headers.authorization
    })
    const send = (status: number, payload?: unknown) => {
      if (payload === undefined) return void response.writeHead(status).end()
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    const error = (status: number, code: string) => send(status, { error: { code, message: 'x' } })

    if (path === '/auth/register') {
      const username = String(body?.username ?? '').toLowerCase()
      if (this.users.has(username)) return error(409, 'USERNAME_TAKEN')
      if (username.length < 3) return error(422, 'VALIDATION_ERROR')
      this.users.set(username, String(body?.password))
      return send(201, { user_id: `uuid-${username}`, username, role: 'user', created_at: 'x' })
    }
    if (path === '/auth/login') {
      const username = String(body?.username ?? '').toLowerCase()
      if (this.users.get(username) !== body?.password) return error(401, 'INVALID_CREDENTIALS')
      const session = this.open(username)
      return send(200, {
        ...this.tokens(session),
        token_type: 'Bearer',
        session_id: session.id,
        user: { user_id: `uuid-${username}`, username, role: 'user' },
        device: { device_id: 12, device_name: 'x', platform: 'windows' }
      })
    }
    if (path === '/auth/refresh') {
      const token = String(body?.refresh_token)
      if (this.retired.has(token)) {
        const leaked = this.sessions.find((session) => session.refresh !== token && session.user)
        for (const session of this.sessions) session.revoked = true
        void leaked
        return error(401, 'REFRESH_TOKEN_REUSED')
      }
      const session = this.sessions.find((candidate) => candidate.refresh === token)
      if (!session || session.revoked) return error(401, 'INVALID_SESSION')
      if (this.refreshMode === 'error503') return error(503, 'SERVICE_UNAVAILABLE')
      this.retired.add(session.refresh)
      session.access = `acc_${++this.counter}`
      session.refresh = `ref_${++this.counter}`
      if (this.refreshMode === 'drop') return void request.socket.destroy()
      if (this.refreshMode === 'broken') {
        response.writeHead(200, { 'content-type': 'application/json' })
        return void response.end('{"access_token": ')
      }
      return send(200, { ...this.tokens(session), token_type: 'Bearer' })
    }
    const session = this.sessions.find(
      (candidate) => `Bearer ${candidate.access}` === request.headers.authorization
    )
    const valid = session && !session.revoked && !this.revokedAccess.has(session.access)
    if (path === '/auth/me') {
      if (!valid) return error(401, 'INVALID_SESSION')
      return send(200, {
        user: { user_id: `uuid-${session.user}`, username: session.user, role: 'user' },
        device: { device_id: 12, device_name: 'x', platform: 'windows' }
      })
    }
    if (path === '/auth/logout') {
      if (!valid) return error(401, 'INVALID_SESSION')
      session.revoked = true
      return send(204)
    }
    return error(404, 'NOT_FOUND')
  }

  private open(user: string) {
    const session = {
      id: `sess-${++this.counter}`,
      user,
      access: `acc_${++this.counter}`,
      refresh: `ref_${++this.counter}`,
      revoked: false
    }
    this.sessions.push(session)
    return session
  }

  private tokens(session: { access: string; refresh: string }) {
    return {
      access_token: session.access,
      refresh_token: session.refresh,
      access_expires_in: ACCESS_LIFETIME_S,
      refresh_expires_in: REFRESH_LIFETIME_S
    }
  }
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

async function setup(options: { deviceReady?: boolean } = {}) {
  const fake = new FakeAuthServer()
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => fake.handle(request, response, raw))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const clock = { nowMs: Date.parse('2026-10-22T00:00:00Z') }
  const tokens = new AccessTokenHolder()
  const client = new ServerClient({
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
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
    nowUnixMs: () => clock.nowMs
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

async function signedIn() {
  const context = await setup()
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

describe('login ID check (placeholder)', () => {
  it('answers "available" without asking the server, and the sign-up decides', async () => {
    const { gateway, fake } = await setup()
    fake.users.set('taken', PASSWORD)
    expect(await gateway.checkLoginId({ loginId: 'taken' })).toEqual({
      ok: true,
      value: { loginId: 'taken', available: true }
    })
    expect(fake.calls).toHaveLength(0)
    expect(await gateway.signUp({ loginId: 'taken', password: PASSWORD })).toMatchObject({
      error: { code: 'login_id_taken' }
    })
  })

  it('still honours a cancelled request', async () => {
    const { gateway } = await setup()
    const controller = new AbortController()
    controller.abort()
    expect(
      await gateway.checkLoginId({ loginId: 'x' }, { signal: controller.signal })
    ).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
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
    // A first renewal retires the old refresh token; using it again looks like a leak.
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
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    expect(await gateway.restore(session.credential)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
  })

  it('does not try the old token again when a renewal may have been processed', async () => {
    const { gateway, fake, session, clock } = await signedIn()
    clock.nowMs += 2 * 3600 * 1000
    fake.refreshMode = 'drop'
    fake.calls.length = 0
    expect(await gateway.restore(session.credential)).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
    expect(fake.count('/auth/refresh')).toBe(1)
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
    await new Promise<void>((resolve) => {
      down.server.closeAllConnections()
      down.server.close(() => resolve())
    })
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
    expect(context.fake.count('/auth/refresh')).toBe(1)
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
