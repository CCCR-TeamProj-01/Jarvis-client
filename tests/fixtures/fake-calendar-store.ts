/**
 * The calendar part of the Jarvis server, kept in memory, following the real server's rules as read
 * from its code (app/db/repositories/calendar_events.py and contracts/calendar.py) and checked
 * against it on 2026-10-22:
 *
 * - a title is trimmed and must be 1 to 255 characters; a field that is not known is refused
 * - an all-day event has dates only, an end after its start; a timed event has times only, an end after its start
 * - `Idempotency-Key` is ignored: sending the same add twice makes two events
 * - deleting cancels (204), also a second time; a cancelled event is left out of the list
 * - an event from Google cannot be changed (409)
 * - a read compares all-day dates and to-do due dates with the UTC date of `from` and `to`
 */

export interface StoredEvent {
  event_id: number
  title: string
  source: 'jarvis' | 'google'
  is_all_day: boolean
  start_at: number | null
  end_at: number | null
  start_date: string | null
  end_date: string | null
  status: 'confirmed' | 'cancelled'
}

export interface StoredTodo {
  todo_id: number
  title: string
  due_kind: 'date' | 'datetime'
  due_date: string | null
  due_at: number | null
  status: 'open' | 'completed'
}

export interface StoreAnswer {
  status: number
  payload?: unknown
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')
const isDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  DATE.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
const invalid = (): StoreAnswer => ({
  status: 422,
  payload: { error: { code: 'VALIDATION_ERROR', message: 'x' } }
})

/** A time with a zone, or without one (read as UTC), as the server reads it. */
function parseTime(value: unknown): number | null | 'bad' {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return 'bad'
  const text = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? 'bad' : ms
}

export class FakeCalendarStore {
  readonly events: StoredEvent[] = []
  readonly todos: StoredTodo[] = []
  /** Answers for the next changes, in order: a status code, 'lost' to make the change and then drop the connection. */
  faults: (number | 'lost' | 'ok')[] = []
  private nextId = 100

  /** An event as another client (or the assistant in a conversation) would have made it. */
  add(event: Partial<StoredEvent> & Pick<StoredEvent, 'title'>): StoredEvent {
    const stored: StoredEvent = {
      event_id: this.nextId++,
      source: 'jarvis',
      is_all_day: false,
      start_at: null,
      end_at: null,
      start_date: null,
      end_date: null,
      status: 'confirmed',
      ...event
    }
    this.events.push(stored)
    return stored
  }

  private view(event: StoredEvent) {
    return {
      ...event,
      start_at: event.start_at === null ? null : iso(event.start_at),
      end_at: event.end_at === null ? null : iso(event.end_at)
    }
  }

  list(from: string, to: string, includeTodos: boolean): StoreAnswer {
    const start = parseTime(from)
    const end = parseTime(to)
    if (typeof start !== 'number' || typeof end !== 'number' || start >= end) return invalid()
    const startDay = iso(start).slice(0, 10)
    const endDay = iso(end).slice(0, 10)
    const items = this.events
      .filter((event) => event.status === 'confirmed')
      .filter((event) =>
        event.is_all_day
          ? event.start_date! < endDay && event.end_date! > startDay
          : event.start_at! < end && event.end_at! > start
      )
      .sort(
        (a, b) =>
          (a.start_at ?? 0) - (b.start_at ?? 0) ||
          (a.start_date ?? '').localeCompare(b.start_date ?? '') ||
          a.event_id - b.event_id
      )
      .map((event) => this.view(event))
    const todos = includeTodos
      ? this.todos
          .filter((todo) => todo.status === 'open')
          .filter((todo) =>
            todo.due_at !== null
              ? todo.due_at >= start && todo.due_at < end
              : todo.due_date! >= startDay && todo.due_date! < endDay
          )
          .map((todo) => ({
            ...todo,
            due_at: todo.due_at === null ? null : iso(todo.due_at)
          }))
      : []
    return { status: 200, payload: { items, todos } }
  }

  create(body: Record<string, unknown> | null): StoreAnswer {
    if (!body) return invalid()
    const allowed = [
      'title',
      'is_all_day',
      'start_at',
      'end_at',
      'start_date',
      'end_date',
      'source_request_id'
    ]
    if (Object.keys(body).some((key) => !allowed.includes(key))) return invalid()
    const event = this.read(body)
    if ('status' in event) return event
    const stored = this.add(event)
    return { status: 201, payload: this.view(stored) }
  }

  update(id: number, body: Record<string, unknown> | null): StoreAnswer {
    const row = this.events.find((event) => event.event_id === id)
    if (!row)
      return { status: 404, payload: { error: { code: 'RESOURCE_NOT_FOUND', message: 'x' } } }
    const allowed = ['title', 'is_all_day', 'start_at', 'end_at', 'start_date', 'end_date']
    if (!body || Object.keys(body).length === 0) return invalid()
    if (Object.keys(body).some((key) => !allowed.includes(key))) return invalid()
    if ('title' in body && body.title === null) return invalid()
    if (row.source !== 'jarvis') return readOnly()
    // A change names some fields; the row as it would then be is what has to be valid.
    const next = this.read({ ...bodyOf(row), ...body })
    if ('status' in next) return next
    Object.assign(row, next)
    return { status: 200, payload: this.view(row) }
  }

  remove(id: number): StoreAnswer {
    const row = this.events.find((event) => event.event_id === id)
    if (!row)
      return { status: 404, payload: { error: { code: 'RESOURCE_NOT_FOUND', message: 'x' } } }
    if (row.source !== 'jarvis') return readOnly()
    row.status = 'cancelled'
    return { status: 204 }
  }

  /** Checks the fields as the server's model does, and returns the event they describe. */
  private read(
    fields: Record<string, unknown>
  ): Omit<StoredEvent, 'event_id' | 'source' | 'status'> | StoreAnswer {
    const rawTitle = fields.title
    if (typeof rawTitle !== 'string') return invalid()
    const title = rawTitle.trim()
    if (title.length < 1 || Array.from(title).length > 255) return invalid()
    const allDay = fields.is_all_day ?? false
    if (typeof allDay !== 'boolean') return invalid()
    const startAt = parseTime(fields.start_at)
    const endAt = parseTime(fields.end_at)
    if (startAt === 'bad' || endAt === 'bad') return invalid()
    const startDate = fields.start_date ?? null
    const endDate = fields.end_date ?? null
    if ((startDate !== null && !isDate(startDate)) || (endDate !== null && !isDate(endDate)))
      return invalid()
    if (allDay) {
      if (startDate === null || endDate === null || startAt !== null || endAt !== null)
        return invalid()
      if (startDate >= endDate) return invalid()
    } else {
      if (startAt === null || endAt === null || startDate !== null || endDate !== null)
        return invalid()
      if (startAt >= endAt) return invalid()
    }
    return {
      title,
      is_all_day: allDay,
      start_at: startAt,
      end_at: endAt,
      start_date: startDate as string | null,
      end_date: endDate as string | null
    }
  }
}

/** The stored row as the request body would name it. */
function bodyOf(row: StoredEvent): Record<string, unknown> {
  return {
    title: row.title,
    is_all_day: row.is_all_day,
    start_at: row.start_at === null ? null : iso(row.start_at),
    end_at: row.end_at === null ? null : iso(row.end_at),
    start_date: row.start_date,
    end_date: row.end_date
  }
}

const readOnly = (): StoreAnswer => ({
  status: 409,
  payload: { error: { code: 'EXTERNAL_EVENT_READ_ONLY', message: 'x' } }
})
