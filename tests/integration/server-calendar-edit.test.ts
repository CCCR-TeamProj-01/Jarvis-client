import { afterEach, describe, expect, it } from 'vitest'
import { runWhileSignedIn } from '../../src/main/auth/run-while-signed-in'
import { CalendarApi } from '../../src/main/calendar/calendar-api'
import { CalendarService } from '../../src/main/calendar/calendar-service'
import type { CalendarEventDraft } from '../../src/shared/contracts/calendar'
import { FakeCalendarStore } from '../fixtures/fake-calendar-store'
import { stopAllFakeServers } from '../fixtures/fake-jarvis-server'
import { signedInApp } from '../fixtures/signed-in-app'

afterEach(stopAllFakeServers)

const NOW = Date.parse('2026-10-22T03:00:00Z') // 12:00 on the 22nd in Seoul

const timed = (overrides: Partial<CalendarEventDraft> = {}): CalendarEventDraft => ({
  title: '팀 회의',
  allDay: false,
  startDate: '2026-10-22',
  startTime: '14:00',
  endDate: '2026-10-22',
  endTime: '15:00',
  ...overrides
})
const allDay = (overrides: Partial<CalendarEventDraft> = {}): CalendarEventDraft => ({
  title: '출장',
  allDay: true,
  startDate: '2026-10-26',
  startTime: null,
  endDate: '2026-10-27',
  endTime: null,
  ...overrides
})

/** The real client stack against a stand-in server that follows the real server's calendar rules. */
async function editingApp() {
  const app = await signedInApp()
  const store = new FakeCalendarStore()
  app.fake.calendarStore = store
  const service = new CalendarService({ api: new CalendarApi(app.api), now: () => NOW })
  const dispose = runWhileSignedIn(app.manager, service)
  await service.navigate('this_month')
  app.fake.calls.length = 0
  const changes = () =>
    app.fake.calls.filter((call) => ['POST', 'PATCH', 'DELETE'].includes(call.method))
  const shown = (date: string) =>
    service.getSnapshot().days.find((day) => day.date === date)?.events ?? []
  return { ...app, store, service, dispose, changes, shown }
}
const outcome = (result: { ok: boolean; value?: { outcome: string } }) =>
  result.ok ? result.value!.outcome : 'refused'

