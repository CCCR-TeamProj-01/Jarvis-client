import { describe, expect, it } from 'vitest'
import type { ServerEvent, ServerTodo } from '../../src/main/calendar/calendar-api'
import { buildDays, serverWindow, shiftView, viewOf } from '../../src/main/calendar/calendar-view'

const SEOUL = 'Asia/Seoul'
const LA = 'America/Los_Angeles'
const at = (iso: string) => Date.parse(iso)

const timed = (id: string, start: string, end: string, extra: Partial<ServerEvent> = {}) =>
  ({
    id,
    title: `일정 ${id}`,
    source: 'jarvis',
    cancelled: false,
    allDay: false,
    startMs: at(start),
    endMs: at(end),
    ...extra
  }) as ServerEvent
const allDay = (id: string, startDate: string, endDate: string, extra: Partial<ServerEvent> = {}) =>
  ({
    id,
    title: `종일 ${id}`,
    source: 'jarvis',
    cancelled: false,
    allDay: true,
    startDate,
    endDate,
    ...extra
  }) as ServerEvent
const dueDate = (id: string, date: string, done = false): ServerTodo => ({
  id,
  title: `할 일 ${id}`,
  due: { kind: 'date', date },
  done
})
const dueAt = (id: string, iso: string): ServerTodo => ({
  id,
  title: `할 일 ${id}`,
  due: { kind: 'datetime', atMs: at(iso) },
  done: false
})

function days(
  span: 'day' | 'week',
  anchor: string,
  events: ServerEvent[],
  todos: ServerTodo[] = [],
  timeZone = SEOUL,
  today = '2026-10-22'
) {
  return buildDays({ view: viewOf(span, anchor), timeZone, today, events, todos })
}
const dayOf = (list: ReturnType<typeof days>, date: string) => list.find((d) => d.date === date)!

describe('views', () => {
  it('covers each calendar month, including leap February and year changes', () => {
    expect(viewOf('month', '2026-10-22')).toEqual({
      span: 'month',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      startWeekday: 4
    })
    expect(viewOf('month', '2024-02-29').endDate).toBe('2024-02-29')
    expect(viewOf('month', '2026-02-22').endDate).toBe('2026-02-28')
    const december = viewOf('month', '2026-12-31')
    expect(shiftView(december, 1)).toMatchObject({ startDate: '2027-01-01', endDate: '2027-01-31' })
    expect(shiftView(viewOf('month', '2027-01-31'), -1)).toEqual(december)
  })

  it('requests a whole month and keeps exactly its dates when building the display', () => {
    const view = viewOf('month', '2026-10-22')
    expect(serverWindow(view, SEOUL)).toEqual({
      fromMs: at('2026-09-30T15:00:00Z'),
      toMs: at('2026-11-01T00:00:00Z')
    })
    const monthDays = buildDays({
      view,
      timeZone: SEOUL,
      today: '2026-10-22',
      events: [],
      todos: []
    })
    expect(monthDays).toHaveLength(31)
    expect(monthDays[0]!.date).toBe('2026-10-01')
    expect(monthDays.at(-1)!.date).toBe('2026-10-31')
    expect(monthDays.filter((day) => day.isToday).map((day) => day.date)).toEqual(['2026-10-22'])
  })

  it('is one day, or a week from Monday to Sunday', () => {
    expect(viewOf('day', '2026-10-22')).toEqual({
      span: 'day',
      startDate: '2026-10-22',
      startWeekday: 4,
      endDate: '2026-10-22'
    })
    expect(viewOf('week', '2026-10-22')).toEqual({
      span: 'week',
      startDate: '2026-10-19',
      startWeekday: 1,
      endDate: '2026-10-25'
    })
    expect(viewOf('week', '2026-10-25').startDate).toBe('2026-10-19')
  })

  it('moves a day or a week at a time, over a month and year end', () => {
    expect(shiftView(viewOf('day', '2026-10-31'), 1).startDate).toBe('2026-11-01')
    expect(shiftView(viewOf('day', '2026-01-01'), -1).startDate).toBe('2025-12-31')
    const week = shiftView(viewOf('week', '2026-12-30'), 1)
    expect(week).toMatchObject({ startDate: '2027-01-04', endDate: '2027-01-10' })
    expect(shiftView(week, -1).startDate).toBe('2026-12-28')
  })
})

