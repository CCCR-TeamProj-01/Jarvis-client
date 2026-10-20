import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import {
  SensorAcquireRequestSchema,
  SensorLeaseSchema,
  SensorSnapshotSchema
} from '../../shared/contracts/sensors'
import type {
  PermissionState,
  SensorAcquireRequest,
  SensorDevice,
  SensorEvent,
  SensorKind,
  SensorLease,
  SensorReleaseResult,
  SensorSnapshot
} from '../../shared/contracts/sensors'
import type { LocalExecutionOptions, MonotonicClock } from '../ports'
import type { MediaPermissionPort, SensorGate, SensorHardwarePort } from './hardware'
import type { SensorPort } from './ports'

const KINDS: readonly SensorKind[] = ['camera', 'microphone']

interface SensorManagerOptions {
  hardware: SensorHardwarePort
  permissions: MediaPermissionPort
  gate: SensorGate
  clock: MonotonicClock
  createId(): string
}

/** `open` is the hardware state; the published state adds whether any lease is attached yet. */
type Status = 'idle' | 'starting' | 'open' | 'stopping' | 'unavailable' | 'error'

interface KindState {
  status: Status
  permission: PermissionState
  deviceId?: string
  streamId?: string
  leases: Map<string, SensorLease>
  /** The start shared by every acquire that arrives while the device is opening. */
  starting: Promise<Result<void>> | null
  stopping: Promise<void> | null
  /** Acquires still waiting on `starting`; the device is closed if none of them keeps a lease. */
  waiters: number
  /** Advances whenever the stream is torn down, so an in-flight start can tell it is stale. */
  epoch: number
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Owns device, permission and lease state for camera and microphone. The first lease opens the
 * device, later leases share it, and the last release closes it. Leases are revoked when the
 * stream dies, the gate closes (sign-out, pause) or the manager is disposed.
 */
export class SensorManager implements SensorPort {
  private readonly kinds = new Map<SensorKind, KindState>()
  private readonly listeners = new Set<(event: SensorEvent) => void>()
  private readonly published = new Map<SensorKind, string>()
  private readonly releaseHardware: Unsubscribe
  private disposed = false

  constructor(private readonly options: SensorManagerOptions) {
    for (const kind of KINDS)
      this.kinds.set(kind, {
        status: 'idle',
        permission: options.permissions.status(kind),
        leases: new Map(),
        starting: null,
        stopping: null,
        waiters: 0,
        epoch: 0
      })
    this.releaseHardware = options.hardware.subscribe((event) => {
      if (this.disposed) return
      if (event.type === 'devices_changed') this.onDevicesChanged(event.kind, event.devices)
      else void this.onStreamEnded(event.kind, event.streamId, event.error)
    })
  }

  getSnapshot(kind: SensorKind): SensorSnapshot {
    const state = this.state(kind)
    const attached = state.leases.size > 0
    return SensorSnapshotSchema.parse({
      kind,
      permission: state.permission,
      state: state.status === 'open' ? (attached ? 'active' : 'starting') : state.status,
      ...(state.status === 'open' || state.status === 'stopping' || state.status === 'starting'
        ? state.deviceId
          ? { deviceId: state.deviceId }
          : {}
        : {}),
      leaseCount: state.leases.size
    })
  }

  /** True while Main itself is opening or holding this sensor; the permission policy relies on it. */
  permits(kind: SensorKind): boolean {
    const { status } = this.state(kind)
    return status === 'starting' || status === 'open'
  }

  getSnapshots(): SensorSnapshot[] {
    return KINDS.map((kind) => this.getSnapshot(kind))
  }

