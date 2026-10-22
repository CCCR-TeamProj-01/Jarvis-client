import { describe, expect, it } from 'vitest'
import {
  addDays,
  dateRange,
  daysBetween,
  isDateKey,
  isTimeZone,
  localDateKey,
  localTime,
  startOfLocalDay,
  startOfWeek,
  weekdayOf
} from '../../src/main/calendar/zoned-time'

const HOUR = 3_600_000
const at = (iso: string) => Date.parse(iso)

describe('date keys', () => {
  it('accepts real dates only', () => {
    for (const key of ['2026-10-22', '2024-02-29', '2026-12-31']) expect(isDateKey(key)).toBe(true)
    for (const key of [
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '2026-1-5',
      '2026-10-22T00:00:00Z',
      ' 2026-10-22',
      '',
      null,
      20261022
    ])
      expect(isDateKey(key)).toBe(false)
  })

  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-10-22', 0)).toBe('2026-10-22')
  })

  it('counts the days between two dates', () => {
    expect(daysBetween('2026-10-22', '2026-10-25')).toBe(3)
    expect(daysBetween('2026-10-25', '2026-10-22')).toBe(-3)
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3)
    expect(daysBetween('2026-10-22', '2026-10-22')).toBe(0)
  })

  it('names the weekday and finds the Monday of a week', () => {
    expect(weekdayOf('2026-10-22')).toBe(4) // Thursday
    expect(weekdayOf('2026-10-25')).toBe(0) // Sunday
    expect(startOfWeek('2026-10-22')).toBe('2026-10-19')
    expect(startOfWeek('2026-10-19')).toBe('2026-10-19')
    // A Sunday belongs to the week that began the Monday before.
    expect(startOfWeek('2026-10-25')).toBe('2026-10-19')
    expect(startOfWeek('2027-01-01')).toBe('2026-12-28')
  })

  it('lists consecutive dates', () => {
    expect(dateRange('2026-10-30', 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01'])
    expect(dateRange('2026-10-30', 0)).toEqual([])
  })
})

describe('time zones', () => {
  it('knows zone names and refuses anything else', () => {
    for (const name of ['Asia/Seoul', 'UTC', 'America/Los_Angeles'])
      expect(isTimeZone(name)).toBe(true)
    for (const name of ['UTC+9', 'Mars/Base', '', ' Asia/Seoul', null, 9])
      expect(isTimeZone(name)).toBe(false)
  })

  it('reads the local date and time at an instant', () => {
    // 15:00Z on the 21st is midnight on the 22nd in Seoul (UTC+9, no daylight time).
    expect(localDateKey(at('2026-10-21T15:00:00Z'), 'Asia/Seoul')).toBe('2026-10-22')
    expect(localTime(at('2026-10-21T15:00:00Z'), 'Asia/Seoul')).toBe('00:00')
    expect(localDateKey(at('2026-10-21T14:59:59Z'), 'Asia/Seoul')).toBe('2026-10-21')
    expect(localTime(at('2026-10-21T14:59:59Z'), 'Asia/Seoul')).toBe('23:59')
    expect(localTime(at('2026-10-22T05:00:00Z'), 'Asia/Seoul')).toBe('14:00')
    // West of Greenwich the local date is the earlier one.
    expect(localDateKey(at('2026-10-22T05:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-21')
    expect(localTime(at('2026-10-22T05:00:00Z'), 'America/Los_Angeles')).toBe('22:00')
  })

  it('shows midnight as 00:00, never 24:00', () => {
    expect(localTime(at('2026-10-22T00:00:00Z'), 'UTC')).toBe('00:00')
  })

  it('finds the first instant of a day', () => {
    expect(startOfLocalDay('2026-10-22', 'Asia/Seoul')).toBe(at('2026-10-21T15:00:00Z'))
    expect(startOfLocalDay('2026-10-22', 'UTC')).toBe(at('2026-10-22T00:00:00Z'))
    expect(startOfLocalDay('2026-10-22', 'America/Los_Angeles')).toBe(at('2026-10-22T07:00:00Z'))
    expect(startOfLocalDay('2026-10-22', 'Asia/Kolkata')).toBe(at('2026-10-21T18:30:00Z'))
  })

  it('keeps day boundaries right across a clock change', () => {
    const zone = 'America/Los_Angeles'
    // Clocks go back on 2026-11-01: that day has 25 hours.
    expect(startOfLocalDay('2026-11-02', zone) - startOfLocalDay('2026-11-01', zone)).toBe(
      25 * HOUR
    )
    // Clocks go forward on 2026-03-08: that day has 23 hours.
    expect(startOfLocalDay('2026-03-09', zone) - startOfLocalDay('2026-03-08', zone)).toBe(
      23 * HOUR
    )
  })

  it('starts a day with no midnight at its first real moment', () => {
    // Havana skips 00:00-01:00 on 2026-03-08; the day begins at what the clock then calls 01:00.
    const start = startOfLocalDay('2026-03-08', 'America/Havana')
    expect(localDateKey(start, 'America/Havana')).toBe('2026-03-08')
    expect(localDateKey(start - 60_000, 'America/Havana')).toBe('2026-03-07')
  })

  it('has every first instant belong to its own day and the minute before to the day before', () => {
    for (const zone of ['Asia/Seoul', 'America/Los_Angeles', 'Europe/London', 'Australia/Sydney']) {
      for (const day of ['2026-01-15', '2026-03-29', '2026-10-25', '2026-11-01', '2026-04-05']) {
        const start = startOfLocalDay(day, zone)
        expect(localDateKey(start, zone)).toBe(day)
        expect(localDateKey(start - 60_000, zone)).toBe(addDays(day, -1))
      }
    }
  })
})
