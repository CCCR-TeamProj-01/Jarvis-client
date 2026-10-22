import { describe, expect, it, vi } from 'vitest'
import { CalendarApi } from '../../src/main/calendar/calendar-api'
import { ServerClient } from '../../src/main/connection/server-client'
import type { FetchLike } from '../../src/main/connection/server-client'

const BASE = 'http://127.0.0.1:8001/api/v1'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function api(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn<FetchLike>(async (url, init) => respond(url, init))
  const client = new ServerClient({ baseUrl: BASE, fetch, accessToken: () => 'tok' })
  return { api: new CalendarApi(client), fetch }
}

const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: 551,
  title: '중간 프로젝트 회의',
  source: 'jarvis',
  is_all_day: false,
  start_at: '2026-10-22T05:00:00Z',
  end_at: '2026-10-22T06:00:00Z',
  start_date: null,
  end_date: null,
  status: 'confirmed',
  ...overrides
})
const todo = (overrides: Record<string, unknown> = {}) => ({
  todo_id: 200,
  title: '보고서 쓰기',
  due_kind: 'date',
  due_date: '2026-10-22',
  due_at: null,
  status: 'open',
  ...overrides
})
const ASKED = {
  fromMs: Date.parse('2026-10-21T15:00:00Z'),
  toMs: Date.parse('2026-10-23T00:00:00Z')
}

