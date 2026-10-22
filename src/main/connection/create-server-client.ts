import { resolveServerConfig } from './server-config'
import { ServerClient } from './server-client'
import type { FetchLike } from './server-client'

export type ServerClientResolution =
  | { status: 'unconfigured' }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; client: ServerClient }

interface CreateServerClientOptions {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  fetch: FetchLike
  accessToken(): string | null
}

/** Anything but `ready` means there is no server to talk to, and callers report it as unreachable. */
export function createServerClient(options: CreateServerClientOptions): ServerClientResolution {
  const config = resolveServerConfig(options)
  if (config.status !== 'ready') return config
  return {
    status: 'ready',
    client: new ServerClient({
      baseUrl: config.baseUrl,
      fetch: options.fetch,
      accessToken: options.accessToken
    })
  }
}
