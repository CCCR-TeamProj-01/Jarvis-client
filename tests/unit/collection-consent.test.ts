import { describe, expect, it, vi } from 'vitest'
import { CollectionConsentApi } from '../../src/main/commands/collection-consent'
import { ServerClient } from '../../src/main/connection/server-client'
import type { FetchLike } from '../../src/main/connection/server-client'

const BASE = 'http://127.0.0.1:8001/api/v1'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function api(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn<FetchLike>(async (url, init) => respond(url, init))
  const client = new ServerClient({ baseUrl: BASE, fetch, accessToken: () => 'tok' })
  return { api: new CollectionConsentApi(client), fetch }
}
const settings = (overrides: Record<string, unknown> = {}) => ({
  timezone: 'Asia/Seoul',
  activity_collection_enabled: true,
  external_activity_collection_enabled: false,
  daily_briefing_enabled: true,
  daily_briefing_time: '08:30:00',
  diagnostics_enabled: false,
  collection_revision: 3,
  ...overrides
})

describe('the collection settings', () => {
  it('reads both consents and the revision from the user settings', async () => {
    const t = api(() => json(settings()))
    expect(await t.api.read()).toEqual({
      ok: true,
      value: { activityEnabled: true, externalEnabled: false, revision: 3 }
    })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/me/settings`)
    expect(init.method).toBe('GET')
  })

  it('keeps the two consents apart', async () => {
    for (const [activity, external] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false]
    ] as const) {
      const t = api(() =>
        json(
          settings({
            activity_collection_enabled: activity,
            external_activity_collection_enabled: external
          })
        )
      )
      expect(await t.api.read()).toMatchObject({
        ok: true,
        value: { activityEnabled: activity, externalEnabled: external }
      })
    }
  })

  it('does not guess a consent the server did not state', async () => {
    for (const missing of [
      'activity_collection_enabled',
      'external_activity_collection_enabled',
      'collection_revision'
    ]) {
      const body: Record<string, unknown> = settings()
      delete body[missing]
      expect(await api(() => json(body)).api.read()).toMatchObject({ ok: false })
    }
  })

  it('refuses a consent that is not a plain yes or no, and a revision that is not a whole number', async () => {
    for (const bad of [
      { activity_collection_enabled: 'true' },
      { activity_collection_enabled: 1 },
      { external_activity_collection_enabled: null },
      { collection_revision: '3' },
      { collection_revision: -1 },
      { collection_revision: 1.5 }
    ])
      expect(await api(() => json(settings(bad))).api.read()).toMatchObject({ ok: false })
  })

  it('fails when the server fails, and never says "no consent" for it', async () => {
    for (const status of [401, 500, 503]) {
      const result = await api(() => json({ error: { code: 'X' } }, status)).api.read()
      expect(result).toMatchObject({ ok: false })
      expect(result).not.toHaveProperty('value')
    }
    const down = api(() => {
      throw new TypeError('fetch failed')
    })
    expect(await down.api.read()).toMatchObject({ ok: false })
  })

  it('asks with a short time limit, so a slow server does not hold up a command’s result', async () => {
    const request = vi.fn<() => Promise<unknown>>(async () => ({
      ok: false as const,
      error: { code: 'unavailable', message: 'x' },
      detail: { delivery: 'no_response' }
    }))
    await new CollectionConsentApi({ request } as unknown as ServerClient).read()
    const sent = request.mock.calls[0] as unknown as [{ timeoutMs: number }]
    expect(sent[0].timeoutMs).toBeGreaterThan(0)
    expect(sent[0].timeoutMs).toBeLessThanOrEqual(5000)
  })
})

const refusal = (status: number) =>
  json({ error: { code: 'X', message: 'server wording' } }, status)
const sentBody = (t: { fetch: ReturnType<typeof vi.fn<FetchLike>> }) => {
  const [url, init] = t.fetch.mock.calls[0]!
  return {
    url: url.replace(BASE, ''),
    method: init.method,
    body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
  }
}

describe('changing the collection settings', () => {
  it('sends only the flag named, as the server spells it, and reads what the server holds from the answer', async () => {
    const t = api(() =>
      json(settings({ activity_collection_enabled: false, collection_revision: 4 }))
    )
    expect(await t.api.change({ activity: false })).toEqual({
      kind: 'done',
      value: { activityEnabled: false, externalEnabled: false, revision: 4 }
    })
    expect(sentBody(t)).toEqual({
      url: '/me/settings',
      method: 'PATCH',
      body: { activity_collection_enabled: false }
    })
  })

  it('sends both flags when both are named, and a flag left out is not sent', async () => {
    const both = api(() => json(settings()))
    await both.api.change({ activity: false, external: false })
    expect(sentBody(both).body).toEqual({
      activity_collection_enabled: false,
      external_activity_collection_enabled: false
    })
    const external = api(() => json(settings()))
    await external.api.change({ external: true })
    expect(sentBody(external).body).toEqual({ external_activity_collection_enabled: true })
  })

  it('counts a refusal as nothing changed, and a server error or a lost answer as not known', async () => {
    const refused = await api(() => refusal(422)).api.change({ activity: false })
    expect(refused).toMatchObject({ kind: 'rejected', error: { code: 'invalid_input' } })
    expect(JSON.stringify(refused)).not.toContain('server wording')
    expect(await api(() => refusal(403)).api.change({ activity: false })).toMatchObject({
      kind: 'rejected'
    })
    for (const respond of [() => refusal(500), () => refusal(503), () => json({ timezone: 'x' })])
      expect(await api(respond).api.change({ activity: false })).toMatchObject({ kind: 'unknown' })
    const dropped = api(() => {
      throw new TypeError('connection reset')
    })
    expect(await dropped.api.change({ activity: false })).toMatchObject({ kind: 'unknown' })
  })

  it('counts a request that never left as a refusal', async () => {
    const t = api(() => json(settings()))
    const aborted = new AbortController()
    aborted.abort()
    expect(await t.api.change({ activity: false }, aborted.signal)).toMatchObject({
      kind: 'rejected'
    })
    expect(t.fetch).not.toHaveBeenCalled()
  })
})
