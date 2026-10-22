import type {
  CalendarDay,
  CalendarEventItem,
  CalendarSnapshot,
  CalendarSource,
  CalendarTodoItem,
  CalendarView
} from '../../../../shared/contracts/calendar'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const

/** `2026-10-22` as numbers. Dates are read from their text, never through `Date`, so no zone can move them. */
function parts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number)
  return { year: year!, month: month!, day: day! }
}

const monthDay = (date: string): string => {
  const { month, day } = parts(date)
  return `${month}월 ${day}일`
}

/** `10월 22일 (수)`. */
export function dayHeading(day: Pick<CalendarDay, 'date' | 'weekday'>): string {
  return `${monthDay(day.date)} (${WEEKDAYS[day.weekday]})`
}

/** The range the view covers: one day with its year, or a week, naming the year again only if it changes. */
export function viewTitle(view: CalendarView): string {
  const start = parts(view.startDate)
  if (view.span === 'day')
    return `${start.year}년 ${dayHeading({ date: view.startDate, weekday: view.startWeekday })}`
  const end = parts(view.endDate)
  const last =
    start.year === end.year ? monthDay(view.endDate) : `${end.year}년 ${monthDay(view.endDate)}`
  return `${start.year}년 ${monthDay(view.startDate)} – ${last}`
}

/** When an event happens on a day. */
export function eventTime(
  event: Pick<CalendarEventItem, 'allDay' | 'startTime' | 'endTime'>
): string {
  if (event.allDay) return '종일'
  if (event.startTime && event.endTime) return `${event.startTime} – ${event.endTime}`
  if (event.startTime) return `${event.startTime}부터`
  if (event.endTime) return `${event.endTime}까지`
  return '계속'
}

export const partLabel = (part: CalendarEventItem['part']): string | null =>
  part ? `${part.index}/${part.total}일째` : null

export const sourceLabel = (source: CalendarSource): string =>
  source === 'jarvis' ? '자비스' : source === 'google' ? 'Google' : '다른 캘린더'

/** Only what the user made in JARVIS can be changed in JARVIS. */
export const isReadOnly = (source: CalendarSource): boolean => source !== 'jarvis'

export const todoDue = (todo: Pick<CalendarTodoItem, 'due' | 'time'>): string =>
  todo.due === 'datetime' && todo.time ? `${todo.time}까지` : '마감일'

/** Include the date so an answer read on an earlier day cannot look like today's. */
export function clockTime(ms: number, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {})
    }).format(new Date(ms))
  } catch {
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(ms))
  }
}

export type CalendarBody =
  /** Nothing to show yet: the first read is under way (or not started). */
  | 'loading'
  /** The read failed and there is no earlier answer for these days. */
  | 'error'
  | 'empty'
  | 'days'

export function calendarBody(snapshot: CalendarSnapshot): CalendarBody {
  const hasAnswer = snapshot.loadedAt !== null
  if (!hasAnswer) return snapshot.status === 'failed' ? 'error' : 'loading'
  return snapshot.days.every((day) => day.events.length === 0 && day.todos.length === 0)
    ? 'empty'
    : 'days'
}

export interface CalendarNotice {
  tone: 'error' | 'warning' | 'info'
  text: string
}

/**
 * What to tell the user about how current the page is. A failure is always said, with when the
 * last good read was; an old answer is never left looking current.
 */
export function calendarNotice(snapshot: CalendarSnapshot): CalendarNotice | null {
  if (snapshot.status === 'failed' && snapshot.error) {
    const earlier =
      snapshot.loadedAt !== null
        ? `아래 일정은 ${clockTime(snapshot.loadedAt, snapshot.timeZone)}에 불러온 것이라 최신이 아닐 수 있어요.`
        : snapshot.lastSuccessAt !== null
          ? `마지막으로 일정을 불러온 시각은 ${clockTime(snapshot.lastSuccessAt, snapshot.timeZone)}이에요.`
          : ''
    return { tone: 'error', text: [snapshot.error.message, earlier].filter(Boolean).join(' ') }
  }
  if (snapshot.status === 'loading' && snapshot.loadedAt !== null)
    return { tone: 'info', text: '새로 불러오는 중이에요. 아래는 이전에 불러온 일정이에요.' }
  return null
}