describe('the time zone', () => {
  it('reads it from the user settings', async () => {
    const t = api(() =>
      json({ timezone: 'Asia/Seoul', daily_briefing_enabled: true, collection_revision: 3 })
    )
    expect(await t.api.timeZone()).toEqual({ ok: true, value: 'Asia/Seoul' })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/me/settings`)
    expect(init.method).toBe('GET')
  })

  it('fails when the answer has no time zone', async () => {
    for (const body of [{}, { timezone: '' }, { timezone: 9 }, []]) {
      const t = api(() => json(body))
      expect(await t.api.timeZone()).toMatchObject({ ok: false })
    }
  })

  it('passes a server failure on', async () => {
    const t = api(() => json({ error: { code: 'INTERNAL_ERROR' } }, 503))
    expect(await t.api.timeZone()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })
})

describe('asking for events', () => {
  it('asks for the period as instants, with to-dos', async () => {
    const t = api(() => json({ items: [], todos: [] }))
    await t.api.events(ASKED)
    const [url, init] = t.fetch.mock.calls[0]!
    const asked = new URL(url)
    expect(asked.pathname).toBe('/api/v1/calendar/events')
    expect(asked.searchParams.get('from')).toBe('2026-10-21T15:00:00.000Z')
    expect(asked.searchParams.get('to')).toBe('2026-10-23T00:00:00.000Z')
    expect(asked.searchParams.get('include_todos')).toBe('true')
    expect(asked.searchParams.has('include_cancelled')).toBe(false)
    expect(init.method).toBe('GET')
  })

  it('reads a timed event, an all-day event and a to-do as the real server sends them', async () => {
    const t = api(() =>
      json({
        items: [
          event(),
          event({
            event_id: 552,
            title: '추석',
            source: 'google',
            is_all_day: true,
            start_at: null,
            end_at: null,
            start_date: '2026-10-22',
            end_date: '2026-10-24'
          })
        ],
        todos: [todo()]
      })
    )
    expect(await t.api.events(ASKED)).toEqual({
      ok: true,
      value: {
        events: [
          {
            id: '551',
            title: '중간 프로젝트 회의',
            source: 'jarvis',
            cancelled: false,
            allDay: false,
            startMs: Date.parse('2026-10-22T05:00:00Z'),
            endMs: Date.parse('2026-10-22T06:00:00Z')
          },
          {
            id: '552',
            title: '추석',
            source: 'google',
            cancelled: false,
            allDay: true,
            startDate: '2026-10-22',
            endDate: '2026-10-24'
          }
        ],
        todos: [
          {
            id: '200',
            title: '보고서 쓰기',
            due: { kind: 'date', date: '2026-10-22' },
            done: false
          }
        ]
      }
    })
  })

  it('reads a time without a zone as UTC, as the real server sends it', async () => {
    const t = api(() =>
      json({
        items: [event({ start_at: '2026-10-22T05:00:00', end_at: '2026-10-22T06:00:00.250000' })],
        todos: [todo({ due_kind: 'datetime', due_date: null, due_at: '2026-10-22T08:30:00' })]
      })
    )
    const answer = await t.api.events(ASKED)
    expect(answer).toMatchObject({
      ok: true,
      value: {
        events: [
          {
            startMs: Date.parse('2026-10-22T05:00:00Z'),
            endMs: Date.parse('2026-10-22T06:00:00.250Z')
          }
        ],
        todos: [{ due: { kind: 'datetime', atMs: Date.parse('2026-10-22T08:30:00Z') } }]
      }
    })
  })

  it('takes a to-do in either of the states it is called', async () => {
    const t = api(() =>
      json({
        items: [],
        todos: [
          todo({ todo_id: 1, status: 'open' }),
          todo({ todo_id: 2, status: 'pending' }),
          todo({ todo_id: 3, status: 'completed' })
        ]
      })
    )
    const answer = await t.api.events(ASKED)
    expect(answer.ok && answer.value.todos.map((item) => item.done)).toEqual([false, false, true])
  })

  it('keeps the cancelled state, and names an unknown source "other"', async () => {
    const t = api(() =>
      json({ items: [event({ status: 'cancelled', source: 'outlook' })], todos: [] })
    )
    const answer = await t.api.events(ASKED)
    expect(answer).toMatchObject({
      ok: true,
      value: { events: [{ cancelled: true, source: 'other' }] }
    })
  })

  it('does not need a to-do list, and carries no to-do without a deadline', async () => {
    const without = api(() => json({ items: [event()] }))
    expect(await without.api.events(ASKED)).toMatchObject({ ok: true, value: { todos: [] } })
    const none = api(() =>
      json({
        items: [],
        todos: [todo({ due_kind: 'none', due_date: null, due_at: null }), todo({ todo_id: 201 })]
      })
    )
    const answer = await none.api.events(ASKED)
    expect(answer.ok && answer.value.todos.map((item) => item.id)).toEqual(['201'])
  })

  it('infers the kind of a to-do when the server leaves it out', async () => {
    const t = api(() =>
      json({
        items: [],
        todos: [
          todo({ todo_id: 1, due_kind: null }),
          todo({ todo_id: 2, due_kind: null, due_date: null, due_at: '2026-10-22T08:00:00Z' })
        ]
      })
    )
    const answer = await t.api.events(ASKED)
    expect(answer.ok && answer.value.todos.map((item) => item.due.kind)).toEqual([
      'date',
      'datetime'
    ])
  })

  it('fails the whole answer for one item it cannot read, rather than show a calendar with a gap', async () => {
    const bad: Record<string, unknown>[] = [
      event({ start_at: null }),
      event({ end_at: null }),
      event({ end_at: 'tomorrow' }),
      event({ start_at: '2026-10-22T06:00:00Z', end_at: '2026-10-22T05:00:00Z' }),
      event({ is_all_day: true, start_at: null, end_at: null, start_date: null }),
      event({ is_all_day: true, start_at: null, end_at: null, start_date: '2026-02-30' }),
      event({
        is_all_day: true,
        start_at: null,
        end_at: null,
        start_date: '2026-10-22',
        end_date: 'x'
      }),
      event({ event_id: 'abc' }),
      event({ title: null })
    ]
    for (const item of bad) {
      const t = api(() => json({ items: [event({ event_id: 1 }), item], todos: [] }))
      expect(await t.api.events(ASKED)).toMatchObject({ ok: false })
    }
    const badTodos = [
      todo({ due_date: null }),
      todo({ due_date: '2026-13-01' }),
      todo({ due_kind: 'datetime', due_at: null }),
      todo({ due_kind: 'sometime' })
    ]
    for (const item of badTodos) {
      const t = api(() => json({ items: [], todos: [item] }))
      expect(await t.api.events(ASKED)).toMatchObject({ ok: false })
    }
  })

  it('fails on a body that is not a list', async () => {
    for (const body of [{}, { items: 'x' }, [], null]) {
      const t = api(() => json(body))
      expect(await t.api.events(ASKED)).toMatchObject({ ok: false })
    }
  })

  it('passes the failure of a refused or broken call on, never as an empty calendar', async () => {
    for (const status of [401, 422, 500, 503]) {
      const t = api(() => json({ error: { code: 'X' } }, status))
      expect(await t.api.events(ASKED)).toMatchObject({ ok: false })
    }
    const down = api(() => {
      throw new TypeError('fetch failed')
    })
    expect(await down.api.events(ASKED)).toMatchObject({ ok: false })
  })

  it('hands the cancel signal on', async () => {
    const abort = new AbortController()
    const seen: (AbortSignal | null | undefined)[] = []
    const t = api((_url, init) => {
      seen.push(init.signal)
      return json({ items: [], todos: [] })
    })
    await t.api.events(ASKED, abort.signal)
    await t.api.timeZone(abort.signal)
    expect(seen).toHaveLength(2)
    for (const signal of seen) expect(signal).toBeDefined()
  })
})

describe('changing events', () => {
  const timedEvent = {
    title: '팀 회의',
    allDay: false,
    startMs: Date.parse('2026-10-22T05:00:00Z'),
    endMs: Date.parse('2026-10-22T06:00:00Z')
  } as const
  const allDayEvent = {
    title: '출장',
    allDay: true,
    startDate: '2026-10-26',
    endDate: '2026-10-28'
  } as const
  const created = (id = 551) => json({ ...event({ event_id: id }) }, 201)
  const bodyOf = (init: RequestInit) => JSON.parse(String(init.body))

  it('adds a timed event with every field named, the unused ones null', async () => {
    const t = api(() => created())
    expect(await t.api.createEvent(timedEvent)).toEqual({ kind: 'done' })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/calendar/events`)
    expect(init.method).toBe('POST')
    expect(bodyOf(init)).toEqual({
      title: '팀 회의',
      is_all_day: false,
      start_at: '2026-10-22T05:00:00.000Z',
      end_at: '2026-10-22T06:00:00.000Z',
      start_date: null,
      end_date: null
    })
  })

  it('adds an all-day event as dates only, with the end the server expects', async () => {
    const t = api(() => created())
    await t.api.createEvent(allDayEvent)
    expect(bodyOf(t.fetch.mock.calls[0]![1])).toEqual({
      title: '출장',
      is_all_day: true,
      start_at: null,
      end_at: null,
      start_date: '2026-10-26',
      end_date: '2026-10-28'
    })
  })

  it('sends the same body for a change, so a switch between kinds clears the other kind', async () => {
    const t = api(() => json(event()))
    expect(await t.api.updateEvent('551', allDayEvent)).toEqual({ kind: 'done' })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/calendar/events/551`)
    expect(init.method).toBe('PATCH')
    expect(bodyOf(init)).toMatchObject({ is_all_day: true, start_at: null, end_at: null })
  })

  it('deletes with no body', async () => {
    const t = api(() => new Response(null, { status: 204 }))
    expect(await t.api.deleteEvent('551')).toEqual({ kind: 'done' })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/calendar/events/551`)
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
  })

  it('does not send an Idempotency-Key, which the server ignores for events', async () => {
    const t = api(() => created())
    await t.api.createEvent(timedEvent)
    const headers = t.fetch.mock.calls[0]![1].headers as Record<string, string>
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('idempotency-key')
  })

  it('does not put an ID that is not a number into a path', async () => {
    for (const id of ['', 'abc', '../me', '12/34', '1 2', '-1', '12345678901234567']) {
      const t = api(() => json(event()))
      expect(await t.api.updateEvent(id, timedEvent)).toMatchObject({
        kind: 'rejected',
        reason: 'not_found'
      })
      expect(await t.api.deleteEvent(id)).toMatchObject({ kind: 'rejected', reason: 'not_found' })
      expect(t.fetch).not.toHaveBeenCalled()
    }
  })

  const refusal = (status: number, code: string) =>
    api(() => json({ error: { code, message: 'server wording' } }, status))

  it('says a Google event cannot be changed, with its own words', async () => {
    const t = refusal(409, 'EXTERNAL_EVENT_READ_ONLY')
    const result = await t.api.updateEvent('551', timedEvent)
    expect(result).toMatchObject({ kind: 'rejected', reason: 'read_only' })
    expect(JSON.stringify(result)).not.toContain('server wording')
    expect(await refusal(409, 'EXTERNAL_EVENT_READ_ONLY').api.deleteEvent('551')).toMatchObject({
      kind: 'rejected',
      reason: 'read_only'
    })
  })

  it('says an event that is gone is gone', async () => {
    expect(await refusal(404, 'RESOURCE_NOT_FOUND').api.deleteEvent('551')).toMatchObject({
      kind: 'rejected',
      reason: 'not_found'
    })
  })

  it('says the server did not accept what was sent, without its wording', async () => {
    const result = await refusal(422, 'VALIDATION_ERROR').api.createEvent(timedEvent)
    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalid' })
    expect(JSON.stringify(result)).not.toContain('server wording')
  })

  it('treats any other refusal as nothing changed', async () => {
    for (const status of [400, 401, 403, 409, 429]) {
      const result = await refusal(status, 'X').api.createEvent(timedEvent)
      expect(result).toMatchObject({ kind: 'rejected', reason: 'other' })
    }
  })

  it('is open about whether it went through when the answer did not come', async () => {
    // Connected, then no answer: the server may have stored it.
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    const lost = api(() => {
      throw reset
    })
    expect(await lost.api.createEvent(timedEvent)).toMatchObject({ kind: 'unknown' })
  })

  it('is open about it too when the server failed, or its answer cannot be read', async () => {
    for (const status of [500, 502, 503, 504])
      expect(await refusal(status, 'INTERNAL_ERROR').api.createEvent(timedEvent)).toMatchObject({
        kind: 'unknown'
      })
    // A created answer that is not an event: it was created, but we cannot say so.
    expect(await api(() => json({ ok: true }, 201)).api.createEvent(timedEvent)).toMatchObject({
      kind: 'unknown'
    })
    expect(
      await api(
        () => new Response('not json', { status: 201, headers: { 'content-type': 'text/plain' } })
      ).api.createEvent(timedEvent)
    ).toMatchObject({ kind: 'unknown' })
  })

  it('knows a request that never left was not sent', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' }
    })
    const down = api(() => {
      throw refused
    })
    expect(await down.api.createEvent(timedEvent)).toMatchObject({
      kind: 'rejected',
      reason: 'other'
    })
  })

  it('stops with the cancel signal and reports it as not sent or unknown, never as done', async () => {
    const abort = new AbortController()
    abort.abort()
    const t = api(() => created())
    const result = await t.api.createEvent(timedEvent, abort.signal)
    expect(result.kind).not.toBe('done')
    expect(t.fetch).not.toHaveBeenCalled()
  })
})
