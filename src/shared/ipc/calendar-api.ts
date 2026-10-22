import { resultSchema } from '../contracts/common'
import type { Result, Unsubscribe } from '../contracts/common'
import { CalendarSnapshotSchema } from '../contracts/calendar'
import type {
  CalendarEvent,
  CalendarNavigateRequest,
  CalendarSnapshot
} from '../contracts/calendar'

export const CalendarSnapshotResponseSchema = resultSchema(CalendarSnapshotSchema)

/**
 * The calendar tab's API. The window asks to go somewhere and is told the state; the dates, the
 * time zone and the server calls are Main's. The ask resolves when that request has settled.
 */
export interface CalendarApi {
  navigate(request: CalendarNavigateRequest): Promise<Result<CalendarSnapshot>>
  getSnapshot(): Promise<Result<CalendarSnapshot>>
  subscribe(listener: (event: CalendarEvent) => void): Unsubscribe
}
