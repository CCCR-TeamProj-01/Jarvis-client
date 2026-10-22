import { resultSchema } from '../contracts/common'
import type { Result, Unsubscribe } from '../contracts/common'
import { CalendarEditOutcomeSchema, CalendarSnapshotSchema } from '../contracts/calendar'
import type {
  CalendarCreateEventRequest,
  CalendarDeleteEventRequest,
  CalendarEditOutcome,
  CalendarEvent,
  CalendarNavigateRequest,
  CalendarSnapshot,
  CalendarUpdateEventRequest
} from '../contracts/calendar'

export const CalendarSnapshotResponseSchema = resultSchema(CalendarSnapshotSchema)
export const CalendarEditResponseSchema = resultSchema(CalendarEditOutcomeSchema)

/**
 * The calendar tab's API. The window asks to go somewhere and is told the state; the dates, the
 * time zone and the server calls are Main's. The ask resolves when that request has settled.
 *
 * Changing an event: the window sends what the user typed, and gets back what became of it. A
 * failed `Result` means the request never got to the calendar (a refused sender, a bad shape).
 */
export interface CalendarApi {
  navigate(request: CalendarNavigateRequest): Promise<Result<CalendarSnapshot>>
  getSnapshot(): Promise<Result<CalendarSnapshot>>
  subscribe(listener: (event: CalendarEvent) => void): Unsubscribe
  createEvent(request: CalendarCreateEventRequest): Promise<Result<CalendarEditOutcome>>
  updateEvent(request: CalendarUpdateEventRequest): Promise<Result<CalendarEditOutcome>>
  deleteEvent(request: CalendarDeleteEventRequest): Promise<Result<CalendarEditOutcome>>
}
