/**
 * Dates and times in a named time zone, without a date library. A "date key" is a calendar date as
 * `YYYY-MM-DD`; keys compare correctly as strings. All-day dates are only ever handled as keys,
 * never turned into instants, so they cannot slip to the day before or after.
 */

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_MINUTE = 60 * 1000

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = DATE_KEY.exec(value)
  if (!match) return false
  const [, y, m, d] = match
  const time = Date.UTC(Number(y), Number(m) - 1, Number(d))
  return toKey(new Date(time)) === value
}

function toKey(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0')
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function utcMidnight(key: string): number {
  const [, y, m, d] = DATE_KEY.exec(key)!
  return Date.UTC(Number(y), Number(m) - 1, Number(d))
}

export function addDays(key: string, days: number): string {
  return toKey(new Date(utcMidnight(key) + days * MS_PER_DAY))
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / MS_PER_DAY)
}

/** 0 is Sunday. */
export function weekdayOf(key: string): number {
  return new Date(utcMidnight(key)).getUTCDay()
}

/** The Monday of the week the date is in. */
export function startOfWeek(key: string): string {
  return addDays(key, -((weekdayOf(key) + 6) % 7))
}

/** The date key of `startKey`, `startKey + 1`, … for `count` days. */
export function dateRange(startKey: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addDays(startKey, index))
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** Whether the name is a time zone this runtime knows. Names such as `UTC+9` are not. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return false
  try {
    formatterFor(value)
    return true
  } catch {
    return false
  }
}

interface LocalParts {
  date: string
  hour: string
  minute: string
}

function localParts(ms: number, timeZone: string): LocalParts {
  const parts: Record<string, string> = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms)))
    parts[part.type] = part.value
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parts.hour === '24' ? '00' : parts.hour!,
    minute: parts.minute!
  }
}

/** The calendar date at that instant in the zone. */
export function localDateKey(ms: number, timeZone: string): string {
  return localParts(ms, timeZone).date
}

/** `HH:mm` at that instant in the zone. */
export function localTime(ms: number, timeZone: string): string {
  const { hour, minute } = localParts(ms, timeZone)
  return `${hour}:${minute}`
}

/**
 * The first instant of the date in the zone. Found by search rather than by adding the zone's
 * offset, so a day that starts after a clock change (or has no midnight at all) still comes out
 * right. The search works in whole minutes, which every clock change in use is aligned to.
 */
export function startOfLocalDay(key: string, timeZone: string): number {
  const center = Math.floor(utcMidnight(key) / MS_PER_MINUTE)
  let low = center - 36 * 60
  let high = center + 36 * 60
  // The first minute whose local date is the key or later.
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (localParts(middle * MS_PER_MINUTE, timeZone).date >= key) high = middle
    else low = middle + 1
  }
  return low * MS_PER_MINUTE
}
