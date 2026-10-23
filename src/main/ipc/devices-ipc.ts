import type { IpcMain, WebContents } from 'electron'
import {
  DeviceCommandRequestSchema,
  DeviceManagementEventSchema
} from '../../shared/contracts/devices'
import { DEVICE_CHANNELS } from '../../shared/ipc/channels'
import { DeviceSnapshotResponseSchema } from '../../shared/ipc/devices-api'
import type { DeviceManagementPort } from '../devices/device-management-service'
import { createCheckedIpc } from './checked-ipc'

interface DevicesIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getContents(): WebContents | null
  entryUrl: string
  devices: DeviceManagementPort
}

/** Only the main window may ask; the request, the answer and every pushed event are checked here. */
export function registerDevicesIpc({
  ipc,
  getContents,
  entryUrl,
  devices
}: DevicesIpcOptions): () => void {
  const checked = createCheckedIpc({ ipc, getContents, entryUrl })
  checked.handle(
    DEVICE_CHANNELS.command,
    DeviceCommandRequestSchema,
    DeviceSnapshotResponseSchema,
    (request) => devices.command(request)
  )
  checked.handle(DEVICE_CHANNELS.snapshot, null, DeviceSnapshotResponseSchema, () => ({
    ok: true,
    value: devices.getSnapshot()
  }))
  checked.forward(DEVICE_CHANNELS.event, DeviceManagementEventSchema, (listener) =>
    devices.subscribe(listener)
  )
  return checked.dispose
}