describe('adding an event over HTTP', () => {
  it('stores a timed event in UTC and shows it in local time, after reading the calendar again', async () => {
    const t = await editingApp()
    try {
      expect(outcome(await t.service.createEvent(timed()))).toBe('saved')
      expect(t.store.events).toHaveLength(1)
      expect(t.store.events[0]).toMatchObject({
        title: '팀 회의',
        source: 'jarvis',
        is_all_day: false,
        start_at: Date.parse('2026-10-22T05:00:00Z'),
        end_at: Date.parse('2026-10-22T06:00:00Z'),
        start_date: null,
        end_date: null
      })
      expect(t.shown('2026-10-22')).toMatchObject([
        { title: '팀 회의', startTime: '14:00', endTime: '15:00', source: 'jarvis' }
      ])
      // The zone, the change, then the read that shows it.
      expect(t.fake.calls.map((call) => `${call.method} ${call.path.split('?')[0]}`)).toEqual([
        'GET /me/settings',
        'POST /calendar/events',
        'GET /me/settings',
        'GET /calendar/events'
      ])
    } finally {
      t.dispose()
    }
  })

  it('stores an all-day event with an exclusive end and shows it on each of its days only', async () => {
    const t = await editingApp()
    try {
      expect(outcome(await t.service.createEvent(allDay()))).toBe('saved')
      expect(t.store.events[0]).toMatchObject({
        is_all_day: true,
        start_date: '2026-10-26',
        end_date: '2026-10-28',
        start_at: null,
        end_at: null
      })
      expect(t.shown('2026-10-25')).toEqual([])
      expect(t.shown('2026-10-26')).toMatchObject([{ allDay: true, part: { index: 1, total: 2 } }])
      expect(t.shown('2026-10-27')).toMatchObject([{ allDay: true, part: { index: 2, total: 2 } }])
      expect(t.shown('2026-10-28')).toEqual([])
    } finally {
      t.dispose()
    }
  })

  it('shows an all-day event on the first and last day of what is looked at, which the server compares by UTC date', async () => {
    const t = await editingApp()
    try {
      // The first day of the month view, then the last. Read as UTC dates, the server would drop them.
      await t.service.createEvent(
        allDay({ title: '첫날', startDate: '2026-10-01', endDate: '2026-10-01' })
      )
      await t.service.createEvent(
        allDay({ title: '말일', startDate: '2026-10-31', endDate: '2026-10-31' })
      )
      expect(t.shown('2026-10-01')).toMatchObject([{ title: '첫날' }])
      expect(t.shown('2026-10-31')).toMatchObject([{ title: '말일' }])
      await t.service.navigate('today')
      await t.service.createEvent(
        allDay({ title: '오늘 종일', startDate: '2026-10-22', endDate: '2026-10-22' })
      )
      expect(t.shown('2026-10-22')).toMatchObject([{ title: '오늘 종일' }])
    } finally {
      t.dispose()
    }
  })

  it('does not send the same add twice when the answer is lost, and says it cannot tell', async () => {
    const t = await editingApp()
    try {
      t.store.faults.push('lost')
      const result = await t.service.createEvent(timed())
      expect(outcome(result)).toBe('unknown')
      // The server did take it; nothing here sent it again.
      expect(t.store.events).toHaveLength(1)
      expect(t.changes()).toHaveLength(1)
      // It is not shown until the user looks; then it is there, once.
      expect(t.shown('2026-10-22')).toEqual([])
      await t.service.navigate('refresh')
      expect(t.shown('2026-10-22')).toHaveLength(1)
    } finally {
      t.dispose()
    }
  })

  it.each([500, 502, 503, 504])(
    'says it cannot tell after a %i, and sends once',
    async (status) => {
      const t = await editingApp()
      try {
        t.store.faults.push(status)
        expect(outcome(await t.service.createEvent(timed()))).toBe('unknown')
        expect(t.changes()).toHaveLength(1)
      } finally {
        t.dispose()
      }
    }
  )

  it('says nothing was saved when the server refuses, with its own words and no server text', async () => {
    const t = await editingApp()
    try {
      t.store.faults.push(422)
      const result = await t.service.createEvent(timed())
      expect(result).toMatchObject({
        ok: true,
        value: { outcome: 'not_saved', error: { code: 'invalid_input' } }
      })
      expect(JSON.stringify(result)).not.toContain('FAULT')
      expect(t.store.events).toHaveLength(0)
    } finally {
      t.dispose()
    }
  })

  it('renews an expired session and adds the event once', async () => {
    const t = await editingApp()
    try {
      t.fake.revokedAccess.add(t.tokens.get() ?? '')
      expect(outcome(await t.service.createEvent(timed()))).toBe('saved')
      expect(t.fake.count('/auth/refresh')).toBeGreaterThanOrEqual(1)
      expect(t.store.events).toHaveLength(1)
    } finally {
      t.dispose()
    }
  })

  it('makes two events for the same add sent twice, as the real server does; this is why it is never resent', async () => {
    const t = await editingApp()
    try {
      const send = () =>
        fetch(`${t.baseUrl}/calendar/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${t.tokens.get()}`,
            'idempotency-key': 'same-key-0001'
          },
          body: JSON.stringify({
            title: 'x',
            is_all_day: false,
            start_at: '2026-10-22T05:00:00Z',
            end_at: '2026-10-22T06:00:00Z'
          })
        })
      await send()
      await send()
      expect(t.store.events).toHaveLength(2)
    } finally {
      t.dispose()
    }
  })
})

