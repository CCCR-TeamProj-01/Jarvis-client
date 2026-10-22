import type { ServerClient } from '../connection/server-client'
import { CalendarApi } from './calendar-api'
import { CalendarService, UnavailableCalendar } from './calendar-service'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The client for server calls; null when there is no usable server. */
  api: ServerClient | null
}

/**
 * Reads the server while someone is signed in. Without a server, or with the development sign-in
 * stand-in (JARVIS_DEV_AUTH=1) whose session the server would not accept, the tab only says it
 * cannot show a calendar.
 */
export function createCalendar({ isPackaged, env, api }: Selection): {
  service: CalendarService | null
  calendar: CalendarService | UnavailableCalendar
} {
  if (!api || (!isPackaged && env.JARVIS_DEV_AUTH === '1'))
    return { service: null, calendar: new UnavailableCalendar() }
  const service = new CalendarService({ api: new CalendarApi(api), now: Date.now })
  return { service, calendar: service }
}
