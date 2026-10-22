import type {
  CalendarDay,
  CalendarEventItem,
  CalendarSpan,
  CalendarTodoItem,
  CalendarView
} from '../../shared/contracts/calendar'
import type { ServerEvent, ServerTodo } from './calendar-api'
import {
  addDays,
  dateRange,
  daysBetween,
  localDateKey,
  localTime,
  monthStart,
  startOfLocalDay,
  startOfWeek,
  weekdayOf
} from './zoned-time'

const MAX_TITLE_CHARS = 200

/** The day, Monday-to-Sunday week, or calendar month containing `anchor`. */
export function viewOf(span: CalendarSpan, anchor: string): CalendarView {
  const startDate =
    span === 'month' ? monthStart(anchor) : span === 'week' ? startOfWeek(anchor) : anchor
  return {
    span,
    startDate,
    startWeekday: weekdayOf(startDate),
    endDate:
      span === 'month'
        ? addDays(monthStart(anchor, 1), -1)
        : addDays(startDate, span === 'week' ? 6 : 0)
  }
}

/** Move by a day, week, or month according to the current view. */
export function shiftView(view: CalendarView, direction: 1 | -1): CalendarView {
  return viewOf(
    view.span,
    view.span === 'month'
      ? monthStart(view.startDate, direction)
      : addDays(view.startDate, direction * (view.span === 'week' ? 7 : 1))
  )
}

/**
 * The period to ask the server for. The server compares all-day dates and to-do due dates with
 * the UTC date of `from` and `to`, not the user's, so an all-day event on the user's first or last
 * day can be missed or an extra one returned. Asking for the wider of the user's days and the same
 * dates read as UTC covers both; what falls outside the view is then dropped here.
 */
export function serverWindow(
  view: CalendarView,
  timeZone: string
): { fromMs: number; toMs: number } {
  const dayAfter = addDays(view.endDate, 1)
  const utcDay = (key: string) => Date.parse(`${key}T00:00:00Z`)
  return {
    fromMs: Math.min(startOfLocalDay(view.startDate, timeZone), utcDay(view.startDate)),
    toMs: Math.max(startOfLocalDay(dayAfter, timeZone), utcDay(dayAfter))
  }
}

const clip = (title: string): string => {
  const characters = Array.from(title.trim())
  return characters.length > MAX_TITLE_CHARS
    ? `${characters.slice(0, MAX_TITLE_CHARS).join('')}…`
    : characters.join('')
}

const minutesOf = (time: string | null): number =>
  time === null ? -1 : Number(time.slice(0, 2)) * 60 + Number(time.slice(3))

function eventsOnDay(date: string, events: readonly ServerEvent[], timeZone: string) {
  const items: CalendarEventItem[] = []
  for (const event of events) {
    if (event.cancelled) continue
    const common = {
      kind: 'event' as const,
      id: event.id,
      title: clip(event.title),
      source: event.source
    }
    if (event.allDay) {
      // The end is the day after the last day; one that is not after the start means one day.
      const end = event.endDate > event.startDate ? event.endDate : addDays(event.startDate, 1)
      if (date < event.startDate || date >= end) continue
      const total = daysBetween(event.startDate, end)
      items.push({
        ...common,
        allDay: true,
        startTime: null,
        endTime: null,
        part: total > 1 ? { index: daysBetween(event.startDate, date) + 1, total } : null
      })
      continue
    }
    const firstDate = localDateKey(event.startMs, timeZone)
    // An event that ends at midnight does not reach into the next day.
    const lastDate = localDateKey(Math.max(event.startMs, event.endMs - 1), timeZone)
    if (date < firstDate || date > lastDate) continue
    const endsOnDay = date === lastDate
    const end = localTime(event.endMs, timeZone)
    items.push({
      ...common,
      allDay: false,
      startTime: date === firstDate ? localTime(event.startMs, timeZone) : null,
      // Ending exactly at midnight is the end of the day before, not the start of the next.
      endTime: endsOnDay
        ? end === '00:00' && lastDate < localDateKey(event.endMs, timeZone)
          ? '24:00'
          : end
        : null,
      part:
        firstDate === lastDate
          ? null
          : { index: daysBetween(firstDate, date) + 1, total: daysBetween(firstDate, lastDate) + 1 }
    })
  }
  return items.sort(
    (a, b) =>
      Number(b.allDay) - Number(a.allDay) ||
      minutesOf(a.startTime) - minutesOf(b.startTime) ||
      a.title.localeCompare(b.title, 'ko')
  )
}

function todosOnDay(date: string, todos: readonly ServerTodo[], timeZone: string) {
  const items: CalendarTodoItem[] = []
  for (const todo of todos) {
    const common = { kind: 'todo' as const, id: todo.id, title: clip(todo.title), done: todo.done }
    if (todo.due.kind === 'date') {
      if (todo.due.date === date) items.push({ ...common, due: 'date', time: null })
    } else if (localDateKey(todo.due.atMs, timeZone) === date) {
      items.push({ ...common, due: 'datetime', time: localTime(todo.due.atMs, timeZone) })
    }
  }
  return items.sort(
    (a, b) => minutesOf(a.time) - minutesOf(b.time) || a.title.localeCompare(b.title, 'ko')
  )
}

/** Every day of the view, with what falls on it in the user's time zone. */
export function buildDays(options: {
  view: CalendarView
  timeZone: string
  today: string
  events: readonly ServerEvent[]
  todos: readonly ServerTodo[]
}): CalendarDay[] {
  const { view, timeZone, today, events, todos } = options
  return dateRange(view.startDate, daysBetween(view.startDate, view.endDate) + 1).map((date) => ({
    date,
    weekday: weekdayOf(date),
    isToday: date === today,
    events: eventsOnDay(date, events, timeZone),
    todos: todosOnDay(date, todos, timeZone)
  }))
}
