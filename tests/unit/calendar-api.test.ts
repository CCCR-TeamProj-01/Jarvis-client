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