describe('the period asked of the server', () => {
  it('covers the user days, and the same dates read as UTC, east of Greenwich', () => {
    // The server compares all-day dates with the UTC date of from/to, so `to` must reach the 23rd.
    expect(serverWindow(viewOf('day', '2026-10-22'), SEOUL)).toEqual({
      fromMs: at('2026-10-21T15:00:00Z'),
      toMs: at('2026-10-23T00:00:00Z')
    })
  })

  it('covers them west of Greenwich too', () => {
    expect(serverWindow(viewOf('day', '2026-10-22'), LA)).toEqual({
      fromMs: at('2026-10-22T00:00:00Z'),
      toMs: at('2026-10-23T07:00:00Z')
    })
  })

  it('is just the day in UTC', () => {
    expect(serverWindow(viewOf('week', '2026-10-22'), 'UTC')).toEqual({
      fromMs: at('2026-10-19T00:00:00Z'),
      toMs: at('2026-10-26T00:00:00Z')
    })
  })
})

describe('events with a time', () => {
  it('shows an event on its local day, in local time', () => {
    const list = days('day', '2026-10-22', [
      timed('1', '2026-10-22T05:00:00Z', '2026-10-22T06:00:00Z')
    ])
    expect(list).toHaveLength(1)
    expect(list[0]!.events).toEqual([
      {
        kind: 'event',
        id: '1',
        title: '일정 1',
        source: 'jarvis',
        allDay: false,
        startTime: '14:00',
        endTime: '15:00',
        part: null,
        extent: {
          startDate: '2026-10-22',
          startTime: '14:00',
          endDate: '2026-10-22',
          endTime: '15:00'
        }
      }
    ])
  })

  it('puts a late-evening UTC event on the next local day', () => {
    // 20:00Z on the 21st is 05:00 on the 22nd in Seoul.
    const list = days('week', '2026-10-22', [
      timed('1', '2026-10-21T20:00:00Z', '2026-10-21T21:00:00Z')
    ])
    expect(dayOf(list, '2026-10-21').events).toEqual([])
    expect(dayOf(list, '2026-10-22').events[0]).toMatchObject({
      startTime: '05:00',
      endTime: '06:00'
    })
  })

  it('leaves out what is outside the days shown', () => {
    const list = days('day', '2026-10-22', [
      timed('before', '2026-10-21T01:00:00Z', '2026-10-21T02:00:00Z'),
      timed('after', '2026-10-23T01:00:00Z', '2026-10-23T02:00:00Z')
    ])
    expect(list[0]!.events).toEqual([])
  })

  it('shows an event across midnight on both days, with where each part begins and ends', () => {
    // 22:00 to 02:00 in Seoul.
    const list = days('week', '2026-10-22', [
      timed('1', '2026-10-22T13:00:00Z', '2026-10-22T17:00:00Z')
    ])
    expect(dayOf(list, '2026-10-22').events[0]).toMatchObject({
      startTime: '22:00',
      endTime: null,
      part: { index: 1, total: 2 }
    })
    expect(dayOf(list, '2026-10-23').events[0]).toMatchObject({
      startTime: null,
      endTime: '02:00',
      part: { index: 2, total: 2 }
    })
  })

  it('shows every day of a long event, the middle ones with neither a start nor an end', () => {
    const list = days('week', '2026-10-19', [
      timed('1', '2026-10-20T10:00:00Z', '2026-10-23T03:00:00Z')
    ])
    const shape = (date: string) => {
      const event = dayOf(list, date).events[0]
      return event && [event.startTime, event.endTime, event.part?.index, event.part?.total]
    }
    expect(shape('2026-10-19')).toBeUndefined()
    expect(shape('2026-10-20')).toEqual(['19:00', null, 1, 4])
    expect(shape('2026-10-21')).toEqual([null, null, 2, 4])
    expect(shape('2026-10-22')).toEqual([null, null, 3, 4])
    expect(shape('2026-10-23')).toEqual([null, '12:00', 4, 4])
    expect(shape('2026-10-24')).toBeUndefined()
  })

  it('shows only the days in view of an event that began before them', () => {
    const list = days('day', '2026-10-22', [
      timed('1', '2026-10-20T10:00:00Z', '2026-10-23T03:00:00Z')
    ])
    expect(list[0]!.events[0]).toMatchObject({
      startTime: null,
      endTime: null,
      part: { index: 3, total: 4 }
    })
  })

  it('does not carry an event that ends at midnight into the next day, and ends it at 24:00', () => {
    // 23:00 to 00:00 in Seoul.
    const list = days('week', '2026-10-22', [
      timed('1', '2026-10-22T14:00:00Z', '2026-10-22T15:00:00Z')
    ])
    expect(dayOf(list, '2026-10-22').events[0]).toMatchObject({
      startTime: '23:00',
      endTime: '24:00',
      part: null
    })
    expect(dayOf(list, '2026-10-23').events).toEqual([])
  })

  it('shows an event that is a single instant, even at midnight', () => {
    const list = days('week', '2026-10-22', [
      timed('1', '2026-10-22T15:00:00Z', '2026-10-22T15:00:00Z')
    ])
    expect(dayOf(list, '2026-10-23').events[0]).toMatchObject({
      startTime: '00:00',
      endTime: '00:00'
    })
    expect(dayOf(list, '2026-10-22').events).toEqual([])
  })

  it('uses the time zone it is given, so the same event lands on different days', () => {
    const event = timed('1', '2026-10-22T05:00:00Z', '2026-10-22T06:00:00Z')
    expect(days('day', '2026-10-21', [event], [], LA, '2026-10-21')[0]!.events[0]).toMatchObject({
      startTime: '22:00'
    })
    expect(days('day', '2026-10-22', [event], [], LA)[0]!.events).toEqual([])
  })
})

