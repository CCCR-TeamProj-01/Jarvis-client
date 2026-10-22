import { z } from 'zod'
import { ClientErrorSchema, IdentifierSchema, SequenceSchema, TimestampSchema } from './common'

/**
 * The calendar tab's state, as Main shows it to the window. Main reads the server, converts times
 * into the user's time zone and groups by day; the window only draws what is here. Nothing in a
 * snapshot is a token or a server wording, and event titles are plain text.
 */

export const CALENDAR_SPANS = ['day', 'week', 'month'] as const
export const CalendarSpanSchema = z.enum(CALENDAR_SPANS)
export type CalendarSpan = z.infer<typeof CalendarSpanSchema>

/** Where the window can go. Dates are worked out in Main, in the user's time zone. */
export const CALENDAR_NAVIGATIONS = [
  'today',
  'tomorrow',
  'this_week',
  'this_month',
  'previous',
  'next',
  'refresh'
] as const
export const CalendarNavigationSchema = z.enum(CALENDAR_NAVIGATIONS)
export type CalendarNavigation = z.infer<typeof CalendarNavigationSchema>

export const CalendarNavigateRequestSchema = z.strictObject({
  navigation: CalendarNavigationSchema
})
export type CalendarNavigateRequest = z.infer<typeof CalendarNavigateRequestSchema>

const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const TimeOfDaySchema = z.string().regex(/^\d{2}:\d{2}$/)

/** Where an event came from. Anything the server adds later is `other`; only `jarvis` can be edited. */
export const CalendarSourceSchema = z.enum(['jarvis', 'google', 'other'])
export type CalendarSource = z.infer<typeof CalendarSourceSchema>

/** Day `index` of `total`, for an event that covers several days. */
const PartSchema = z.strictObject({
  index: z.number().int().min(1),
  total: z.number().int().min(2)
})

export const CalendarEventItemSchema = z.strictObject({
  kind: z.literal('event'),
  id: IdentifierSchema,
  title: z.string(),
  source: CalendarSourceSchema,
  /** An all-day event has a date, no time. */
  allDay: z.boolean(),
  /** `null`: no start time on this day, because it began on an earlier day (or all day). */
  startTime: TimeOfDaySchema.nullable(),
  /** `null`: no end time on this day, because it goes on to a later day (or all day). */
  endTime: TimeOfDaySchema.nullable(),
  part: PartSchema.nullable()
})
export type CalendarEventItem = z.infer<typeof CalendarEventItemSchema>

export const CalendarTodoItemSchema = z.strictObject({
  kind: z.literal('todo'),
  id: IdentifierSchema,
  title: z.string(),
  /** A due date, or a due date and time. A to-do with no deadline has no day and is not shown. */
  due: z.enum(['date', 'datetime']),
  time: TimeOfDaySchema.nullable(),
  done: z.boolean()
})
export type CalendarTodoItem = z.infer<typeof CalendarTodoItemSchema>

export const CalendarDaySchema = z.strictObject({
  date: DateKeySchema,
  /** 0 is Sunday. */
  weekday: z.number().int().min(0).max(6),
  isToday: z.boolean(),
  events: z.array(CalendarEventItemSchema),
  todos: z.array(CalendarTodoItemSchema)
})
export type CalendarDay = z.infer<typeof CalendarDaySchema>

export const CalendarViewSchema = z.strictObject({
  span: CalendarSpanSchema,
  /** The first day shown. */
  startDate: DateKeySchema,
  /** The weekday of `startDate`; 0 is Sunday. */
  startWeekday: z.number().int().min(0).max(6),
  /** The last day shown (inclusive). */
  endDate: DateKeySchema
})
export type CalendarView = z.infer<typeof CalendarViewSchema>

/**
 * `idle`: nothing asked for yet. `loading`: the server is being asked. `ready`: `days` is what the
 * server answered at `loadedAt`. `failed`: the last try failed; `days` is then an earlier answer
 * for the same days (with its `loadedAt`) or empty, and must not be presented as current.
 */
export const CalendarSnapshotSchema = z
  .strictObject({
    /** Rises with every change, so a late snapshot can be told from the current one. */
    revision: SequenceSchema,
    status: z.enum(['idle', 'loading', 'ready', 'failed']),
    view: CalendarViewSchema.nullable(),
    /** The user's time zone from the server, once known. */
    timeZone: z.string().min(1).nullable(),
    days: z.array(CalendarDaySchema),
    /** When `days` was read from the server, on this machine's clock; null when it never was. */
    loadedAt: TimestampSchema.nullable(),
    /** When the server was last read successfully, for any days. */
    lastSuccessAt: TimestampSchema.nullable(),
    error: ClientErrorSchema.nullable()
  })
  .refine((state) => (state.status === 'failed') === (state.error !== null), {
    message: 'An error goes with, and only with, a failed state'
  })
export type CalendarSnapshot = z.infer<typeof CalendarSnapshotSchema>

export const CalendarEventSchema = z.strictObject({
  type: z.literal('calendar.state_changed'),
  snapshot: CalendarSnapshotSchema
})
export type CalendarEvent = z.infer<typeof CalendarEventSchema>
