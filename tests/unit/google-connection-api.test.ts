import { describe, expect, it, vi } from 'vitest'
import { GoogleConnectionApi } from '../../src/main/google-connection/google-connection-api'
import { ServerClient } from '../../src/main/connection/server-client'
import type { FetchLike } from '../../src/main/connection/server-client'

const BASE = 'http://127.0.0.1:8001/api/v1'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refusal = (status: number, code: string) =>
  json({ error: { code, message: 'server wording' } }, status)

function api(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn<FetchLike>(async (url, init) => respond(url, init))
  const client = new ServerClient({ baseUrl: BASE, fetch, accessToken: () => 'tok' })
  return { api: new GoogleConnectionApi(client), fetch }
}

const row = (overrides: Record<string, unknown> = {}) => ({
  connection_id: 31,
  provider: 'google',
  status: 'active',
  connected_at: '2026-10-20T05:00:00Z',
  last_synced_at: '2026-10-21T04:00:00Z',
  ...overrides
})

describe('reading the connection', () => {
  it('reads the connection as the spec describes it', async () => {
    const t = api(() => json({ items: [row()] }))
    expect(await t.api.connection()).toEqual({
      ok: true,
      value: {
        id: '31',
        status: 'active',
        connectedAtMs: Date.parse('2026-10-20T05:00:00Z'),
        lastSyncedAtMs: Date.parse('2026-10-21T04:00:00Z')
      }
    })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/calendar/connections`)
    expect(init.method).toBe('GET')
  })

  it('reads times without a zone as UTC, as the real server sends them', async () => {
    const t = api(() =>
      json({
        items: [
          row({ connected_at: '2026-10-20T05:00:00.123456', last_synced_at: '2026-10-21T04:00:00' })
        ]
      })
    )
    expect(await t.api.connection()).toMatchObject({
      ok: true,
      value: {
        connectedAtMs: Date.parse('2026-10-20T05:00:00.123Z'),
        lastSyncedAtMs: Date.parse('2026-10-21T04:00:00Z')
      }
    })
  })

  it('has no last import time before the first import', async () => {
    for (const last of [null, undefined]) {
      const t = api(() => json({ items: [row({ last_synced_at: last })] }))
      expect(await t.api.connection()).toMatchObject({ ok: true, value: { lastSyncedAtMs: null } })
    }
  })

  it('is "no connection" for an empty list, not a failure', async () => {
    expect(await api(() => json({ items: [] })).api.connection()).toEqual({ ok: true, value: null })
  })

  it('takes the Google connection from the list, whatever else it holds', async () => {
    const t = api(() =>
      json({ items: [row({ connection_id: 1, provider: 'outlook' }), row({ connection_id: 2 })] })
    )
    expect(await t.api.connection()).toMatchObject({ ok: true, value: { id: '2' } })
    expect(
      await api(() => json({ items: [row({ provider: 'outlook' })] })).api.connection()
    ).toEqual({ ok: true, value: null })
  })

  it('treats any state but active as needing a new connection', async () => {
    for (const status of ['reconnect_required', 'disconnected', 'weird']) {
      const t = api(() => json({ items: [row({ status })] }))
      expect(await t.api.connection()).toMatchObject({
        ok: true,
        value: { status: 'reconnect_required' }
      })
    }
  })

  it('fails, rather than say there is no connection, when the answer cannot be read', async () => {
    for (const body of [{}, { items: 'x' }, { items: [{ connection_id: 'a' }] }, [], null])
      expect(await api(() => json(body)).api.connection()).toMatchObject({ ok: false })
    for (const status of [401, 500, 503])
      expect(await api(() => refusal(status, 'X')).api.connection()).toMatchObject({ ok: false })
  })
})

describe('asking where to give consent', () => {
  it('reads the address and when it expires', async () => {
    const t = api(() =>
      json(
        {
          authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s',
          expires_at: '2026-10-22T08:48:45.512241'
        },
        201
      )
    )
    expect(await t.api.authorize()).toEqual({
      ok: true,
      value: {
        url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s',
        expiresAtServerMs: Date.parse('2026-10-22T08:48:45.512Z')
      }
    })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/calendar/connections/google/authorizations`)
    expect(init.method).toBe('POST')
  })

  it('fails on an answer without an address, or when the server is not set up for it', async () => {
    expect(
      await api(() => json({ expires_at: '2026-10-22T08:48:45Z' }, 201)).api.authorize()
    ).toMatchObject({ ok: false })
    expect(
      await api(() =>
        json({ authorization_url: '', expires_at: '2026-10-22T08:48:45Z' }, 201)
      ).api.authorize()
    ).toMatchObject({ ok: false })
    expect(await api(() => refusal(503, 'SERVICE_UNAVAILABLE')).api.authorize()).toMatchObject({
      ok: false
    })
  })
})

describe('starting an import', () => {
  it('is queued when the server accepts it', async () => {
    const t = api(() => json({ sync_id: 'sync_1', status: 'queued' }, 202))
    expect(await t.api.sync('31')).toEqual({ kind: 'queued' })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/calendar/connections/31/syncs`)
    expect(init.method).toBe('POST')
  })

  it('says a connection that can no longer be used has to be made again', async () => {
    expect(await api(() => refusal(409, 'CALENDAR_RECONNECT_REQUIRED')).api.sync('31')).toEqual({
      kind: 'reconnect_required'
    })
  })

  it('says a connection that is gone is gone', async () => {
    expect(await api(() => refusal(404, 'RESOURCE_NOT_FOUND')).api.sync('31')).toEqual({
      kind: 'not_found'
    })
  })

  it('passes any other failure on, without the server’s wording', async () => {
    for (const status of [409, 500, 502, 503]) {
      const result = await api(() => refusal(status, 'SOMETHING')).api.sync('31')
      expect(result).toMatchObject({ kind: 'failed' })
      expect(JSON.stringify(result)).not.toContain('server wording')
    }
  })

  it('never puts an ID that is not a number into a path', async () => {
    for (const id of ['', 'abc', '../me', '1/2', '-1', '12345678901234567']) {
      const t = api(() => json({}, 202))
      expect(await t.api.sync(id)).toEqual({ kind: 'not_found' })
      expect(await t.api.disconnect(id)).toEqual({ kind: 'not_found' })
      expect(t.fetch).not.toHaveBeenCalled()
    }
  })
})

describe('disconnecting', () => {
  it('is done on a 204, with no body sent', async () => {
    const t = api(() => new Response(null, { status: 204 }))
    expect(await t.api.disconnect('31')).toEqual({ kind: 'done' })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/calendar/connections/31`)
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
  })

  it('treats a missing connection as the same end', async () => {
    expect(await api(() => refusal(404, 'RESOURCE_NOT_FOUND')).api.disconnect('31')).toEqual({
      kind: 'not_found'
    })
  })

  it('fails on any other answer or on no answer', async () => {
    expect(await api(() => refusal(500, 'X')).api.disconnect('31')).toMatchObject({
      kind: 'failed'
    })
    const down = api(() => {
      throw new TypeError('fetch failed')
    })
    expect(await down.api.disconnect('31')).toMatchObject({ kind: 'failed' })
  })

  it('hands the cancel signal on', async () => {
    const abort = new AbortController()
    const t = api(() => new Response(null, { status: 204 }))
    await t.api.disconnect('31', abort.signal)
    expect(t.fetch.mock.calls[0]![1].signal).toBeDefined()
  })
})
