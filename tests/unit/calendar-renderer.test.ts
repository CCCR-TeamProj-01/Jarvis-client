import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildDays, viewOf } from '../../src/main/calendar/calendar-view'
import { CalendarView } from '../../src/renderer/ui/features/calendar/calendar-view'
import { newestCalendarSnapshot } from '../../src/renderer/ui/features/calendar/use-calendar'
import {
  calendarBody,
  calendarNotice,
  clockTime
} from '../../src/renderer/ui/features/calendar/view-model'
import type { CalendarSnapshot } from '../../src/shared/contracts/calendar'

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
const render = (state: CalendarSnapshot | null) =>
  renderToStaticMarkup(
    createElement(CalendarView, {
      snapshot: state,
      connectionError: null,
      onNavigate: () => undefined
    })
  )

describe('the calendar screen', () => {
  it('tells an initial load, an empty answer and a failed read apart', () => {
    expect(render(null)).toContain('일정을 불러오고 있어요.')
    expect(render(snapshot())).toContain('이 기간에는 일정과 마감이 있는 할 일이 없어요.')
    const failed = snapshot({
      status: 'failed',
      loadedAt: null,
      days: [],
      error: { code: 'unavailable', message: '연결 실패' }
    })
    const html = render(failed)
    expect(html).toContain('연결 실패')
    expect(html).toContain('다시 시도')
    expect(html).not.toContain('이 기간에는 일정과 마감이 있는 할 일이 없어요.')
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
      part: { index: 1, total: 2 }
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
