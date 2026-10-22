import { app, net } from 'electron'
import { BUNDLED_SERVER_URL } from './bundled-server-url'
import { createServerClient } from './create-server-client'
import type { ServerClientResolution } from './create-server-client'

/**
 * Production wiring. Electron's `net.fetch` goes through the system proxy and certificate store,
 * which a plain Node fetch would not. Tests build a client with a fake fetch instead.
 */
export function createDefaultServerClient(
  accessToken: () => string | null | Promise<string | null>,
  renewAccessToken?: () => Promise<boolean>
): ServerClientResolution {
  return createServerClient({
    isPackaged: app.isPackaged,
    env: process.env,
    bundledUrl: BUNDLED_SERVER_URL,
    fetch: (input, init) => net.fetch(input, init),
    accessToken,
    ...(renewAccessToken ? { renewAccessToken } : {})
  })
}