describe('changing an event over HTTP', () => {
  it('changes the title and the time, and shows the new ones', async () => {
    const t = await editingApp()
    try {
      await t.service.createEvent(timed())
      const id = t.shown('2026-10-22')[0]!.id
      const result = await t.service.updateEvent(
        id,
        timed({ title: '바뀐 회의', startTime: '16:00', endTime: '17:30' })
      )
      expect(outcome(result)).toBe('saved')
      expect(t.shown('2026-10-22')).toMatchObject([
        { title: '바뀐 회의', startTime: '16:00', endTime: '17:30' }
      ])
      expect(t.store.events).toHaveLength(1)
    } finally {
      t.dispose()
    }
  })

  it('turns a timed event into an all-day one and back, with the other kind of field cleared', async () => {
    const t = await editingApp()
    try {
      await t.service.createEvent(timed())
      const id = t.shown('2026-10-22')[0]!.id
      expect(
        outcome(
          await t.service.updateEvent(
            id,
            allDay({ startDate: '2026-10-22', endDate: '2026-10-23' })
          )
        )
      ).toBe('saved')
      expect(t.store.events[0]).toMatchObject({
        is_all_day: true,
        start_at: null,
        end_at: null,
        start_date: '2026-10-22',
        end_date: '2026-10-24'
      })
      expect(
        outcome(
          await t.service.updateEvent(
            id,
            timed({ title: '출장', startTime: '09:00', endTime: '10:00' })
          )
        )
      ).toBe('saved')
      expect(t.store.events[0]).toMatchObject({
        is_all_day: false,
        start_date: null,
        end_date: null,
        start_at: Date.parse('2026-10-22T00:00:00Z')
      })
    } finally {
      t.dispose()
    }
  })

  it('opens an event for editing with its whole extent, and saving it unchanged changes nothing', async () => {
    const t = await editingApp()
    try {
      await t.service.createEvent(
        timed({ startTime: '22:00', endDate: '2026-10-23', endTime: '02:00', title: '야간 작업' })
      )
      const before = { ...t.store.events[0]! }
      const item = t.shown('2026-10-23')[0]!
      expect(item.extent).toEqual({
        startDate: '2026-10-22',
        startTime: '22:00',
        endDate: '2026-10-23',
        endTime: '02:00'
      })
      expect(
        outcome(
          await t.service.updateEvent(item.id, {
            title: item.title,
            allDay: item.allDay,
            ...item.extent
          })
        )
      ).toBe('saved')
      expect(t.store.events[0]).toEqual(before)
    } finally {
      t.dispose()
    }
  })

  it('opens an all-day event with its last day, and saving it unchanged changes nothing', async () => {
    const t = await editingApp()
    try {
      await t.service.createEvent(allDay())
      const before = { ...t.store.events[0]! }
      const item = t.shown('2026-10-26')[0]!
      expect(item.extent).toMatchObject({ startDate: '2026-10-26', endDate: '2026-10-27' })
      await t.service.updateEvent(item.id, { title: item.title, allDay: true, ...item.extent })
      expect(t.store.events[0]).toEqual(before)
    } finally {
      t.dispose()
    }
  })

  it('does not change what Google holds, says so, and reads the calendar again', async () => {
    const t = await editingApp()
    try {
      const google = t.store.add({
        title: '구글 일정',
        source: 'google',
        start_at: Date.parse('2026-10-22T05:00:00Z'),
        end_at: Date.parse('2026-10-22T06:00:00Z')
      })
      await t.service.navigate('refresh')
      const readsOf = () =>
        t.fake.calls.filter((call) => call.path.startsWith('/calendar/events?')).length
      const reads = readsOf()
      const id = String(google.event_id)
      for (const result of [
        await t.service.updateEvent(id, timed({ title: '바꿈' })),
        await t.service.deleteEvent(id)
      ])
        expect(result).toMatchObject({
          ok: true,
          value: { outcome: 'not_saved', error: { message: expect.stringContaining('Google') } }
        })
      expect(google.title).toBe('구글 일정')
      expect(google.status).toBe('confirmed')
      expect(readsOf()).toBeGreaterThan(reads)
    } finally {
      t.dispose()
    }
  })

  it('says an event is gone when it was deleted elsewhere, and reads the calendar again', async () => {
    const t = await editingApp()
    try {
      await t.service.createEvent(timed())
      const id = t.shown('2026-10-22')[0]!.id
      // The assistant (or another device) deleted it in the meantime.
      t.store.events.length = 0
      const result = await t.service.updateEvent(id, timed({ title: '늦은 수정' }))
      expect(result).toMatchObject({
        ok: true,
        value: { outcome: 'not_saved', error: { code: 'not_found' } }
      })
      expect(t.shown('2026-10-22')).toEqual([])
    } finally {
      t.dispose()
    }
  })

  it('may be sent again after an unclear answer, because a repeat changes nothing more', async () => {
    const t = await editingApp()
    try {
      await t.service.createEvent(timed())
      const id = t.shown('2026-10-22')[0]!.id
      t.store.faults.push('lost')
      expect(outcome(await t.service.updateEvent(id, timed({ title: '바뀐 회의' })))).toBe(
        'unknown'
      )
      expect(outcome(await t.service.updateEvent(id, timed({ title: '바뀐 회의' })))).toBe('saved')
      expect(t.store.events).toHaveLength(1)
      expect(t.store.events[0]!.title).toBe('바뀐 회의')
    } finally {
      t.dispose()
    }
  })
})

