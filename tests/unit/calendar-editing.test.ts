import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildDays, viewOf } from '../../src/main/calendar/calendar-view'
import { CalendarView } from '../../src/renderer/ui/features/calendar/calendar-view'
import { DeleteDialog, EventDialog } from '../../src/renderer/ui/features/calendar/event-dialogs'
import {
  canSubmit,
  editReport,
  formFromEvent,
  newEventForm,
  resendBlocked,
  toDraft,
  withStartDate
} from '../../src/renderer/ui/features/calendar/event-form'
import type { EditReport, EventForm } from '../../src/renderer/ui/features/calendar/event-form'
import type {
  CalendarEditOutcome,
  CalendarEventItem,
  CalendarSnapshot
} from '../../src/shared/contracts/calendar'
import type { Result } from '../../src/shared/contracts/common'

const NOW = Date.parse('2026-10-22T03:00:00Z')

const eventItem = (overrides: Partial<CalendarEventItem> = {}): CalendarEventItem => ({
  kind: 'event',
  id: '551',
  title: '팀 회의',
  source: 'jarvis',
  allDay: false,
  startTime: '14:00',
  endTime: '15:00',
  part: null,
  extent: { startDate: '2026-10-22', startTime: '14:00', endDate: '2026-10-22', endTime: '15:00' },
  ...overrides
})

function snapshot(
  span: 'day' | 'month' | 'week',
  events: CalendarEventItem[] = [],
  overrides: Partial<CalendarSnapshot> = {}
): CalendarSnapshot {
  const view = viewOf(span, '2026-10-22')
  const days = buildDays({
    view,
    timeZone: 'Asia/Seoul',
    today: '2026-10-22',
    events: [],
    todos: []
  })
  days.find((day) => day.date === '2026-10-22')!.events = events
  return {
    revision: 3,
    status: 'ready',
    view,
    timeZone: 'Asia/Seoul',
    days,
    loadedAt: NOW,
    lastSuccessAt: NOW,
    error: null,
    ...overrides
  }
}
const noop = async (): Promise<Result<CalendarEditOutcome>> => ({
  ok: false,
  error: { code: 'internal', message: 'x' }
})
const render = (state: CalendarSnapshot | null) =>
  renderToStaticMarkup(
    createElement(CalendarView, {
      snapshot: state,
      connectionError: null,
      onNavigate: () => undefined,
      onCreate: noop,
      onUpdate: noop,
      onDelete: noop,
      google: null,
      onOpenSettings: () => undefined
    })
  )

