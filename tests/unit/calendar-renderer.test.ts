import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildDays, viewOf } from '../../src/main/calendar/calendar-view'
import { CalendarView } from '../../src/renderer/ui/features/calendar/calendar-view'
import { newestCalendarSnapshot } from '../../src/renderer/ui/features/calendar/use-calendar'
import {
  calendarBody,
  calendarNotice,
  clockTime,
  calendarWeeks,
  calendarKeyTarget,
  selectedCalendarDay,
  viewTitle
} from '../../src/renderer/ui/features/calendar/view-model'
import type { CalendarEditOutcome, CalendarSnapshot } from '../../src/shared/contracts/calendar'
import type { Result } from '../../src/shared/contracts/common'

const NOW = Date.parse('2026-10-22T03:00:00Z')
function snapshot(overrides: Partial<CalendarSnapshot> = {}): CalendarSnapshot {
  const view = viewOf('day', '2026-10-22')
  return {
    revision: 3,
    status: 'ready',
    view,
    timeZone: 'Asia/Seoul',
    days: buildDays({ view, timeZone: 'Asia/Seoul', today: '2026-10-22', events: [], todos: [] }),
    loadedAt: NOW,
    lastSuccessAt: NOW,
    error: null,
    ...overrides
  }
}
const refuse = async (): Promise<Result<CalendarEditOutcome>> => ({
  ok: false,
  error: { code: 'internal', message: 'x' }
})
const render = (state: CalendarSnapshot | null) =>
  renderToStaticMarkup(
    createElement(CalendarView, {
      snapshot: state,
      connectionError: null,
      onNavigate: () => undefined,
      onCreate: refuse,
      onUpdate: refuse,
      onDelete: refuse
    })
  )