describe('deleting an event over HTTP', () => {
  it('cancels it on the server and no longer shows it', async () => {
    const t = await editingApp()
    try {
      await t.service.createEvent(timed())
      const id = t.shown('2026-10-22')[0]!.id
      expect(outcome(await t.service.deleteEvent(id))).toBe('saved')
      expect(t.store.events[0]!.status).toBe('cancelled')
      expect(t.shown('2026-10-22')).toEqual([])
    } finally {
      t.dispose()
    }
  })

  it('may be repeated after an unclear answer, ending the same', async () => {
    const t = await editingApp()
    try {
      await t.service.createEvent(timed())
      const id = t.shown('2026-10-22')[0]!.id
      t.store.faults.push('lost')
      expect(outcome(await t.service.deleteEvent(id))).toBe('unknown')
      expect(outcome(await t.service.deleteEvent(id))).toBe('saved')
    } finally {
      t.dispose()
    }
  })

  it('says an event that does not exist is gone', async () => {
    const t = await editingApp()
    try {
      expect(await t.service.deleteEvent('999999')).toMatchObject({
        ok: true,
        value: { outcome: 'not_saved', error: { code: 'not_found' } }
      })
    } finally {
      t.dispose()
    }
  })

  it('never asks the server about an ID that is not a number', async () => {
    const t = await editingApp()
    try {
      expect(await t.service.deleteEvent('../auth/logout')).toMatchObject({
        ok: true,
        value: { outcome: 'not_saved' }
      })
      expect(t.changes()).toHaveLength(0)
    } finally {
      t.dispose()
    }
  })
})

describe('after a change', () => {
  it('shows every view as read again, not as kept from before', async () => {
    const t = await editingApp()
    try {
      await t.service.navigate('this_week')
      await t.service.navigate('this_month') // both kept
      // Another client adds an event for the week.
      t.store.add({
        title: '밖에서 추가',
        start_at: Date.parse('2026-10-22T08:00:00Z'),
        end_at: Date.parse('2026-10-22T09:00:00Z')
      })
      await t.service.createEvent(
        timed({ title: '여기서 추가', startDate: '2026-10-30', endDate: '2026-10-30' })
      )
      await t.service.navigate('this_week')
      expect(t.service.getSnapshot().loadedAt).toBe(NOW)
      expect(t.shown('2026-10-22').map((event) => event.title)).toEqual(['밖에서 추가'])
    } finally {
      t.dispose()
    }
  })

  it('drops a change in flight when the user signs out and does not add it for the next', async () => {
    const t = await editingApp()
    try {
      const pending = t.service.createEvent(timed())
      await t.service.stop()
      expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      expect(t.service.getSnapshot()).toMatchObject({ status: 'idle', days: [] })
    } finally {
      t.dispose()
    }
  })
})
