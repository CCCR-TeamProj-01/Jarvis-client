import type { IpcMain, WebContents } from 'electron'
import { CalendarEventSchema, CalendarNavigateRequestSchema } from '../../shared/contracts/calendar'
import { CALENDAR_CHANNELS } from '../../shared/ipc/channels'
import { CalendarSnapshotResponseSchema } from '../../shared/ipc/calendar-api'
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
  ipc.handle(CALENDAR_CHANNELS.navigate, async (event, ...args: unknown[]) => {
    if (!isTrustedUiSender(event, getContents(), entryUrl)) return denied
    if (args.length !== 1) return invalid
    const request = CalendarNavigateRequestSchema.safeParse(args[0])
    if (!request.success) return invalid
    try {
      const response = CalendarSnapshotResponseSchema.safeParse(
        await calendar.navigate(request.data.navigation)
      )
      return response.success ? response.data : failed
    } catch {
      return failed
    }
  })
  ipc.handle(CALENDAR_CHANNELS.snapshot, (event, ...args: unknown[]) => {
    if (!isTrustedUiSender(event, getContents(), entryUrl)) return denied
    if (args.length !== 0) return invalid
    try {
      const response = CalendarSnapshotResponseSchema.safeParse({
        ok: true,
        value: calendar.getSnapshot()
      })
      return response.success ? response.data : failed
    } catch {
      return failed
    }
  })
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
    ipc.removeHandler(CALENDAR_CHANNELS.navigate)
    ipc.removeHandler(CALENDAR_CHANNELS.snapshot)
  }
}
