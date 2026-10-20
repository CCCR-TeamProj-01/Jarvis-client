import { DevAuthGateway } from './dev-auth-gateway'
import type { AuthGatewayPort } from './ports'
import { unavailableAuthGateway } from './unavailable-auth-gateway'

interface GatewaySelection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  nowUnixMs(): number
}

/** The development gateway needs both an unpackaged app and an explicit JARVIS_DEV_AUTH=1. */
export function createAuthGateway({
  isPackaged,
  env,
  nowUnixMs
}: GatewaySelection): AuthGatewayPort {
  if (!isPackaged && env.JARVIS_DEV_AUTH === '1')
    return new DevAuthGateway({ nowUnixMs, latencyMs: 250 })
  return unavailableAuthGateway
}
