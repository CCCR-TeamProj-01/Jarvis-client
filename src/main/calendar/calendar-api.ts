import { z } from 'zod'
import type { ClientError, Result } from '../../shared/contracts/common'
import type { CalendarSource } from '../../shared/contracts/calendar'
import type { PreparedEvent } from './event-draft'
import type { ServerClient } from '../connection/server-client'
import { EmptyResponse } from '../connection/server-client'
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

/**
 * What became of a change. `rejected`: the server did not take it, and nothing changed. `unknown`:
 * the request went out but the answer did not come back readable, so the server may have taken it.
 */
export type ChangeOutcome =
  | { kind: 'done' }
  | {
      kind: 'rejected'
      reason: 'read_only' | 'not_found' | 'invalid' | 'other'
      error: ClientError
    }
  | { kind: 'unknown'; error: ClientError }

export interface CalendarApiPort {
  /** The user's time zone name, as the server has it. */
  timeZone(signal?: AbortSignal): Promise<Result<string>>
  /** Events and to-dos that may fall in `[fromMs, toMs)`. The server can return more than that. */
  events(
    window: { fromMs: number; toMs: number },
    signal?: AbortSignal
  ): Promise<Result<CalendarAnswer>>
  createEvent(event: PreparedEvent, signal?: AbortSignal): Promise<ChangeOutcome>
  updateEvent(eventId: string, event: PreparedEvent, signal?: AbortSignal): Promise<ChangeOutcome>
  deleteEvent(eventId: string, signal?: AbortSignal): Promise<ChangeOutcome>
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

/** What a change returns. Only that it is an event is checked; the calendar is read again after. */
const ChangedEventSchema = z.looseObject({ event_id: ServerIdSchema })
const DeletedSchema = z.union([EmptyResponse, z.looseObject({})])

/** The body for adding or replacing an event. Every field is named, so a switch between all-day and timed clears the other kind. */
function eventBody(event: PreparedEvent) {
  return event.allDay
    ? {
        title: event.title,
        is_all_day: true,
        start_at: null,
        end_at: null,
        start_date: event.startDate,
        end_date: event.endDate
      }
    : {
        title: event.title,
        is_all_day: false,
        start_at: new Date(event.startMs).toISOString(),
        end_at: new Date(event.endMs).toISOString(),
        start_date: null,
        end_date: null
      }
}

const REFUSALS = {
  read_only: 'Google에서 가져온 일정은 자비스에서 바꿀 수 없어요.',
  not_found: '이미 삭제됐거나 찾을 수 없는 일정이에요.',
  invalid: '서버가 입력한 내용을 받아들이지 못했어요. 제목과 시간을 확인해 주세요.'
} as const

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

  createEvent(event: PreparedEvent, signal?: AbortSignal): Promise<ChangeOutcome> {
    return this.change('POST', '/calendar/events', eventBody(event), ChangedEventSchema, signal)
  }

  updateEvent(eventId: string, event: PreparedEvent, signal?: AbortSignal): Promise<ChangeOutcome> {
    return this.onEvent(eventId, (path) =>
      this.change('PATCH', path, eventBody(event), ChangedEventSchema, signal)
    )
  }

  deleteEvent(eventId: string, signal?: AbortSignal): Promise<ChangeOutcome> {
    return this.onEvent(eventId, (path) =>
      this.change('DELETE', path, undefined, DeletedSchema, signal)
    )
  }

  /** The ID is the server's own, from an earlier answer; check it anyway before it joins a path. */
  private onEvent(
    eventId: string,
    run: (path: string) => Promise<ChangeOutcome>
  ): Promise<ChangeOutcome> {
    if (!/^\d{1,16}$/.test(eventId))
      return Promise.resolve({
        kind: 'rejected',
        reason: 'not_found',
        error: { code: 'not_found', message: REFUSALS.not_found }
      })
    return run(`/calendar/events/${eventId}`)
  }

  /**
   * Sends one change, once. The server ignores `Idempotency-Key` on events (checked against the
   * real server: the same key twice made two events), so a repeat cannot be told from a new add and
   * nothing here retries. A refusal (4xx) changed nothing; no answer, an answer that cannot be
   * read, or a server error leaves it open whether the change was made.
   */
  private async change<T>(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    response: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<ChangeOutcome> {
    const result = await this.client.request({
      method,
      path,
      ...(body === undefined ? {} : { body }),
      response,
      ...(signal ? { signal } : {})
    })
    if (result.ok) return { kind: 'done' }
    const { detail } = result
    if (detail.delivery === 'not_sent')
      return { kind: 'rejected', reason: 'other', error: result.error }
    const status = detail.status
    if (detail.delivery === 'responded' && status !== undefined && status >= 400 && status < 500) {
      if (status === 409 && detail.serverCode === 'EXTERNAL_EVENT_READ_ONLY')
        return rejected('read_only')
      if (status === 404) return rejected('not_found')
      if (status === 422) return rejected('invalid')
      return { kind: 'rejected', reason: 'other', error: result.error }
    }
    return { kind: 'unknown', error: result.error }
  }
}

const rejected = (reason: keyof typeof REFUSALS): ChangeOutcome => ({
  kind: 'rejected',
  reason,
  error: {
    code:
      reason === 'read_only' ? 'conflict' : reason === 'not_found' ? 'not_found' : 'invalid_input',
    message: REFUSALS[reason]
  }
})