describe('all-day events', () => {
  it('shows an all-day event on its date only, whatever the time zone', () => {
    // The end date is the day after the last day.
    for (const zone of [SEOUL, LA, 'UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const list = days('week', '2026-10-19', [allDay('1', '2026-10-22', '2026-10-23')], [], zone)
      expect(list.filter((day) => day.events.length > 0).map((day) => day.date)).toEqual([
        '2026-10-22'
      ])
      expect(dayOf(list, '2026-10-22').events[0]).toMatchObject({
        allDay: true,
        startTime: null,
        endTime: null,
        part: null
      })
    }
  })

  it('does not show it on the day its exclusive end date names', () => {
    const list = days('week', '2026-10-19', [allDay('1', '2026-10-22', '2026-10-24')])
    expect(list.filter((day) => day.events.length > 0).map((day) => day.date)).toEqual([
      '2026-10-22',
      '2026-10-23'
    ])
    expect(dayOf(list, '2026-10-22').events[0]!.part).toEqual({ index: 1, total: 2 })
    expect(dayOf(list, '2026-10-23').events[0]!.part).toEqual({ index: 2, total: 2 })
  })

  it('shows one day for an end that is missing or not after the start', () => {
    for (const end of ['2026-10-22', '2026-10-20']) {
      const list = days('week', '2026-10-19', [allDay('1', '2026-10-22', end)])
      expect(list.filter((day) => day.events.length > 0).map((day) => day.date)).toEqual([
        '2026-10-22'
      ])
    }
  })

  it('shows the days that are in view of one that began before them', () => {
    const list = days('day', '2026-10-24', [allDay('1', '2026-10-22', '2026-10-27')])
    expect(list[0]!.events[0]).toMatchObject({ part: { index: 3, total: 5 } })
  })

  it('shows an all-day event across a month and a year end', () => {
    const list = days('week', '2026-12-28', [allDay('1', '2026-12-31', '2027-01-02')])
    expect(list.filter((day) => day.events.length > 0).map((day) => day.date)).toEqual([
      '2026-12-31',
      '2027-01-01'
    ])
  })
})

describe('events in a day', () => {
  it('hides what the server says is cancelled', () => {
    const list = days('day', '2026-10-22', [
      timed('1', '2026-10-22T05:00:00Z', '2026-10-22T06:00:00Z', { cancelled: true }),
      allDay('2', '2026-10-22', '2026-10-23', { cancelled: true }),
      timed('3', '2026-10-22T07:00:00Z', '2026-10-22T08:00:00Z')
    ])
    expect(list[0]!.events.map((event) => event.id)).toEqual(['3'])
  })

  it('lists all-day first, then by start time, with what continues from yesterday before the rest', () => {
    const list = days('day', '2026-10-22', [
      timed('late', '2026-10-22T09:00:00Z', '2026-10-22T10:00:00Z'),
      timed('early', '2026-10-22T00:30:00Z', '2026-10-22T01:00:00Z'),
      timed('overnight', '2026-10-21T10:00:00Z', '2026-10-22T02:00:00Z'),
      allDay('day', '2026-10-22', '2026-10-23')
    ])
    expect(list[0]!.events.map((event) => event.id)).toEqual(['day', 'overnight', 'early', 'late'])
  })

  it('tells the source apart, and keeps an unknown one as it is', () => {
    const list = days('day', '2026-10-22', [
      timed('1', '2026-10-22T05:00:00Z', '2026-10-22T06:00:00Z', { source: 'google' }),
      timed('2', '2026-10-22T06:00:00Z', '2026-10-22T07:00:00Z', { source: 'other' })
    ])
    expect(list[0]!.events.map((event) => event.source)).toEqual(['google', 'other'])
  })

  it('shortens a title longer than the server takes, and trims one with spaces', () => {
    const list = days('day', '2026-10-22', [
      timed('1', '2026-10-22T05:00:00Z', '2026-10-22T06:00:00Z', { title: '가'.repeat(500) }),
      timed('2', '2026-10-22T06:00:00Z', '2026-10-22T07:00:00Z', { title: '  회의  ' })
    ])
    const [long, spaced] = list[0]!.events
    expect(Array.from(long!.title)).toHaveLength(256)
    expect(long!.title.endsWith('…')).toBe(true)
    expect(spaced!.title).toBe('회의')
  })
})

describe('to-dos', () => {
  it('shows a to-do on its due date, and one with a due time on its local day', () => {
    const list = days(
      'week',
      '2026-10-19',
      [],
      [
        dueDate('1', '2026-10-22'),
        // 16:00Z on the 22nd is 01:00 on the 23rd in Seoul.
        dueAt('2', '2026-10-22T16:00:00Z')
      ]
    )
    expect(dayOf(list, '2026-10-22').todos).toEqual([
      { kind: 'todo', id: '1', title: '할 일 1', due: 'date', time: null, done: false }
    ])
    expect(dayOf(list, '2026-10-23').todos).toEqual([
      { kind: 'todo', id: '2', title: '할 일 2', due: 'datetime', time: '01:00', done: false }
    ])
  })

  it('does not move a due date by the time zone', () => {
    for (const zone of [SEOUL, LA, 'Pacific/Kiritimati']) {
      const list = days('week', '2026-10-19', [], [dueDate('1', '2026-10-22')], zone)
      expect(list.filter((day) => day.todos.length > 0).map((day) => day.date)).toEqual([
        '2026-10-22'
      ])
    }
  })

  it('lists those without a time first, then by time', () => {
    const list = days(
      'day',
      '2026-10-22',
      [],
      [
        dueAt('b', '2026-10-22T08:00:00Z'),
        dueAt('a', '2026-10-22T02:00:00Z'),
        dueDate('c', '2026-10-22')
      ]
    )
    expect(list[0]!.todos.map((todo) => todo.id)).toEqual(['c', 'a', 'b'])
  })

  it('marks a finished one', () => {
    const list = days('day', '2026-10-22', [], [dueDate('1', '2026-10-22', true)])
    expect(list[0]!.todos[0]!.done).toBe(true)
  })

  it('keeps events and to-dos apart', () => {
    const list = days(
      'day',
      '2026-10-22',
      [timed('1', '2026-10-22T05:00:00Z', '2026-10-22T06:00:00Z')],
      [dueDate('1', '2026-10-22')]
    )
    expect(list[0]!.events).toHaveLength(1)
    expect(list[0]!.todos).toHaveLength(1)
  })
})

describe('the days of a view', () => {
  it('lists every day, empty or not, with its weekday and which is today', () => {
    const list = days('week', '2026-10-22', [])
    expect(list.map((day) => day.date)).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25'
    ])
    expect(list.map((day) => day.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(list.filter((day) => day.isToday).map((day) => day.date)).toEqual(['2026-10-22'])
  })

  it('has no today when today is outside the view', () => {
    expect(days('day', '2026-10-23', []).some((day) => day.isToday)).toBe(false)
  })
})

describe('the whole of an event, for editing', () => {
  const extentOn = (list: ReturnType<typeof days>, date: string) =>
    dayOf(list, date).events[0]!.extent

  it('is the same on every day an event is shown, not the part on that day', () => {
    // 22:00 on the 22nd to 02:00 on the 23rd in Seoul.
    const list = days('week', '2026-10-22', [
      timed('1', '2026-10-22T13:00:00Z', '2026-10-22T17:00:00Z')
    ])
    const whole = {
      startDate: '2026-10-22',
      startTime: '22:00',
      endDate: '2026-10-23',
      endTime: '02:00'
    }
    expect(extentOn(list, '2026-10-22')).toEqual(whole)
    expect(extentOn(list, '2026-10-23')).toEqual(whole)
  })

  it('ends an all-day event on its last day, not on the exclusive end the server holds', () => {
    const list = days('week', '2026-10-19', [allDay('1', '2026-10-22', '2026-10-24')])
    for (const date of ['2026-10-22', '2026-10-23'])
      expect(extentOn(list, date)).toEqual({
        startDate: '2026-10-22',
        startTime: null,
        endDate: '2026-10-23',
        endTime: null
      })
  })

  it('keeps a one-day all-day event on one day, also when the server end is missing', () => {
    for (const end of ['2026-10-23', '2026-10-22']) {
      const list = days('day', '2026-10-22', [allDay('1', '2026-10-22', end)])
      expect(extentOn(list, '2026-10-22')).toMatchObject({
        startDate: '2026-10-22',
        endDate: '2026-10-22'
      })
    }
  })

  it('ends an event that stops at midnight at 00:00 of the next day, as it really does', () => {
    const list = days('day', '2026-10-22', [
      timed('1', '2026-10-22T14:00:00Z', '2026-10-22T15:00:00Z')
    ])
    expect(extentOn(list, '2026-10-22')).toEqual({
      startDate: '2026-10-22',
      startTime: '23:00',
      endDate: '2026-10-23',
      endTime: '00:00'
    })
  })

  it('does not cut a title the server allows', () => {
    const title = '가'.repeat(255)
    const list = days('day', '2026-10-22', [
      timed('1', '2026-10-22T05:00:00Z', '2026-10-22T06:00:00Z', { title })
    ])
    expect(list[0]!.events[0]!.title).toBe(title)
  })
})
