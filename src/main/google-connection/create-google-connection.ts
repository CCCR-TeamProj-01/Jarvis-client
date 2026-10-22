import type { ServerClient } from '../connection/server-client'
import { sleep } from '../sleep'
import { GoogleConnectionApi } from './google-connection-api'
import { GoogleConnectionService, UnavailableGoogleConnection } from './google-connection-service'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The client for server calls; null when there is no usable server. */
  api: ServerClient | null
  /** Hands an address to the user's browser. */
  openExternal(url: string): Promise<void>
  /** The calendar may now show something different. */
  onCalendarChanged(): void
}

/**
 * Exists only with a real server and a real login. The development sign-in stand-in
 * (JARVIS_DEV_AUTH=1) has no session the server would accept, so the tab says it is unavailable.
 */
export function createGoogleConnection({
  isPackaged,
  env,
  api,
  openExternal,
  onCalendarChanged
}: Selection): {
  service: GoogleConnectionService | null
  connection: GoogleConnectionService | UnavailableGoogleConnection
} {
  if (!api || (!isPackaged && env.JARVIS_DEV_AUTH === '1'))
    return { service: null, connection: new UnavailableGoogleConnection() }
  const service = new GoogleConnectionService({
    api: new GoogleConnectionApi(api),
    now: Date.now,
    clock: api.clock,
    sleep,
    openConsent: async (url) => {
      try {
        await openExternal(url)
        return true
      } catch {
        return false
      }
    },
    onCalendarChanged
  })
  return { service, connection: service }
}
