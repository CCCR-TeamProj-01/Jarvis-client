import type { IpcMain, WebContents } from 'electron'
import {
  CalendarCreateEventRequestSchema,
  CalendarDeleteEventRequestSchema,
  CalendarEventSchema,
  CalendarNavigateRequestSchema,
  CalendarUpdateEventRequestSchema
} from '../../shared/contracts/calendar'
import { CALENDAR_CHANNELS } from '../../shared/ipc/channels'
import {
  CalendarEditResponseSchema,
  CalendarSnapshotResponseSchema
} from '../../shared/ipc/calendar-api'
import type { CalendarPort } from '../calendar/calendar-service'
import { createCheckedIpc } from './checked-ipc'

interface CalendarIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getContents(): WebContents | null
  entryUrl: string
  calendar: CalendarPort
}

/** Only the main window may ask; the request, the answer and every pushed event are checked here. */
export function registerCalendarIpc({
  ipc,
  getContents,
  entryUrl,
  calendar
}: CalendarIpcOptions): () => void {
  const checked = createCheckedIpc({ ipc, getContents, entryUrl })
  const { handle } = checked

  handle(
    CALENDAR_CHANNELS.navigate,
    CalendarNavigateRequestSchema,
    CalendarSnapshotResponseSchema,
    (request) => calendar.navigate(request.navigation)
  )
  handle(CALENDAR_CHANNELS.snapshot, null, CalendarSnapshotResponseSchema, () => ({
    ok: true,
    value: calendar.getSnapshot()
  }))
  handle(
    CALENDAR_CHANNELS.create,
    CalendarCreateEventRequestSchema,
    CalendarEditResponseSchema,
    (request) => calendar.createEvent(request.draft)
  )
  handle(
    CALENDAR_CHANNELS.update,
    CalendarUpdateEventRequestSchema,
    CalendarEditResponseSchema,
    (request) => calendar.updateEvent(request.eventId, request.draft)
  )
  handle(
    CALENDAR_CHANNELS.delete,
    CalendarDeleteEventRequestSchema,
    CalendarEditResponseSchema,
    (request) => calendar.deleteEvent(request.eventId)
  )
  checked.forward(CALENDAR_CHANNELS.event, CalendarEventSchema, (listener) =>
    calendar.subscribe(listener)
  )
  return checked.dispose
}
