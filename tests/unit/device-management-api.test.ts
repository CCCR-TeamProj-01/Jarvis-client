import { describe, expect, it, vi } from 'vitest'
import { ServerClient } from '../../src/main/connection/server-client'
import type { FetchLike } from '../../src/main/connection/server-client'
import { DeviceManagementApi } from '../../src/main/devices/device-management-api'

const BASE = 'http://127.0.0.1:8001/api/v1'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refusal = (status: number, code = 'X') =>
  json({ error: { code, message: 'server wording' } }, status)

function api(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn<FetchLike>(async (url, init) => respond(url, init))
  const client = new ServerClient({ baseUrl: BASE, fetch, accessToken: () => 'tok' })
  return { api: new DeviceManagementApi(client), fetch }
}
const sent = (t: { fetch: ReturnType<typeof vi.fn<FetchLike>> }, index = 0) => {
  const [url, init] = t.fetch.mock.calls[index]!
  return {
    url: url.replace(BASE, ''),
    method: init.method,
    body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
  }
}

const row = (overrides: Record<string, unknown> = {}) => ({
  device_id: 12,
  device_name: '집 데스크톱',
  platform: 'windows',
  client_version: '0.1.0',
  last_seen_at: '2026-10-21T05:00:00Z',
  is_current: true,
  ...overrides
})
const appRow = (overrides: Record<string, unknown> = {}) => ({
  device_app_id: 44,
  app_code: 'chrome',
  os_app_id: 'chrome.exe',
  display_name: 'Google Chrome',
  is_allowed: true,
  ...overrides
})

describe('reading the devices', () => {
  it('reads each field the spec describes', async () => {
    const t = api(() => json({ items: [row()] }))
    expect(await t.api.devices()).toEqual({
      ok: true,
      value: [
        {
          id: '12',
          name: '집 데스크톱',
          platform: 'windows',
          clientVersion: '0.1.0',
          lastSeenAtMs: Date.parse('2026-10-21T05:00:00Z'),
          current: true
        }
      ]
    })
    expect(sent(t)).toMatchObject({ url: '/devices', method: 'GET' })
  })

  it('reads a time without a zone as UTC, and a missing version or time as null', async () => {
    const t = api(() =>
      json({
        items: [
          row({ last_seen_at: '2026-10-21T05:00:00.123456', client_version: null }),
          row({ device_id: 13, last_seen_at: null, client_version: undefined, is_current: false })
        ]
      })
    )
    const result = await t.api.devices()
    expect(
      result.ok && result.value.map((item) => [item.lastSeenAtMs, item.clientVersion])
    ).toEqual([
      [Date.parse('2026-10-21T05:00:00.123Z'), null],
      [null, null]
    ])
  })

  it('calls a system it does not know "other" rather than guessing', async () => {
    const t = api(() =>
      json({
        items: [
          row({ platform: 'macos' }),
          row({ device_id: 13, platform: 'linux' }),
          row({ device_id: 14, platform: '' })
        ]
      })
    )
    const result = await t.api.devices()
    expect(result.ok && result.value.map((item) => item.platform)).toEqual([
      'macos',
      'other',
      'other'
    ])
  })

  it('refuses an answer in the wrong shape and keeps the server’s words out of the error', async () => {
    for (const body of [
      { items: [row({ device_id: -1 })] },
      { items: [{ ...row(), is_current: 'yes' }] },
      { items: 1 },
      []
    ]) {
      const result = await api(() => json(body)).api.devices()
      expect(result.ok).toBe(false)
    }
    const failed = await api(() => refusal(401, 'INVALID_SESSION')).api.devices()
    expect(failed.ok).toBe(false)
    expect(JSON.stringify(failed)).not.toContain('server wording')
  })
})

