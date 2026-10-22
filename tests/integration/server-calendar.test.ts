import { afterEach, describe, expect, it } from 'vitest'
import { runWhileSignedIn } from '../../src/main/auth/run-while-signed-in'
import { CalendarApi } from '../../src/main/calendar/calendar-api'
import { CalendarService } from '../../src/main/calendar/calendar-service'
import { stopAllFakeServers } from '../fixtures/fake-jarvis-server'
import { signedInApp } from '../fixtures/signed-in-app'
import { waitUntil } from '../helpers/wait'

afterEach(stopAllFakeServers)

const NOW = Date.parse('2026-10-22T03:00:00Z')
const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: 551,
  title: '회의',
  source: 'jarvis',
  is_all_day: false,
  start_at: '2026-10-22T14:30:00',
  end_at: '2026-10-22T16:00:00',
  status: 'confirmed',
  ...overrides
})
const todo = (overrides: Record<string, unknown> = {}) => ({
  todo_id: 201,
  title: '보고서',
  due_kind: 'date',
  due_date: '2026-10-22',
  due_at: null,
  status: 'open',
  ...overrides
})

async function calendarApp() {
  const app = await signedInApp()
  const service = new CalendarService({ api: new CalendarApi(app.api), now: () => NOW })
  const dispose = runWhileSignedIn(app.manager, service)
  return { ...app, service, dispose }
}

describe('calendar reads over HTTP while signed in', () => {
  it('asks with the account token and covers both local instants and UTC date boundaries', async () => {
    const t = await calendarApp()
    try {
      await t.service.navigate('today')
      const settings = t.fake.calls.find((entry) => entry.path === '/me/settings')!
      const call = t.fake.calls.find((entry) => entry.path.startsWith('/calendar/events?'))!
      const query = new URL(`http://localhost${call.path}`).searchParams
      expect(settings.authorization).toBe(`Bearer ${t.tokens.get()}`)
      expect(call.authorization).toBe(settings.authorization)
      expect(query.get('from')).toBe('2026-10-21T15:00:00.000Z')
      expect(query.get('to')).toBe('2026-10-23T00:00:00.000Z')
      expect(query.get('include_todos')).toBe('true')
      expect(t.service.getSnapshot()).toMatchObject({ status: 'ready', timeZone: 'Asia/Seoul' })
    } finally {
      t.dispose()
    }
  })

  it('shows local times, exclusive all-day dates, each part across midnight and dated to-dos', async () => {
    const t = await calendarApp()
    t.fake.calendarAnswer = {
      items: [
        event(),
        event({
          event_id: 552,
          title: '휴일',
          source: 'google',
          is_all_day: true,
          start_at: null,
          end_at: null,
          start_date: '2026-10-22',
          end_date: '2026-10-24'
        }),
        event({ event_id: 553, status: 'cancelled' }),
        event({ event_id: 554, start_at: '2026-10-26T05:00:00Z', end_at: '2026-10-26T06:00:00Z' })
      ],
      todos: [
        todo(),
        todo({
          todo_id: 202,
          due_kind: 'datetime',
          due_date: null,
          due_at: '2026-10-22T16:00:00',
          status: 'completed'
        }),
        todo({ todo_id: 203, due_kind: 'none', due_date: null })
      ]
    }
    try {
      await t.service.navigate('this_week')
      const days = t.service.getSnapshot().days
      expect(days).toHaveLength(7)
      const thursday = days.find((day) => day.date === '2026-10-22')!
      const friday = days.find((day) => day.date === '2026-10-23')!
      expect(thursday.events).toMatchObject([
        { id: '552', allDay: true, source: 'google', part: { index: 1, total: 2 } },
        { id: '551', startTime: '23:30', endTime: null, part: { index: 1, total: 2 } }
      ])
      expect(friday.events).toMatchObject([
        { id: '552', allDay: true, part: { index: 2, total: 2 } },
        { id: '551', startTime: null, endTime: '01:00', part: { index: 2, total: 2 } }
      ])
      expect(days.find((day) => day.date === '2026-10-24')!.events).toEqual([])
      expect(thursday.todos).toMatchObject([{ id: '201', due: 'date', done: false }])
      expect(friday.todos).toMatchObject([
        { id: '202', due: 'datetime', time: '01:00', done: true }
      ])
    } finally {
      t.dispose()
    }
  })

  it('keeps the earlier answer on a failed refresh and recovers, without treating failure as empty', async () => {
    const t = await calendarApp()
    t.fake.calendarAnswer = { items: [event()], todos: [] }
    try {
      await t.service.navigate('today')
      t.fake.calendarFaults.push(503)
      await t.service.navigate('refresh')
      expect(t.service.getSnapshot()).toMatchObject({
        status: 'failed',
        loadedAt: NOW,
        lastSuccessAt: NOW,
        error: { code: 'unavailable' },
        days: [{ events: [{ id: '551' }] }]
      })
      await t.service.navigate('refresh')
      expect(t.service.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    } finally {
      t.dispose()
    }
  })

  it('does not query events or guess a time zone when settings cannot be read', async () => {
    const t = await calendarApp()
    t.fake.calendarSettings = { timezone: 'Mars/Base' }
    try {
      await t.service.navigate('today')
      expect(t.fake.calls.some((call) => call.path.startsWith('/calendar/events'))).toBe(false)
      expect(t.service.getSnapshot()).toMatchObject({ status: 'failed', days: [], loadedAt: null })
    } finally {
      t.dispose()
    }
  })

  it('uses the existing token renewal path when reading protected calendar data', async () => {
    const t = await calendarApp()
    t.fake.revokedAccess.add(t.tokens.get()!)
    try {
      await t.service.navigate('today')
      expect(t.fake.count('/auth/refresh')).toBe(1)
      expect(t.service.getSnapshot().status).toBe('ready')
    } finally {
      t.dispose()
    }
  })

  it('erases the calendar on sign-out even if an HTTP answer is still on its way', async () => {
    const t = await calendarApp()
    let release!: () => void
    t.fake.calendarGate = new Promise<void>((resolve) => {
      release = resolve
    })
    t.fake.calendarAnswer = { items: [event()], todos: [] }
    try {
      const pending = t.service.navigate('today')
      await waitUntil(() => t.fake.calls.some((call) => call.path.startsWith('/calendar/events?')))
      await t.manager.signOut({
        requestId: 'signout',
        generation: t.manager.getSnapshot().generation
      })
      release()
      await pending
      expect(t.service.getSnapshot()).toMatchObject({
        status: 'idle',
        days: [],
        lastSuccessAt: null
      })
      expect(await t.service.navigate('refresh')).toMatchObject({ ok: false })
    } finally {
      release()
      t.dispose()
    }
  })
})
