import type { ServerClient } from '../connection/server-client'
import { DeviceManagementApi } from './device-management-api'
import { DeviceManagementService, UnavailableDeviceManagement } from './device-management-service'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The client for server calls; null when there is no usable server. */
  api: ServerClient | null
  /** Signs this computer out the way the sign-out button does. */
  endLocalSession(): Promise<unknown>
}

/**
 * Exists only with a real server and a real login. The development sign-in stand-in
 * (JARVIS_DEV_AUTH=1) has no session the server would accept, so the tab says it is unavailable.
 */
export function createDeviceManagement({ isPackaged, env, api, endLocalSession }: Selection): {
  service: DeviceManagementService | null
  devices: DeviceManagementService | UnavailableDeviceManagement
} {
  if (!api || (!isPackaged && env.JARVIS_DEV_AUTH === '1'))
    return { service: null, devices: new UnavailableDeviceManagement() }
  const service = new DeviceManagementService({
    api: new DeviceManagementApi(api),
    now: Date.now,
    clock: api.clock,
    endLocalSession
  })
  return { service, devices: service }
}
