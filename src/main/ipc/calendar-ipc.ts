import type { IpcMain, WebContents } from 'electron'
import type { z } from 'zod'
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
import { isTrustedUiSender } from './ui-ipc'

interface CalendarIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getContents(): WebContents | null
  entryUrl: string
  calendar: CalendarPort
}

const denied = {
  ok: false,
  error: { code: 'permission_denied', message: '허용되지 않은 화면의 요청입니다.' }
} as const
const invalid = {
  ok: false,
  error: { code: 'invalid_input', message: '요청 형식이 올바르지 않습니다.' }
} as const
const failed = {
  ok: false,
  error: { code: 'internal', message: '요청을 처리하지 못했습니다.' }
} as const

/** Only the main window may ask; the request, the answer and every pushed event are checked here. */
export function registerCalendarIpc({
  ipc,
  getContents,
  entryUrl,
  calendar
}: CalendarIpcOptions): () => void {
  const channels: string[] = []

  /** One call: sender, argument count, request shape and answer shape are all checked. */
  function handle<Request, Response>(
    channel: string,
    requestSchema: z.ZodType<Request> | null,
    responseSchema: z.ZodType<Response>,
    run: (request: Request) => Promise<unknown> | unknown
  ): void {
    channels.push(channel)
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedUiSender(event, getContents(), entryUrl)) return denied
      let request: Request | undefined
      if (requestSchema) {
        if (args.length !== 1) return invalid
        const parsed = requestSchema.safeParse(args[0])
        if (!parsed.success) return invalid
        request = parsed.data
      } else if (args.length !== 0) return invalid
      try {
        const response = responseSchema.safeParse(await run(request as Request))
        return response.success ? response.data : failed
      } catch {
        return failed
      }
    })
  }

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

  const unsubscribe = calendar.subscribe((event) => {
    const parsed = CalendarEventSchema.safeParse(event)
    if (!parsed.success) return
    const contents = getContents()
    if (!contents || contents.isDestroyed()) return
    try {
      if (contents.mainFrame.url === entryUrl) contents.send(CALENDAR_CHANNELS.event, parsed.data)
    } catch {
      /* The frame may disappear while its window closes or reloads. */
    }
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    for (const channel of channels) ipc.removeHandler(channel)
  }
}