  subscribe(listener: (event: SensorEvent) => void): Unsubscribe {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async listDevices(kind: SensorKind): Promise<Result<SensorDevice[]>> {
    const blocked = this.blocked()
    if (blocked) return blocked
    return this.options.hardware.listDevices(kind)
  }

  async acquire(
    request: SensorAcquireRequest,
    options?: LocalExecutionOptions
  ): Promise<Result<SensorLease>> {
    const parsed = SensorAcquireRequestSchema.safeParse(request)
    if (!parsed.success) return failure('invalid_input', '센서 요청 형식이 올바르지 않습니다.')
    const interrupted = this.interrupted(options)
    if (interrupted) return interrupted
    const blocked = this.blocked()
    if (blocked) return blocked

    const { kind, owner, generation, deviceId } = parsed.data
    const state = this.state(kind)

    // Wait for a teardown in progress; the device must be released before it is opened again.
    while (state.stopping) {
      await state.stopping
      const again = this.interrupted(options) ?? this.blocked()
      if (again) return again
    }

    state.waiters += 1
    let opened: Result<void>
    try {
      if (state.status === 'open') opened = { ok: true, value: undefined }
      else {
        if (!state.starting) {
          const starting = this.start(kind, deviceId, options)
          state.starting = starting
          void starting.finally(() => {
            if (state.starting === starting) state.starting = null
          })
        }
        opened = await state.starting
      }
    } finally {
      state.waiters -= 1
    }

    const settle = (result: Result<SensorLease>): Result<SensorLease> => {
      this.closeIfUnused(kind)
      return result
    }
    if (!opened.ok) return settle(opened)
    // The gate may have closed, or the stream died, while this acquire was waiting.
    const after = this.interrupted(options) ?? this.blocked()
    if (after) return settle(after)
    if (state.status !== 'open')
      return settle(failure('device_unavailable', '센서를 사용할 수 없습니다.'))
    if (deviceId !== undefined && deviceId !== state.deviceId)
      return settle(failure('conflict', '다른 기능이 이미 다른 장치를 사용 중입니다.'))

    const lease = SensorLeaseSchema.parse({
      kind,
      owner,
      generation,
      leaseId: this.options.createId(),
      deviceId: state.deviceId
    })
    state.leases.set(lease.leaseId, lease)
    this.publish(kind)
    return { ok: true, value: lease }
  }

  async release(leaseId: string): Promise<Result<SensorReleaseResult>> {
    for (const kind of KINDS) {
      const state = this.state(kind)
      if (!state.leases.delete(leaseId)) continue
      this.publish(kind)
      this.closeIfUnused(kind)
      await state.stopping
      return { ok: true, value: { status: 'released' } }
    }
    return { ok: true, value: { status: 'already_released' } }
  }

  /**
   * Revoke every lease and release the hardware. Used when authentication changes or recognition
   * is paused; it never waits for any consumer to cooperate.
   */
  async revokeAll(error: ClientError): Promise<void> {
    await Promise.all(KINDS.map((kind) => this.teardown(kind, error)))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    await this.revokeAll({ code: 'cancelled', message: '센서를 종료했습니다.' })
    this.disposed = true
    this.releaseHardware()
    this.listeners.clear()
  }

  // --- start -----------------------------------------------------------------------------------

  private async start(
    kind: SensorKind,
    requestedDeviceId: string | undefined,
    options?: LocalExecutionOptions
  ): Promise<Result<void>> {
    const state = this.state(kind)
    const epoch = state.epoch
    state.status = 'starting'
    this.publish(kind)
    const abandon = (result: Result<never>, status: Status = 'idle'): Result<never> => {
      if (state.epoch === epoch) {
        state.status = status
        this.publish(kind)
      }
      return result
    }

    let permission = this.options.permissions.status(kind)
    if (permission === 'not_determined') {
      this.setPermission(kind, permission)
      permission = await this.options.permissions.request(kind)
    }
    this.setPermission(kind, permission)
    if (permission !== 'granted')
      return abandon(
        failure(
          permission === 'unsupported' ? 'unsupported' : 'permission_denied',
          permission === 'unsupported'
            ? '이 기기에서는 해당 센서를 사용할 수 없습니다.'
            : '카메라·마이크 권한이 필요합니다. 시스템 설정에서 권한을 허용해 주세요.'
        ),
        'unavailable'
      )

    const devices = await this.options.hardware.listDevices(kind, options)
    if (!devices.ok) return abandon(devices, 'error')
    const device =
      requestedDeviceId === undefined
        ? devices.value[0]
        : devices.value.find((candidate) => candidate.deviceId === requestedDeviceId)
    if (!device)
      return abandon(
        failure(
          'device_unavailable',
          requestedDeviceId === undefined
            ? '사용할 수 있는 장치가 없습니다.'
            : '선택한 장치를 찾을 수 없습니다.'
        ),
        'unavailable'
      )
    if (state.epoch !== epoch) return failure('cancelled', '센서 시작이 취소되었습니다.')

    const streamId = this.options.createId()
    state.streamId = streamId
    state.deviceId = device.deviceId
    const opened = await this.options.hardware.open(
      kind,
      { streamId, deviceId: device.deviceId },
      options
    )
    if (state.epoch !== epoch) {
      // Torn down while opening: the new stream must not outlive the request that wanted it.
      void this.options.hardware.close(kind, streamId)
      return failure('cancelled', '센서 시작이 취소되었습니다.')
    }
    if (!opened.ok) {
      if (opened.error.code === 'permission_denied') this.setPermission(kind, 'denied')
      state.streamId = undefined
      state.deviceId = undefined
      return abandon(opened, opened.error.code === 'device_unavailable' ? 'unavailable' : 'error')
    }
    state.status = 'open'
    this.publish(kind)
    return { ok: true, value: undefined }
  }

  // --- stop ------------------------------------------------------------------------------------

  /** Close the device when nothing holds or is about to hold a lease. */
  private closeIfUnused(kind: SensorKind): void {
    const state = this.state(kind)
    if (state.status !== 'open' || state.leases.size > 0 || state.waiters > 0) return
    state.epoch += 1
    void this.close(kind)
  }

  private close(
    kind: SensorKind,
    finalStatus: 'idle' | 'unavailable' | 'error' = 'idle'
  ): Promise<void> {
    const state = this.state(kind)
    if (state.stopping) return state.stopping
    const { streamId } = state
    state.status = 'stopping'
    state.starting = null
    this.publish(kind)
    const finish = async (): Promise<void> => {
      const closed = streamId ? await this.options.hardware.close(kind, streamId) : null
      state.streamId = undefined
      state.deviceId = undefined
      state.status = closed && !closed.ok ? 'error' : finalStatus
      state.stopping = null
      this.publish(kind)
    }
    state.stopping = finish()
    return state.stopping
  }

  /** Revoke the kind's leases with `error`, invalidate any start in flight and release hardware. */
  private async teardown(kind: SensorKind, error: ClientError): Promise<void> {
    const state = this.state(kind)
    const revoked = [...state.leases.values()]
    state.leases.clear()
    state.epoch += 1
    const wasStarting = state.status === 'starting'
    state.starting = null
    // Consumers learn about the revocation first; hardware release follows without blocking them.
    for (const lease of revoked) this.emit({ type: 'sensor.lease_revoked', lease, error })
    if (state.status === 'open' || state.status === 'stopping') await this.close(kind)
    else if (wasStarting) {
      // The in-flight start notices the new epoch and closes anything it opened.
      state.status = 'idle'
      state.streamId = undefined
      state.deviceId = undefined
      this.publish(kind)
    } else this.publish(kind)
  }

  // --- hardware events -------------------------------------------------------------------------

  private async onStreamEnded(kind: SensorKind, streamId: string, error: ClientError) {
    const state = this.state(kind)
    // Events about an earlier stream, or one we are already closing, change nothing.
    if (state.streamId !== streamId || state.status !== 'open') return
    const revoked = [...state.leases.values()]
    state.leases.clear()
    state.epoch += 1
    state.starting = null
    for (const lease of revoked) this.emit({ type: 'sensor.lease_revoked', lease, error })
    // The device is already gone; closing only confirms the Media Renderer dropped its handle.
    const closing = this.close(kind, error.code === 'device_unavailable' ? 'unavailable' : 'error')
    // Permission changes only once the sensor is no longer "active", which requires `granted`.
    if (error.code === 'permission_denied') this.setPermission(kind, 'denied')
    await closing
  }

  private onDevicesChanged(kind: SensorKind, devices: SensorDevice[]): void {
    this.emit({ type: 'sensor.devices_changed', devices })
    const state = this.state(kind)
    if (
      state.status === 'open' &&
      state.streamId &&
      state.deviceId &&
      !devices.some((device) => device.deviceId === state.deviceId)
    )
      void this.onStreamEnded(kind, state.streamId, {
        code: 'device_unavailable',
        message: '사용 중인 장치가 분리되었습니다.'
      })
  }

  // --- helpers ---------------------------------------------------------------------------------

  private setPermission(kind: SensorKind, permission: PermissionState): void {
    const state = this.state(kind)
    if (state.permission === permission) return
    state.permission = permission
    this.publish(kind)
  }

  private blocked(): Result<never> | null {
    if (this.disposed) return failure('cancelled', '센서가 종료되었습니다.')
    const gate = this.options.gate.check()
    return gate.ok ? null : gate
  }

  private interrupted(options?: LocalExecutionOptions): Result<never> | null {
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    if (options?.deadlineMs !== undefined) {
      if (!Number.isFinite(options.deadlineMs))
        return failure('invalid_input', '요청 기한이 올바르지 않습니다.')
      if (options.deadlineMs <= this.options.clock.now())
        return failure('expired', '요청 시간이 지났습니다.')
    }
    return null
  }

  private state(kind: SensorKind): KindState {
    return this.kinds.get(kind)!
  }

  /** Emit `sensor.state_changed` only when the visible snapshot actually changed. */
  private publish(kind: SensorKind): void {
    const snapshot = this.getSnapshot(kind)
    const key = JSON.stringify(snapshot)
    if (this.published.get(kind) === key) return
    this.published.set(kind, key)
    this.emit({ type: 'sensor.state_changed', snapshot })
  }

  private emit(event: SensorEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(event))
      } catch {
        /* Observers cannot prevent state transitions or other observers. */
      }
    }
  }
}