describe('the add button on a date', () => {
  it('is on the selected date only, named for that date', () => {
    const html = render(snapshot('month'))
    expect(html.match(/class="calendar-add"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="10월 22일 (목)에 일정 추가"')
    // Beside the date button, never inside it: a button cannot hold a button.
    const cell = html.slice(html.indexOf('data-date="2026-10-22"'))
    expect(cell.indexOf('calendar-add')).toBeGreaterThan(cell.indexOf('</button>'))
  })

  it('is on the week view too, and not on the day view, which has its own button', () => {
    expect(render(snapshot('week')).match(/class="calendar-add"/g)).toHaveLength(1)
    const day = render(snapshot('day'))
    expect(day).not.toContain('class="calendar-add"')
    expect(day).toContain('일정 추가')
    expect(day).toContain('calendar-day-add')
  })

  it('is not there while nothing has been read, or when reading failed', () => {
    expect(render(null)).not.toContain('calendar-add')
    const failed = snapshot('month', [], {
      status: 'failed',
      days: [],
      loadedAt: null,
      error: { code: 'unavailable', message: '서버에 연결하지 못했어요.' }
    })
    expect(render(failed)).not.toContain('calendar-add')
  })

  it('opens nothing by itself: no dialog is drawn until one is asked for', () => {
    expect(render(snapshot('month'))).not.toContain('<dialog')
  })
})

describe('editing buttons on an event', () => {
  it('are on events made in JARVIS, named for the event', () => {
    const html = render(snapshot('month', [eventItem()]))
    expect(html).toContain('aria-label="팀 회의 수정"')
    expect(html).toContain('aria-label="팀 회의 삭제"')
  })

  it('are not on Google events or any other source, which are read-only', () => {
    for (const source of ['google', 'other'] as const) {
      const html = render(snapshot('month', [eventItem({ source })]))
      expect(html).not.toContain('수정"')
      expect(html).not.toContain('삭제"')
      expect(html).toContain('읽기 전용')
    }
  })

  it('are not on a to-do', () => {
    const state = snapshot('month')
    state.days.find((day) => day.date === '2026-10-22')!.todos = [
      { kind: 'todo', id: '9', title: '보고서', due: 'date', time: null, done: false }
    ]
    const html = render(state)
    expect(html).toContain('보고서')
    expect(html).not.toContain('수정"')
  })

  it('name an event without a title', () => {
    expect(render(snapshot('month', [eventItem({ title: '' })]))).toContain('제목 없는 일정 수정')
  })
})

describe('the form', () => {
  it('starts a new event an hour long on the date chosen', () => {
    expect(newEventForm('2026-10-22')).toEqual({
      title: '',
      allDay: false,
      startDate: '2026-10-22',
      startTime: '09:00',
      endDate: '2026-10-22',
      endTime: '10:00'
    })
  })

  it('starts an edit from the whole event, not the day it was opened on', () => {
    expect(
      formFromEvent(
        eventItem({
          startTime: null,
          endTime: '02:00',
          part: { index: 2, total: 2 },
          extent: {
            startDate: '2026-10-22',
            startTime: '22:00',
            endDate: '2026-10-23',
            endTime: '02:00'
          }
        })
      )
    ).toEqual({
      title: '팀 회의',
      allDay: false,
      startDate: '2026-10-22',
      startTime: '22:00',
      endDate: '2026-10-23',
      endTime: '02:00'
    })
  })

  it('opens an all-day event with its last day, and times to fall back on if it is made timed', () => {
    const form = formFromEvent(
      eventItem({
        allDay: true,
        startTime: null,
        endTime: null,
        extent: { startDate: '2026-10-26', startTime: null, endDate: '2026-10-27', endTime: null }
      })
    )
    expect(form).toMatchObject({
      allDay: true,
      startDate: '2026-10-26',
      endDate: '2026-10-27',
      startTime: '09:00',
      endTime: '10:00'
    })
  })

  it('sends no times for an all-day event, whatever the fields still hold', () => {
    const form: EventForm = { ...newEventForm('2026-10-22'), title: '출장', allDay: true }
    expect(toDraft(form)).toEqual({
      title: '출장',
      allDay: true,
      startDate: '2026-10-22',
      startTime: null,
      endDate: '2026-10-22',
      endTime: null
    })
    expect(toDraft({ ...form, allDay: false })).toMatchObject({
      startTime: '09:00',
      endTime: '10:00'
    })
  })

  it('passes the title as typed, leaving the trimming and the rules to Main', () => {
    expect(toDraft({ ...newEventForm('2026-10-22'), title: '  회의 ' }).title).toBe('  회의 ')
  })

  it('can be sent only with a title and the fields it needs', () => {
    const form = { ...newEventForm('2026-10-22'), title: '회의' }
    expect(canSubmit(form)).toBe(true)
    expect(canSubmit({ ...form, title: '   ' })).toBe(false)
    expect(canSubmit({ ...form, startDate: '' })).toBe(false)
    expect(canSubmit({ ...form, endDate: '' })).toBe(false)
    expect(canSubmit({ ...form, startTime: '' })).toBe(false)
    expect(canSubmit({ ...form, endTime: '' })).toBe(false)
    // Times do not matter for an all-day event.
    expect(canSubmit({ ...form, allDay: true, startTime: '', endTime: '' })).toBe(true)
  })

  it('moves the last day along when the first day passes it, and leaves it otherwise', () => {
    const form = newEventForm('2026-10-22')
    expect(withStartDate(form, '2026-10-25')).toMatchObject({
      startDate: '2026-10-25',
      endDate: '2026-10-25'
    })
    expect(withStartDate({ ...form, endDate: '2026-10-30' }, '2026-10-25')).toMatchObject({
      endDate: '2026-10-30'
    })
    expect(withStartDate(form, '').endDate).toBe('2026-10-22')
  })
})

describe('what the dialog does with an answer', () => {
  const snapshotValue = snapshot('month')
  const outcome = (value: CalendarEditOutcome): Result<CalendarEditOutcome> => ({ ok: true, value })

  it('closes when it was saved', () => {
    expect(editReport(outcome({ outcome: 'saved', snapshot: snapshotValue }))).toEqual({
      kind: 'saved'
    })
  })

  it('stays open with the reason when it was not saved', () => {
    expect(
      editReport(
        outcome({
          outcome: 'not_saved',
          error: { code: 'invalid_input', message: '제목을 입력해 주세요.' },
          snapshot: snapshotValue
        })
      )
    ).toEqual({ kind: 'problem', message: '제목을 입력해 주세요.' })
  })

  it('says it is not known when the server may have taken it', () => {
    const report = editReport(
      outcome({
        outcome: 'unknown',
        error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' },
        snapshot: snapshotValue
      })
    )
    expect(report).toMatchObject({ kind: 'unknown' })
    expect(report.kind === 'unknown' && report.message).toContain('서버에 연결할 수 없습니다.')
  })

  it('treats a refused request as not saved, and a lost connection as not known', () => {
    expect(
      editReport({ ok: false, error: { code: 'permission_denied', message: '허용되지 않았어요.' } })
    ).toEqual({ kind: 'problem', message: '허용되지 않았어요.' })
    expect(
      editReport({ ok: false, error: { code: 'invalid_input', message: '형식이 달라요.' } })
    ).toMatchObject({ kind: 'problem' })
    for (const code of ['unavailable', 'internal'] as const)
      expect(editReport({ ok: false, error: { code, message: 'x' } })).toMatchObject({
        kind: 'unknown'
      })
  })
})

describe('the dialogs', () => {
  const html = (mode: 'create' | 'edit', form: EventForm) =>
    renderToStaticMarkup(
      createElement(EventDialog, {
        mode,
        initial: form,
        onSubmit: async (): Promise<EditReport> => ({ kind: 'saved' }),
        onClose: () => undefined,
        onCheck: () => undefined
      })
    )

  it('adds with the date filled in, and saving is off until there is a title', () => {
    const markup = html('create', newEventForm('2026-10-22'))
    expect(markup).toContain('일정 추가')
    expect(markup).toContain('value="2026-10-22"')
    expect(markup).toContain('value="09:00"')
    expect(markup).toContain('value="10:00"')
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled/)
  })

  it('edits with the event filled in, and saving on', () => {
    const markup = html('edit', { ...newEventForm('2026-10-22'), title: '팀 회의' })
    expect(markup).toContain('일정 수정')
    expect(markup).toContain('value="팀 회의"')
    expect(markup).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/)
  })

  it('asks for dates only for an all-day event, naming the end as the last day', () => {
    const markup = html('create', { ...newEventForm('2026-10-22'), title: '출장', allDay: true })
    expect(markup).not.toContain('type="time"')
    expect(markup).toContain('종료일 (마지막 날)')
    expect(html('create', newEventForm('2026-10-22'))).toContain('type="time"')
  })

  it('shows a title as text, not as markup', () => {
    const markup = html('edit', {
      ...newEventForm('2026-10-22'),
      title: '"><img src=x onerror=alert(1)>'
    })
    expect(markup).not.toContain('<img')
  })

  it('confirms a delete by naming the event, and says what deleting does', () => {
    const markup = renderToStaticMarkup(
      createElement(DeleteDialog, {
        title: '팀 회의',
        onConfirm: async (): Promise<EditReport> => ({ kind: 'saved' }),
        onClose: () => undefined
      })
    )
    expect(markup).toContain('팀 회의')
    expect(markup).toContain('일정을 삭제할까요?')
    expect(markup).toContain('알림도 함께 취소')
    expect(markup).not.toContain('영구')
  })

  it('names an event without a title when confirming a delete', () => {
    const markup = renderToStaticMarkup(
      createElement(DeleteDialog, {
        title: '',
        onConfirm: async (): Promise<EditReport> => ({ kind: 'saved' }),
        onClose: () => undefined
      })
    )
    expect(markup).toContain('(제목 없음)')
  })
})

describe('sending again after an unclear answer', () => {
  it('is not offered for an add, which a repeat could double', () => {
    expect(resendBlocked('create', 'unknown')).toBe(true)
  })

  it('is offered for a change, which a repeat leaves as it is', () => {
    expect(resendBlocked('edit', 'unknown')).toBe(false)
  })

  it('is not in the way while filling in or sending', () => {
    for (const mode of ['create', 'edit'] as const)
      for (const phase of ['editing', 'saving'] as const)
        expect(resendBlocked(mode, phase)).toBe(false)
  })
})
