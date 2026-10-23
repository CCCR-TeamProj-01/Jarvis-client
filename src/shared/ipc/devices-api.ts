import { resultSchema } from '../contracts/common'
import type { Result, Unsubscribe } from '../contracts/common'
import { DeviceManagementSnapshotSchema } from '../contracts/devices'
import type {
  DeviceCommandRequest,
  DeviceManagementEvent,
  DeviceManagementSnapshot
} from '../contracts/devices'

export const DeviceSnapshotResponseSchema = resultSchema(DeviceManagementSnapshotSchema)

/**
 * The devices and allowed-apps API. The window asks for one of a few actions and is told the
 * state; the server calls and the local sign-out that follows signing out everywhere are Main's.
 * An action returns when the server has answered, and every change also comes as a state event.
 */
export interface DevicesApi {
  command(request: DeviceCommandRequest): Promise<Result<DeviceManagementSnapshot>>
  getSnapshot(): Promise<Result<DeviceManagementSnapshot>>
  subscribe(listener: (event: DeviceManagementEvent) => void): Unsubscribe
}
