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

/**
 * The whole of an event in the user's time zone, not just the part on one day. An all-day event
 * ends on its last day (the server's exclusive end date is one day later); a timed event ends at
 * its real end, which can be midnight of the next day.
 */
const ExtentShape = {
  startDate: DateKeySchema,
  /** `null` for an all-day event. */
  startTime: TimeOfDaySchema.nullable(),
  endDate: DateKeySchema,
  endTime: TimeOfDaySchema.nullable()
}
export const CalendarEventExtentSchema = z.strictObject(ExtentShape)
export type CalendarEventExtent = z.infer<typeof CalendarEventExtentSchema>

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
  part: PartSchema.nullable(),
  /** What opening this event for editing starts from. */
  extent: CalendarEventExtentSchema
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

/**
 * An event as the user typed it: dates and times of day on their own calendar and clock, exactly as
 * a form holds them. Main turns them into what the server takes, in the user's time zone. For an
 * all-day event `endDate` is its last day and both times are `null`.
 */
export const CalendarEventDraftSchema = z.strictObject({
  title: z.string(),
  allDay: z.boolean(),
  ...ExtentShape
})
export type CalendarEventDraft = z.infer<typeof CalendarEventDraftSchema>

/** The most characters the server takes in a title (after it trims the ends). */
export const CALENDAR_TITLE_MAX_CHARS = 255

const EventIdSchema = IdentifierSchema

export const CalendarCreateEventRequestSchema = z.strictObject({ draft: CalendarEventDraftSchema })
export type CalendarCreateEventRequest = z.infer<typeof CalendarCreateEventRequestSchema>
export const CalendarUpdateEventRequestSchema = z.strictObject({
  eventId: EventIdSchema,
  draft: CalendarEventDraftSchema
})
export type CalendarUpdateEventRequest = z.infer<typeof CalendarUpdateEventRequestSchema>
export const CalendarDeleteEventRequestSchema = z.strictObject({ eventId: EventIdSchema })
export type CalendarDeleteEventRequest = z.infer<typeof CalendarDeleteEventRequestSchema>

/**
 * What became of a change. `saved`: the server took it and `snapshot` has the calendar read again.
 * `not_saved`: it did not (the reason is in `error`). `unknown`: the request may or may not have
 * been processed; the window must not send it again on its own, because the server does not
 * recognise a repeat of an add.
 */
export const CalendarEditOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('saved'), snapshot: CalendarSnapshotSchema }),
  z.strictObject({
    outcome: z.literal('not_saved'),
    error: ClientErrorSchema,
    snapshot: CalendarSnapshotSchema
  }),
  z.strictObject({
    outcome: z.literal('unknown'),
    error: ClientErrorSchema,
    snapshot: CalendarSnapshotSchema
  })
])
export type CalendarEditOutcome = z.infer<typeof CalendarEditOutcomeSchema>
