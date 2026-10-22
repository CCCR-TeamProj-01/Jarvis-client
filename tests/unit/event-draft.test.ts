import { describe, expect, it } from 'vitest'
import { prepareEvent } from '../../src/main/calendar/event-draft'
import type { CalendarEventDraft } from '../../src/shared/contracts/calendar'

const at = (iso: string) => Date.parse(iso)

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
const refused = (draft: CalendarEventDraft, zone = 'Asia/Seoul') => {
  const result = prepareEvent(draft, zone)
  if (result.ok) throw new Error('expected a refusal')
  expect(result.error.code).toBe('invalid_input')
  return result.error.message
}

describe('a timed event', () => {
  it('is read on the clock of the user zone', () => {
    expect(prepareEvent(timed(), 'Asia/Seoul')).toEqual({
      ok: true,
      value: {
        title: '팀 회의',
        allDay: false,
        startMs: at('2026-10-22T05:00:00Z'),
        endMs: at('2026-10-22T06:00:00Z')
      }
    })
    expect(prepareEvent(timed(), 'America/Los_Angeles')).toMatchObject({
      ok: true,
      value: { startMs: at('2026-10-22T21:00:00Z') }
    })
  })

  it('may run past midnight and over several days', () => {
    expect(
      prepareEvent(
        timed({ startTime: '22:00', endDate: '2026-10-23', endTime: '02:00' }),
        'Asia/Seoul'
      )
    ).toMatchObject({ ok: true, value: { endMs: at('2026-10-22T17:00:00Z') } })
    expect(
      prepareEvent(timed({ endDate: '2026-10-25', endTime: '10:00' }), 'Asia/Seoul')
    ).toMatchObject({ ok: true })
  })

  it('may end at midnight, by naming the next day', () => {
    expect(
      prepareEvent(
        timed({ startTime: '23:00', endDate: '2026-10-23', endTime: '00:00' }),
        'Asia/Seoul'
      )
    ).toMatchObject({ ok: true, value: { endMs: at('2026-10-22T15:00:00Z') } })
  })

  it('must end after it starts', () => {
    expect(refused(timed({ endTime: '14:00' }))).toContain('종료 시각')
    expect(refused(timed({ endTime: '13:59' }))).toContain('종료 시각')
    expect(refused(timed({ endDate: '2026-10-21' }))).toContain('종료 시각')
  })

  it('needs both times, in the form HH:mm', () => {
    expect(refused(timed({ startTime: null }))).toContain('시각')
    expect(refused(timed({ endTime: null }))).toContain('시각')
    for (const time of ['24:00', '9:00', '09:60', '', '09:00:00', 'ab:cd', '14:00 '])
      expect(refused(timed({ startTime: time }))).toContain('시각')
  })

  it('refuses a time the clock skips, saying which', () => {
    const message = refused(
      timed({
        startDate: '2026-03-08',
        startTime: '02:30',
        endDate: '2026-03-08',
        endTime: '03:30'
      }),
      'America/Los_Angeles'
    )
    expect(message).toContain('2026-03-08 02:30')
    expect(message).toContain('건너뛰는')
    expect(
      refused(
        timed({
          startDate: '2026-03-08',
          startTime: '01:00',
          endDate: '2026-03-08',
          endTime: '02:30'
        }),
        'America/Los_Angeles'
      )
    ).toContain('2026-03-08 02:30')
  })

  it('takes the first of a time the clock shows twice', () => {
    expect(
      prepareEvent(
        timed({
          startDate: '2026-11-01',
          startTime: '01:30',
          endDate: '2026-11-01',
          endTime: '03:00'
        }),
        'America/Los_Angeles'
      )
    ).toMatchObject({ ok: true, value: { startMs: at('2026-11-01T08:30:00Z') } })
  })
})

describe('an all-day event', () => {
  it('goes to the server with the day after its last day as the end', () => {
    expect(prepareEvent(allDay(), 'Asia/Seoul')).toEqual({
      ok: true,
      value: { title: '출장', allDay: true, startDate: '2026-10-26', endDate: '2026-10-28' }
    })
  })

  it('is one day when it ends the day it starts', () => {
    expect(prepareEvent(allDay({ endDate: '2026-10-26' }), 'Asia/Seoul')).toMatchObject({
      ok: true,
      value: { startDate: '2026-10-26', endDate: '2026-10-27' }
    })
  })

  it('does not depend on the time zone', () => {
    for (const zone of ['Asia/Seoul', 'America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'])
      expect(prepareEvent(allDay(), zone)).toMatchObject({
        ok: true,
        value: { startDate: '2026-10-26', endDate: '2026-10-28' }
      })
  })

  it('carries over a month and a year end', () => {
    expect(
      prepareEvent(allDay({ startDate: '2026-12-31', endDate: '2026-12-31' }), 'UTC')
    ).toMatchObject({ ok: true, value: { endDate: '2027-01-01' } })
    expect(
      prepareEvent(allDay({ startDate: '2028-02-28', endDate: '2028-02-29' }), 'UTC')
    ).toMatchObject({ ok: true, value: { endDate: '2028-03-01' } })
  })

  it('cannot end before it starts', () => {
    expect(refused(allDay({ endDate: '2026-10-25' }))).toContain('종료 날짜')
  })

  it('has no times', () => {
    expect(refused(allDay({ startTime: '09:00' }))).toContain('종일')
    expect(refused(allDay({ endTime: '10:00' }))).toContain('종일')
  })
})

describe('the title', () => {
  it('has its ends trimmed', () => {
    expect(prepareEvent(timed({ title: '  회의 \n' }), 'UTC')).toMatchObject({
      ok: true,
      value: { title: '회의' }
    })
  })

  it('must not be blank', () => {
    for (const title of ['', '   ', '\n\t'])
      expect(refused(timed({ title }))).toBe('제목을 입력해 주세요.')
  })

  it('takes up to 255 characters, counted as the server counts them', () => {
    expect(prepareEvent(timed({ title: '가'.repeat(255) }), 'UTC').ok).toBe(true)
    expect(refused(timed({ title: '가'.repeat(256) }))).toContain('255')
    // An emoji is one character to the server, though two UTF-16 units.
    expect(prepareEvent(timed({ title: '😀'.repeat(255) }), 'UTC').ok).toBe(true)
    expect(refused(timed({ title: '😀'.repeat(256) }))).toContain('255')
    // Blanks at the ends do not count.
    expect(prepareEvent(timed({ title: ` ${'가'.repeat(255)} ` }), 'UTC').ok).toBe(true)
  })
})

describe('the dates', () => {
  it('must be real dates', () => {
    for (const date of ['2026-02-30', '2026-13-01', '', '22/10/2026', '2026-10-22T00:00', 'x']) {
      expect(refused(timed({ startDate: date }))).toBe('날짜를 확인해 주세요.')
      expect(refused(timed({ endDate: date }))).toBe('날짜를 확인해 주세요.')
      expect(refused(allDay({ startDate: date }))).toBe('날짜를 확인해 주세요.')
    }
  })

  it('must be in a sensible range of years', () => {
    for (const date of ['0001-01-01', '1969-12-31', '2101-01-01', '9999-12-31'])
      expect(refused(timed({ startDate: date, endDate: date }))).toBe('날짜를 확인해 주세요.')
    expect(prepareEvent(allDay({ startDate: '2100-12-31', endDate: '2100-12-31' }), 'UTC').ok).toBe(
      true
    )
    expect(prepareEvent(timed({ startDate: '1970-01-01', endDate: '1970-01-01' }), 'UTC').ok).toBe(
      true
    )
  })
})
