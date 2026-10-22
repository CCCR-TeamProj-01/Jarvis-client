import { z } from 'zod'
import type { Result } from '../../shared/contracts/common'
import type { CalendarSource } from '../../shared/contracts/calendar'
import type { ServerClient } from '../connection/server-client'
import { ServerIdSchema } from '../connection/server-ids'
import { ServerTimeSchema } from '../connection/server-time'
import { isDateKey } from './zoned-time'

/** An event as the server holds it, with times as instants and all-day dates as dates. */
export type ServerEvent = {
  id: string
  title: string
  source: CalendarSource
  cancelled: boolean
} & (
  | { allDay: false; startMs: number; endMs: number }
  /** `endDate` is the day after the last day (the server's own rule). */
  | { allDay: true; startDate: string; endDate: string }
)

/** A to-do with a deadline. One with no deadline has no place on a calendar and is not carried. */
export interface ServerTodo {
  id: string
  title: string
  due: { kind: 'date'; date: string } | { kind: 'datetime'; atMs: number }
  done: boolean
}

export interface CalendarAnswer {
  events: ServerEvent[]
  todos: ServerTodo[]
}

export interface CalendarApiPort {
  /** The user's time zone name, as the server has it. */
  timeZone(signal?: AbortSignal): Promise<Result<string>>
  /** Events and to-dos that may fall in `[fromMs, toMs)`. The server can return more than that. */
  events(
    window: { fromMs: number; toMs: number },
    signal?: AbortSignal
  ): Promise<Result<CalendarAnswer>>
}

const SettingsSchema = z.looseObject({ timezone: z.string().min(1) })

const RawEventSchema = z.looseObject({
  event_id: ServerIdSchema,
  title: z.string(),
  source: z.string(),
  is_all_day: z.boolean(),
  start_at: ServerTimeSchema.nullish(),
  end_at: ServerTimeSchema.nullish(),
  start_date: z.string().nullish(),
  end_date: z.string().nullish(),
  status: z.string()
})
const RawTodoSchema = z.looseObject({
  todo_id: ServerIdSchema,
  title: z.string(),
  due_kind: z.string().nullish(),
  due_date: z.string().nullish(),
  due_at: ServerTimeSchema.nullish(),
  status: z.string()
})
const EventListSchema = z.looseObject({
  items: z.array(RawEventSchema),
  todos: z.array(RawTodoSchema).nullish()
})

const invalidAnswer = {
  ok: false,
  error: { code: 'internal', message: '서버가 보낸 일정을 읽지 못했어요.' }
} as const

function sourceOf(value: string): CalendarSource {
  return value === 'jarvis' || value === 'google' ? value : 'other'
}

function readEvent(raw: z.infer<typeof RawEventSchema>): ServerEvent | null {
  const base = {
    id: raw.event_id,
    title: raw.title,
    source: sourceOf(raw.source),
    cancelled: raw.status === 'cancelled'
  }
  if (raw.is_all_day) {
    if (!isDateKey(raw.start_date)) return null
    // A missing end is one day; the server never sends one that is not after the start.
    const end = raw.end_date ?? null
    if (end !== null && !isDateKey(end)) return null
    return { ...base, allDay: true, startDate: raw.start_date, endDate: end ?? raw.start_date }
  }
  if (!raw.start_at || !raw.end_at) return null
  return {
    ...base,
    allDay: false,
    startMs: Date.parse(raw.start_at),
    endMs: Date.parse(raw.end_at)
  }
}

function readTodo(raw: z.infer<typeof RawTodoSchema>): ServerTodo | null | 'invalid' {
  // The spec names the states `pending` and `completed`; the real server says `open`.
  const done = raw.status === 'completed'
  const kind = raw.due_kind ?? (raw.due_at ? 'datetime' : raw.due_date ? 'date' : 'none')
  if (kind === 'none') return null
  if (kind === 'date') {
    if (!isDateKey(raw.due_date)) return 'invalid'
    return { id: raw.todo_id, title: raw.title, due: { kind: 'date', date: raw.due_date }, done }
  }
  if (kind === 'datetime') {
    if (!raw.due_at) return 'invalid'
    return {
      id: raw.todo_id,
      title: raw.title,
      due: { kind: 'datetime', atMs: Date.parse(raw.due_at) },
      done
    }
  }
  return 'invalid'
}

/** The calendar over REST: the user's settings (for the time zone) and the events of a period. */
export class CalendarApi implements CalendarApiPort {
  constructor(private readonly client: ServerClient) {}

  async timeZone(signal?: AbortSignal): Promise<Result<string>> {
    const response = await this.client.request({
      method: 'GET',
      path: '/me/settings',
      response: SettingsSchema,
      ...(signal ? { signal } : {})
    })
    if (!response.ok) return { ok: false, error: response.error }
    return { ok: true, value: response.value.timezone }
  }

  async events(
    window: { fromMs: number; toMs: number },
    signal?: AbortSignal
  ): Promise<Result<CalendarAnswer>> {
    const response = await this.client.request({
      method: 'GET',
      path: '/calendar/events',
      query: {
        from: new Date(window.fromMs).toISOString(),
        to: new Date(window.toMs).toISOString(),
        include_todos: true
      },
      response: EventListSchema,
      ...(signal ? { signal } : {})
    })
    if (!response.ok) return { ok: false, error: response.error }
    // One item that cannot be read fails the whole answer: a calendar missing an event would be
    // read as a free day.
    const events: ServerEvent[] = []
    for (const raw of response.value.items) {
      const event = readEvent(raw)
      if (!event || (!event.allDay && !(event.startMs <= event.endMs))) return invalidAnswer
      events.push(event)
    }
    const todos: ServerTodo[] = []
    for (const raw of response.value.todos ?? []) {
      const todo = readTodo(raw)
      if (todo === 'invalid') return invalidAnswer
      if (todo) todos.push(todo)
    }
    return { ok: true, value: { events, todos } }
  }
}