describe('the calendar screen', () => {
  it('caps each date preview at two items and keeps all items in the selected-day details', () => {
    const view = viewOf('month', '2026-10-22')
    const days = buildDays({ view, timeZone: 'UTC', today: '2026-10-22', events: [], todos: [] })
    days[21]!.events = ['회의', '점검', '리뷰'].map((title, index) => ({
      kind: 'event',
      id: String(index),
      title,
      source: 'jarvis',
      allDay: true,
      startTime: null,
      endTime: null,
      part: null,
      extent: { startDate: '2026-10-22', startTime: null, endDate: '2026-10-22', endTime: null }
    }))
    const html = render(snapshot({ view, days }))
    expect(html.match(/class="calendar-preview calendar-preview-jarvis"/g)).toHaveLength(2)
    expect(html).toContain('+1개 더')
    const detail = html.slice(html.indexOf('class="calendar-detail"'))
    expect(detail).toContain('회의')
    expect(detail).toContain('점검')
    expect(detail).toContain('리뷰')
  })

  it('renders a month as a seven-column calendar even when there are no events', () => {
    const view = viewOf('month', '2026-10-22')
    const days = buildDays({
      view,
      timeZone: 'Asia/Seoul',
      today: '2026-10-22',
      events: [],
      todos: []
    })
    const html = render(snapshot({ view, days }))
    expect(viewTitle(view)).toBe('2026년 10월')
    expect(html).toContain('aria-label="2026년 10월 달력"')
    expect(html.match(/scope="col"/g)).toHaveLength(7)
    expect(html.match(/data-date=/g)).toHaveLength(31)
    expect(html).toContain('aria-current="date"')
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html).toContain('이 날에는 일정과 마감 할 일이 없어요.')
  })

  it('aligns months with weekdays and completes four, five or six rows', () => {
    const dates = (anchor: string) =>
      buildDays({
        view: viewOf('month', anchor),
        timeZone: 'UTC',
        today: anchor,
        events: [],
        todos: []
      })
    const october = calendarWeeks(dates('2026-10-22'), 0)
    expect(october).toHaveLength(5)
    expect(october[0]!.slice(0, 4)).toEqual([null, null, null, null])
    expect(october[0]![4]!.date).toBe('2026-10-01')
    expect(october.at(-1)![6]!.date).toBe('2026-10-31')
    expect(calendarWeeks(dates('2026-02-01'), 0)).toHaveLength(4)
    expect(calendarWeeks(dates('2026-08-01'), 0)).toHaveLength(6)
    expect(calendarWeeks(dates('2024-02-01'), 0).flat().filter(Boolean)).toHaveLength(29)
    const week = buildDays({
      view: viewOf('week', '2026-10-22'),
      timeZone: 'UTC',
      today: '2026-10-22',
      events: [],
      todos: []
    })
    expect(calendarWeeks(week, 1)).toEqual([week])
  })

  it('selects today first, then a chosen date, and safely resets selection outside the loaded period', () => {
    const view = viewOf('month', '2026-10-22')
    const days = buildDays({ view, timeZone: 'UTC', today: '2026-10-22', events: [], todos: [] })
    expect(selectedCalendarDay(days, null)?.date).toBe('2026-10-22')
    expect(selectedCalendarDay(days, '2026-10-03')?.date).toBe('2026-10-03')
    expect(selectedCalendarDay(days, '2026-09-03')?.date).toBe('2026-10-22')
    expect(
      selectedCalendarDay(
        days.map((day) => ({ ...day, isToday: false })),
        null
      )?.date
    ).toBe('2026-10-01')
    expect(selectedCalendarDay([], null)).toBeNull()
    expect(calendarKeyTarget('ArrowRight', 30, 31)).toBe(30)
    expect(calendarKeyTarget('ArrowLeft', 0, 31)).toBe(0)
    expect(calendarKeyTarget('ArrowDown', 2, 31)).toBe(9)
    expect(calendarKeyTarget('ArrowUp', 9, 31)).toBe(2)
    expect(calendarKeyTarget('Home', 20, 31)).toBe(0)
    expect(calendarKeyTarget('End', 20, 31)).toBe(30)
    expect(calendarKeyTarget('Enter', 20, 31)).toBeNull()
  })

  it('tells an initial load, an empty answer and a failed read apart', () => {
    expect(render(null)).toContain('일정을 불러오고 있어요.')
    expect(render(snapshot())).toContain('이 날에는 일정과 마감 할 일이 없어요.')
    const failed = snapshot({
      status: 'failed',
      loadedAt: null,
      days: [],
      error: { code: 'unavailable', message: '연결 실패' }
    })
    const html = render(failed)
    expect(html).toContain('연결 실패')
    expect(html).toContain('다시 시도')
    expect(html).not.toContain('이 날에는 일정과 마감 할 일이 없어요.')
    expect(calendarBody(failed)).toBe('error')
  })

  it('marks an earlier answer as stale with both its date and its time', () => {
    const failed = snapshot({
      status: 'failed',
      loadedAt: NOW - 86_400_000,
      error: { code: 'unavailable', message: '연결 실패' }
    })
    const notice = calendarNotice(failed)!
    expect(notice.text).toContain(clockTime(NOW - 86_400_000, 'Asia/Seoul'))
    expect(notice.text).toContain('최신이 아닐 수 있어요')
    expect(clockTime(NOW - 86_400_000, 'Asia/Seoul')).toContain('21')
    expect(calendarNotice(snapshot({ status: 'loading' }))?.text).toContain('이전에 불러온 일정')
    expect(calendarNotice(snapshot())).toBeNull()
  })

  it('renders server titles as text, and labels Google copies and due dates as read-only data', () => {
    const state = snapshot()
    state.days[0]!.events.push({
      kind: 'event',
      id: '1',
      title: '<img src=x onerror=alert(1)>',
      source: 'google',
      allDay: true,
      startTime: null,
      endTime: null,
      part: { index: 1, total: 2 },
      extent: { startDate: '2026-10-22', startTime: null, endDate: '2026-10-23', endTime: null }
    })
    state.days[0]!.todos.push({
      kind: 'todo',
      id: '2',
      title: '보고서',
      due: 'datetime',
      time: '14:00',
      done: true
    })
    const html = render(state)
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(html).toContain('읽기 전용')
    expect(html).toContain('동기화 상태는 확인할 수 없어요')
    expect(html).toContain('종일')
    expect(html).toContain('1/2일째')
    expect(html).toContain('14:00까지')
    expect(html).toContain('완료')
    expect(html).not.toContain('type="checkbox"')
  })

  it('does not replace a newer state with a late snapshot response', () => {
    const newer = snapshot({ revision: 5 })
    const older = snapshot({ revision: 4 })
    expect(newestCalendarSnapshot(newer, older)).toBe(newer)
    expect(newestCalendarSnapshot(older, newer)).toBe(newer)
    expect(newestCalendarSnapshot(null, older)).toBe(older)
  })
})