describe('renaming', () => {
  it('sends the name alone to the device’s own address and returns the name the server holds', async () => {
    const t = api(() => json({ device_id: 13, device_name: '서버의 이름', platform: 'windows' }))
    expect(await t.api.rename('13', '작업실 PC')).toEqual({
      kind: 'done',
      value: { name: '서버의 이름' }
    })
    expect(sent(t)).toEqual({
      url: '/devices/13',
      method: 'PATCH',
      body: { device_name: '작업실 PC' }
    })
  })

  it('never lets an ID reshape the address', async () => {
    const t = api(() => json({}))
    for (const id of ['', '../auth/logout', '13/sessions', '13?x=1', '-1', '1'.repeat(17), 'abc'])
      expect(await t.api.rename(id, 'x')).toEqual({ kind: 'not_found' })
    expect(await t.api.signOutDevice('13/../x')).toEqual({ kind: 'not_found' })
    expect(await t.api.setAppAllowed('../x', true)).toEqual({ kind: 'not_found' })
    expect(t.fetch).not.toHaveBeenCalled()
  })

  it('tells a missing device, a refusal and an unknown outcome apart', async () => {
    expect(await api(() => refusal(404, 'DEVICE_NOT_FOUND')).api.rename('13', 'x')).toEqual({
      kind: 'not_found'
    })
    const refused = await api(() => refusal(422, 'VALIDATION_ERROR')).api.rename('13', 'x')
    expect(refused).toMatchObject({ kind: 'rejected', error: { code: 'invalid_input' } })
    expect(JSON.stringify(refused)).not.toContain('server wording')
    for (const respond of [() => refusal(500), () => refusal(503), () => json({ device_id: 13 })])
      expect(await api(respond).api.rename('13', 'x')).toMatchObject({ kind: 'unknown' })
    const dropped = api(() => {
      throw new TypeError('connection reset')
    })
    expect(await dropped.api.rename('13', 'x')).toMatchObject({ kind: 'unknown' })
  })

  it('counts a request that never left as a refusal: nothing was changed', async () => {
    const t = api(() => json({}))
    const aborted = new AbortController()
    aborted.abort()
    expect(await t.api.rename('13', 'x', aborted.signal)).toMatchObject({ kind: 'rejected' })
    expect(await t.api.signOutAll(aborted.signal)).toMatchObject({ kind: 'rejected' })
    expect(t.fetch).not.toHaveBeenCalled()
  })

  it('never sends a change a second time on its own', async () => {
    const failing = api(() => refusal(503))
    await failing.api.rename('13', 'x')
    await failing.api.signOutAll()
    expect(failing.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('ending sessions', () => {
  it('ends one device’s sessions without a body, and the whole account’s with one request', async () => {
    const t = api(() => new Response(null, { status: 204 }))
    expect(await t.api.signOutDevice('13')).toEqual({ kind: 'done', value: undefined })
    expect(await t.api.signOutAll()).toEqual({ kind: 'done', value: undefined })
    expect(sent(t, 0)).toEqual({ url: '/devices/13/sessions', method: 'DELETE', body: undefined })
    expect(sent(t, 1)).toEqual({ url: '/auth/logout-all', method: 'POST', body: undefined })
  })

  it('counts a refusal as nothing changed and a server error as not known', async () => {
    expect(await api(() => refusal(404)).api.signOutDevice('13')).toEqual({ kind: 'not_found' })
    expect(await api(() => refusal(403)).api.signOutAll()).toMatchObject({ kind: 'rejected' })
    expect(await api(() => refusal(500)).api.signOutAll()).toMatchObject({ kind: 'unknown' })
  })
})

describe('the apps of this device', () => {
  it('reads a page with the page size and the place to continue from', async () => {
    const t = api(() =>
      json({
        items: [
          appRow(),
          appRow({ device_app_id: 45, app_code: null, display_name: 'Foo', is_allowed: false })
        ],
        next_cursor: 'abc',
        has_more: true
      })
    )
    expect(await t.api.apps('prev')).toEqual({
      ok: true,
      value: {
        items: [
          { id: '44', appCode: 'chrome', name: 'Google Chrome', allowed: true },
          { id: '45', appCode: null, name: 'Foo', allowed: false }
        ],
        next: 'abc',
        more: true
      }
    })
    expect(sent(t).url).toBe('/device/apps?limit=100&cursor=prev')
    const first = api(() => json({ items: [], next_cursor: null, has_more: false }))
    await first.api.apps(null)
    expect(sent(first).url).toBe('/device/apps?limit=100')
  })

  it('does not follow a cursor when the server says the last page was read', async () => {
    const last = await api(() =>
      json({ items: [appRow()], next_cursor: 'left-over', has_more: false })
    ).api.apps(null)
    expect(last).toMatchObject({ ok: true, value: { next: null, more: false } })
    // No flag: a cursor means there is more, no cursor means there is not.
    const bare = await api(() => json({ items: [appRow()], next_cursor: 'abc' })).api.apps(null)
    expect(bare).toMatchObject({ ok: true, value: { next: 'abc', more: true } })
    const done = await api(() => json({ items: [appRow()] })).api.apps(null)
    expect(done).toMatchObject({ ok: true, value: { next: null, more: false } })
    // More, but nowhere to continue from: it is not followed, and the list is not called whole.
    const stuck = await api(() =>
      json({ items: [appRow()], next_cursor: null, has_more: true })
    ).api.apps(null)
    expect(stuck).toMatchObject({ ok: true, value: { next: null, more: true } })
  })

  it('changes only is_allowed, and returns the value the server holds', async () => {
    const t = api(() =>
      json({
        device_app_id: 44,
        app_code: 'chrome',
        display_name: 'Google Chrome',
        is_allowed: false
      })
    )
    expect(await t.api.setAppAllowed('44', false)).toEqual({
      kind: 'done',
      value: { allowed: false }
    })
    expect(sent(t)).toEqual({
      url: '/device/apps/44',
      method: 'PATCH',
      body: { is_allowed: false }
    })
    expect(await api(() => refusal(404, 'NOT_FOUND')).api.setAppAllowed('44', true)).toEqual({
      kind: 'not_found'
    })
    expect(await api(() => refusal(422)).api.setAppAllowed('44', true)).toMatchObject({
      kind: 'rejected'
    })
    expect(await api(() => refusal(502)).api.setAppAllowed('44', true)).toMatchObject({
      kind: 'unknown'
    })
  })
})
