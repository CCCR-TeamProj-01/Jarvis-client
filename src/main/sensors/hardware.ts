import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import type { PermissionState, SensorDevice, SensorKind } from '../../shared/contracts/sensors'
import type { LocalExecutionOptions } from '../ports'

export type SensorHardwareEvent =
  /** The set of devices of one kind changed (hot-plug). */
  | { type: 'devices_changed'; kind: SensorKind; devices: SensorDevice[] }
  /** An open stream stopped without being asked to: device removed, permission revoked, or error. */
  | { type: 'stream_ended'; kind: SensorKind; streamId: string; error: ClientError }

/**
 * The capture side of sensors. MediaStreams stay in the Media Renderer; Main only holds ids.
 * `streamId` is minted by SensorManager and identifies one open stream so that late events about
 * a previous stream are ignored.
 */
export interface SensorHardwarePort {
  listDevices(kind: SensorKind, options?: LocalExecutionOptions): Promise<Result<SensorDevice[]>>
  open(
    kind: SensorKind,
    request: { streamId: string; deviceId: string },
    options?: LocalExecutionOptions
  ): Promise<Result<void>>
  /** Idempotent. Resolves once the device is released. */
  close(kind: SensorKind, streamId: string): Promise<Result<void>>
  subscribe(listener: (event: SensorHardwareEvent) => void): Unsubscribe
}

/** OS-level camera/microphone permission. Unsupported platforms report `granted`. */
export interface MediaPermissionPort {
  status(kind: SensorKind): PermissionState
  /** Asks the OS when the state is `not_determined`; resolves with the resulting state. */
  request(kind: SensorKind): Promise<PermissionState>
}

/** Authentication and pause policy, evaluated by Main before any sensor starts. */
export interface SensorGate {
  check(): Result<void>
}
