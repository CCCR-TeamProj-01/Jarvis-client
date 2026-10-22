import { CALENDAR_TITLE_MAX_CHARS } from '../../shared/contracts/calendar'
import type { CalendarEventDraft } from '../../shared/contracts/calendar'
import type { Result } from '../../shared/contracts/common'
import { addDays, instantAt, isDateKey } from './zoned-time'

/** An event as the server takes it: instants for a timed event, dates for an all-day one. */
export type PreparedEvent =
  | { title: string; allDay: false; startMs: number; endMs: number }
  /** `endDate` is the day after the last day, as the server wants it. */
  | { title: string; allDay: true; startDate: string; endDate: string }

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/
const FIRST_YEAR = 1970
const LAST_YEAR = 2100

const invalid = (message: string): Result<never> => ({
  ok: false,
  error: { code: 'invalid_input', message }
})

const inRange = (date: string): boolean => {
  const year = Number(date.slice(0, 4))
  return year >= FIRST_YEAR && year <= LAST_YEAR
}

/**
 * Checks what the user typed and turns it into what the server takes, in the user's time zone.
 * The window only passes the values through; the rules are here, and each refusal says in plain
 * words what to change.
 */
export function prepareEvent(draft: CalendarEventDraft, timeZone: string): Result<PreparedEvent> {
  const title = draft.title.trim()
  if (title === '') return invalid('제목을 입력해 주세요.')
  if (Array.from(title).length > CALENDAR_TITLE_MAX_CHARS)
    return invalid(`제목은 ${CALENDAR_TITLE_MAX_CHARS}자까지 쓸 수 있어요.`)
  if (
    !isDateKey(draft.startDate) ||
    !isDateKey(draft.endDate) ||
    !inRange(draft.startDate) ||
    !inRange(draft.endDate)
  )
    return invalid('날짜를 확인해 주세요.')

  if (draft.allDay) {
    if (draft.startTime !== null || draft.endTime !== null)
      return invalid('종일 일정에는 시각을 쓸 수 없어요.')
    if (draft.endDate < draft.startDate)
      return invalid('종료 날짜는 시작 날짜와 같거나 늦어야 해요.')
    return {
      ok: true,
      value: {
        title,
        allDay: true,
        startDate: draft.startDate,
        // The server's end is exclusive; the user's last day is included.
        endDate: addDays(draft.endDate, 1)
      }
    }
  }

  if (draft.startTime === null || draft.endTime === null)
    return invalid('시작과 종료 시각을 입력해 주세요.')
  if (!TIME_OF_DAY.test(draft.startTime) || !TIME_OF_DAY.test(draft.endTime))
    return invalid('시각을 확인해 주세요.')
  const startMs = instantAt(draft.startDate, draft.startTime, timeZone)
  const endMs = instantAt(draft.endDate, draft.endTime, timeZone)
  if (startMs === null)
    return invalid(
      `${draft.startDate} ${draft.startTime}은 시간대 전환으로 건너뛰는 시각이에요. 다른 시각을 골라 주세요.`
    )
  if (endMs === null)
    return invalid(
      `${draft.endDate} ${draft.endTime}은 시간대 전환으로 건너뛰는 시각이에요. 다른 시각을 골라 주세요.`
    )
  if (endMs <= startMs) return invalid('종료 시각은 시작 시각보다 늦어야 해요.')
  return { ok: true, value: { title, allDay: false, startMs, endMs } }
}
