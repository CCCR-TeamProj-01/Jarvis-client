import type { Result } from '../../shared/contracts/common'
import type { ServerClient } from '../connection/server-client'
import { DevAuthGateway } from './dev-auth-gateway'
import type { DeviceInfo } from './device-info'
import type { AuthGatewayPort } from './ports'
import { ServerAuthGateway } from './server-auth-gateway'
import type { AccessTokenHolder } from './server-session'
import { unavailableAuthGateway } from './unavailable-auth-gateway'

/** A usable server: present only when an address is configured and valid. */
export interface ServerAuthConnection {
  client: ServerClient
  tokens: AccessTokenHolder
  device(): Result<DeviceInfo>
}

interface GatewaySelection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  nowUnixMs(): number
  server?: ServerAuthConnection | null
}

/**
 * The development stand-in needs both an unpackaged app and an explicit JARVIS_DEV_AUTH=1, and it
 * wins over a configured server so that choosing it is always a deliberate act. Otherwise a
 * configured server is used, and with neither every request fails as unreachable.
 */
export function createAuthGateway({
  isPackaged,
  env,
  nowUnixMs,
  server = null
}: GatewaySelection): AuthGatewayPort {
  if (!isPackaged && env.JARVIS_DEV_AUTH === '1')
    return new DevAuthGateway({ nowUnixMs, latencyMs: 250 })
  if (server)
    return new ServerAuthGateway({
      client: server.client,
      tokens: server.tokens,
      device: server.device,
      nowUnixMs
    })
  return unavailableAuthGateway
}
