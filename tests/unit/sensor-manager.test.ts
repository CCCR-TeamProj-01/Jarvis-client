import { describe, expect, it } from 'vitest'
import type {
  MediaPermissionPort,
  SensorGate,
  SensorHardwareEvent,
  SensorHardwarePort
} from '../../src/main/sensors/hardware'
import { SensorManager } from '../../src/main/sensors/sensor-manager'
import type { ClientError, Result } from '../../src/shared/contracts/common'
import type {
  PermissionState,
  SensorDevice,
  SensorEvent,
  SensorKind
} from '../../src/shared/contracts/sensors'

const generation = { sessionId: 'feature-1', revision: 1 }
const camera = (deviceId?: string) =>
  ({ kind: 'camera', owner: 'gesture_control', generation, deviceId }) as const
const microphone = (owner: 'voice_wake' | 'speech_session' = 'voice_wake', deviceId?: string) =>
  ({ kind: 'microphone', owner, generation, deviceId }) as const

const cam0: SensorDevice = { kind: 'camera', deviceId: 'cam-0', label: 'Built-in' }
const cam1: SensorDevice = { kind: 'camera', deviceId: 'cam-1', label: 'USB' }
const mic0: SensorDevice = { kind: 'microphone', deviceId: 'mic-0' }

class FakeHardware implements SensorHardwarePort {
  devices: Record<SensorKind, SensorDevice[]> = { camera: [cam0, cam1], microphone: [mic0] }
  openStreams: string[] = []
  closed: string[] = []
  opens: { kind: SensorKind; streamId: string; deviceId: string }[] = []
  openError: ClientError | null = null
  listError: ClientError | null = null
  /** Hold the next open() until released. */
  holdOpen: Promise<void> | null = null
  holdClose: Promise<void> | null = null
  private listener: ((event: SensorHardwareEvent) => void) | null = null

  async listDevices(kind: SensorKind): Promise<Result<SensorDevice[]>> {
    if (this.listError) return { ok: false, error: this.listError }
    return { ok: true, value: [...this.devices[kind]] }
  }
  async open(kind: SensorKind, request: { streamId: string; deviceId: string }) {
    this.opens.push({ kind, ...request })
    if (this.holdOpen) await this.holdOpen
    if (this.openError) return { ok: false, error: this.openError } as const
    this.openStreams.push(request.streamId)
    return { ok: true, value: undefined } as const
  }
  async close(_kind: SensorKind, streamId: string) {
    if (this.holdClose) await this.holdClose
    this.closed.push(streamId)
    this.openStreams = this.openStreams.filter((id) => id !== streamId)
    return { ok: true, value: undefined } as const
  }
  subscribe(listener: (event: SensorHardwareEvent) => void) {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
  emit(event: SensorHardwareEvent) {
    this.listener?.(event)
  }
}

function setup(permission: PermissionState = 'granted') {
  const hardware = new FakeHardware()
  let nowMs = 1_000
  let gateError: ClientError | null = null
  let permissionNow = permission
  let requested: PermissionState = 'granted'
  const permissions: MediaPermissionPort = {
    status: () => permissionNow,
    request: async () => {
      permissionNow = requested
      return requested
    }
  }
  const gate: SensorGate = {
    check: () => (gateError ? { ok: false, error: gateError } : { ok: true, value: undefined })
  }
  let id = 0
  const manager = new SensorManager({
    hardware,
    permissions,
    gate,
    clock: { now: () => nowMs },
    createId: () => `id-${++id}`
  })
  const events: SensorEvent[] = []
  manager.subscribe((event) => events.push(event))
  return {
    manager,
    hardware,
    events,
    closeGate: (error: ClientError) => {
      gateError = error
    },
    openGate: () => {
      gateError = null
    },
    setRequested: (state: PermissionState) => {
      requested = state
    },
    /** The user changed the permission in the OS settings. */
    setSystemPermission: (state: PermissionState) => {
      permissionNow = state
    },
    tick: (ms: number) => {
      nowMs += ms
    }
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const states = (events: SensorEvent[], kind: SensorKind) =>
  events.flatMap((event) =>
    event.type === 'sensor.state_changed' && event.snapshot.kind === kind
      ? [event.snapshot.state]
      : []
  )
const revoked = (events: SensorEvent[]) =>
  events.flatMap((event) => (event.type === 'sensor.lease_revoked' ? [event] : []))
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.message}`)
  return result.value
}

describe('lease lifecycle', () => {
  it('opens on the first lease, shares the device and closes after the last release', async () => {
    const { manager, hardware, events } = setup()
    const first = unwrap(await manager.acquire(microphone('voice_wake')))
    const second = unwrap(await manager.acquire(microphone('speech_session')))
    expect(hardware.opens).toHaveLength(1)
    expect(second.deviceId).toBe(first.deviceId)
    expect(manager.getSnapshot('microphone')).toMatchObject({
      state: 'active',
      permission: 'granted',
      deviceId: 'mic-0',
      leaseCount: 2
    })

    await manager.release(first.leaseId)
    expect(hardware.closed).toEqual([])
    expect(manager.getSnapshot('microphone')).toMatchObject({ state: 'active', leaseCount: 1 })

    await manager.release(second.leaseId)
    expect(hardware.closed).toHaveLength(1)
    expect(manager.getSnapshot('microphone')).toMatchObject({ state: 'idle', leaseCount: 0 })
    expect(states(events, 'microphone')).toEqual(
      expect.arrayContaining(['starting', 'active', 'stopping', 'idle'])
    )
  })

  it('treats release as idempotent', async () => {
    const { manager, hardware } = setup()
    const lease = unwrap(await manager.acquire(camera()))
    expect(await manager.release(lease.leaseId)).toEqual({
      ok: true,
      value: { status: 'released' }
    })
    expect(await manager.release(lease.leaseId)).toEqual({
      ok: true,
      value: { status: 'already_released' }
    })
    expect(await manager.release('never-issued')).toEqual({
      ok: true,
      value: { status: 'already_released' }
    })
    expect(hardware.closed).toHaveLength(1)
  })

  it('keeps camera and microphone independent', async () => {
    const { manager } = setup()
    const cam = unwrap(await manager.acquire(camera()))
    unwrap(await manager.acquire(microphone()))
    await manager.release(cam.leaseId)
    expect(manager.getSnapshot('camera').state).toBe('idle')
    expect(manager.getSnapshot('microphone').state).toBe('active')
  })

  it('shares one start between concurrent acquires', async () => {
    const { manager, hardware } = setup()
    let release: () => void = () => undefined
    hardware.holdOpen = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = manager.acquire(microphone('voice_wake'))
    const second = manager.acquire(microphone('speech_session'))
    await flush()
    expect(manager.getSnapshot('microphone').state).toBe('starting')
    release()
    const [a, b] = [unwrap(await first), unwrap(await second)]
    expect(hardware.opens).toHaveLength(1)
    expect(a.leaseId).not.toBe(b.leaseId)
    expect(manager.getSnapshot('microphone').leaseCount).toBe(2)
  })

  it('uses the requested device and rejects a conflicting one while in use', async () => {
    const { manager } = setup()
    const lease = unwrap(await manager.acquire(camera('cam-1')))
    expect(lease.deviceId).toBe('cam-1')
    expect(await manager.acquire(camera('cam-0'))).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    expect(unwrap(await manager.acquire(camera())).deviceId).toBe('cam-1')
  })

  it('selects the first device by default and reports a missing requested device', async () => {
    const { manager } = setup()
    expect(unwrap(await manager.acquire(camera())).deviceId).toBe('cam-0')
    const other = setup()
    expect(await other.manager.acquire(camera('gone'))).toMatchObject({
      ok: false,
      error: { code: 'device_unavailable' }
    })
    expect(other.manager.getSnapshot('camera').state).toBe('unavailable')
  })

  it('waits for a teardown before reopening the device', async () => {
    const { manager, hardware } = setup()
    const lease = unwrap(await manager.acquire(camera()))
    let finishClose: () => void = () => undefined
    hardware.holdClose = new Promise<void>((resolve) => {
      finishClose = resolve
    })
    const releasing = manager.release(lease.leaseId)
    await flush()
    expect(manager.getSnapshot('camera').state).toBe('stopping')
    const reopening = manager.acquire(camera())
    await flush()
    expect(hardware.opens).toHaveLength(1)
    hardware.holdClose = null
    finishClose()
    await releasing
    unwrap(await reopening)
    expect(hardware.opens).toHaveLength(2)
    expect(hardware.opens[0].streamId).not.toBe(hardware.opens[1].streamId)
  })
})

describe('permission and failures', () => {
  it('asks the OS when permission is undetermined and proceeds when granted', async () => {
    const { manager } = setup('not_determined')
    unwrap(await manager.acquire(camera()))
    expect(manager.getSnapshot('camera')).toMatchObject({ permission: 'granted', state: 'active' })
  })

  it.each([
    ['denied', 'permission_denied'],
    ['restricted', 'permission_denied'],
    ['unsupported', 'unsupported']
  ] as const)('does not start when permission is %s', async (permission, code) => {
    const { manager, hardware } = setup(permission)
    expect(await manager.acquire(camera())).toMatchObject({ ok: false, error: { code } })
    expect(hardware.opens).toHaveLength(0)
    expect(manager.getSnapshot('camera')).toMatchObject({ permission, state: 'unavailable' })
  })

  it('reports a refusal when the OS prompt is declined', async () => {
    const { manager, setRequested } = setup('not_determined')
    setRequested('denied')
    expect(await manager.acquire(microphone())).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' }
    })
    expect(manager.getSnapshot('microphone').permission).toBe('denied')
  })

  it('can start again after permission is granted later', async () => {
    const { manager, setRequested, setSystemPermission } = setup('not_determined')
    setRequested('denied')
    await manager.acquire(camera())
    setSystemPermission('granted')
    unwrap(await manager.acquire(camera()))
    expect(manager.getSnapshot('camera').permission).toBe('granted')
  })

  it('reports no devices as unavailable, not as a permission problem', async () => {
    const { manager, hardware } = setup()
    hardware.devices.camera = []
    expect(await manager.acquire(camera())).toMatchObject({
      ok: false,
      error: { code: 'device_unavailable' }
    })
    expect(manager.getSnapshot('camera')).toMatchObject({
      state: 'unavailable',
      permission: 'granted'
    })
  })

  it('marks the sensor errored when opening fails and allows a retry', async () => {
    const { manager, hardware } = setup()
    hardware.openError = { code: 'internal', message: '열지 못했습니다.' }
    expect(await manager.acquire(camera())).toMatchObject({
      ok: false,
      error: { code: 'internal' }
    })
    expect(manager.getSnapshot('camera')).toMatchObject({ state: 'error', leaseCount: 0 })
    hardware.openError = null
    unwrap(await manager.acquire(camera()))
    expect(manager.getSnapshot('camera').state).toBe('active')
  })

  it('records a permission refusal by the media layer', async () => {
    const { manager, hardware } = setup()
    hardware.openError = { code: 'permission_denied', message: '거부' }
    await manager.acquire(camera())
    expect(manager.getSnapshot('camera').permission).toBe('denied')
  })

  it('rejects malformed requests and mismatched owners', async () => {
    const { manager } = setup()
    expect(
      await manager.acquire({ kind: 'camera', owner: 'voice_wake', generation } as never)
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await manager.acquire({} as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
  })
})

describe('cancellation and deadlines', () => {
  it('refuses an already aborted or expired request without starting hardware', async () => {
    const { manager, hardware } = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await manager.acquire(camera(), { signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(await manager.acquire(camera(), { deadlineMs: 500 })).toMatchObject({
      ok: false,
      error: { code: 'expired' }
    })
    expect(await manager.acquire(camera(), { deadlineMs: Number.NaN })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    expect(hardware.opens).toHaveLength(0)
  })

  it('does not leave the device open when every waiter gives up', async () => {
    const { manager, hardware } = setup()
    let release: () => void = () => undefined
    hardware.holdOpen = new Promise<void>((resolve) => {
      release = resolve
    })
    const controller = new AbortController()
    const pending = manager.acquire(camera(), { signal: controller.signal })
    await flush()
    controller.abort()
    release()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    await flush()
    expect(hardware.closed).toHaveLength(1)
    expect(manager.getSnapshot('camera')).toMatchObject({ state: 'idle', leaseCount: 0 })
  })

  it('does not hand out a lease when the deadline passes during the start', async () => {
    const { manager, hardware, tick } = setup()
    let release: () => void = () => undefined
    hardware.holdOpen = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = manager.acquire(camera(), { deadlineMs: 1_100 })
    await flush()
    tick(500)
    release()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'expired' } })
    await flush()
    expect(manager.getSnapshot('camera').leaseCount).toBe(0)
    expect(hardware.closed).toHaveLength(1)
  })
})

describe('gate (authentication and pause)', () => {
  const signedOut: ClientError = {
    code: 'authentication_required',
    message: '로그인이 필요합니다.'
  }

  it('refuses leases and device listing while the gate is closed', async () => {
    const { manager, hardware, closeGate } = setup()
    closeGate(signedOut)
    expect(await manager.acquire(camera())).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(await manager.listDevices('camera')).toMatchObject({ ok: false })
    expect(hardware.opens).toHaveLength(0)
  })

  it('revokes every lease and releases hardware, telling each holder', async () => {
    const { manager, hardware, events } = setup()
    const cam = unwrap(await manager.acquire(camera()))
    const mic = unwrap(await manager.acquire(microphone()))
    const revokedError: ClientError = { code: 'authentication_required', message: '로그아웃' }
    await manager.revokeAll(revokedError)
    expect(hardware.openStreams).toEqual([])
    expect(manager.getSnapshot('camera')).toMatchObject({ state: 'idle', leaseCount: 0 })
    expect(manager.getSnapshot('microphone')).toMatchObject({ state: 'idle', leaseCount: 0 })
    expect(
      revoked(events)
        .map((event) => event.lease.leaseId)
        .sort()
    ).toEqual([cam.leaseId, mic.leaseId].sort())
    expect(revoked(events).every((event) => event.error.code === 'authentication_required')).toBe(
      true
    )
    // Releasing an already revoked lease is harmless.
    expect(await manager.release(cam.leaseId)).toMatchObject({
      ok: true,
      value: { status: 'already_released' }
    })
  })

  it('closes a stream whose start was still in flight when everything was revoked', async () => {
    const { manager, hardware } = setup()
    let release: () => void = () => undefined
    hardware.holdOpen = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = manager.acquire(camera())
    await flush()
    await manager.revokeAll({ code: 'cancelled', message: '일시 중지' })
    release()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    await flush()
    expect(hardware.openStreams).toEqual([])
    expect(hardware.closed).toHaveLength(1)
    expect(manager.getSnapshot('camera')).toMatchObject({ state: 'idle', leaseCount: 0 })
  })

  it('does not issue a lease if the gate closed while the device was opening', async () => {
    const { manager, hardware, closeGate } = setup()
    let release: () => void = () => undefined
    hardware.holdOpen = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = manager.acquire(camera())
    await flush()
    closeGate(signedOut)
    release()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'authentication_required' } })
    await flush()
    expect(hardware.openStreams).toEqual([])
  })
})

describe('hardware events', () => {
  it('revokes leases when the stream ends and records why', async () => {
    const { manager, hardware, events } = setup()
    const lease = unwrap(await manager.acquire(camera()))
    const streamId = hardware.opens[0].streamId
    hardware.emit({
      type: 'stream_ended',
      kind: 'camera',
      streamId,
      error: { code: 'device_unavailable', message: '분리됨' }
    })
    await flush()
    expect(revoked(events)).toMatchObject([
      { lease: { leaseId: lease.leaseId }, error: { code: 'device_unavailable' } }
    ])
    expect(manager.getSnapshot('camera')).toMatchObject({ state: 'unavailable', leaseCount: 0 })
    expect(hardware.closed).toContain(streamId)
  })

  it('records permission revocation and blocks until permission returns', async () => {
    const { manager, hardware } = setup()
    unwrap(await manager.acquire(microphone()))
    hardware.emit({
      type: 'stream_ended',
      kind: 'microphone',
      streamId: hardware.opens[0].streamId,
      error: { code: 'permission_denied', message: '권한 철회' }
    })
    await flush()
    expect(manager.getSnapshot('microphone')).toMatchObject({ permission: 'denied', leaseCount: 0 })
  })

  it('ignores events about a stream that is no longer current', async () => {
    const { manager, hardware, events } = setup()
    unwrap(await manager.acquire(camera()))
    hardware.emit({
      type: 'stream_ended',
      kind: 'camera',
      streamId: 'some-older-stream',
      error: { code: 'device_unavailable', message: '늦은 알림' }
    })
    await flush()
    expect(revoked(events)).toHaveLength(0)
    expect(manager.getSnapshot('camera').state).toBe('active')
  })

  it('treats the active device disappearing from the device list as removal', async () => {
    const { manager, hardware, events } = setup()
    unwrap(await manager.acquire(camera('cam-1')))
    hardware.emit({ type: 'devices_changed', kind: 'camera', devices: [cam0] })
    await flush()
    expect(events.some((event) => event.type === 'sensor.devices_changed')).toBe(true)
    expect(revoked(events)).toHaveLength(1)
    expect(manager.getSnapshot('camera').leaseCount).toBe(0)
  })

  it('keeps leases when an unrelated device is added or removed', async () => {
    const { manager, hardware, events } = setup()
    unwrap(await manager.acquire(camera('cam-0')))
    hardware.emit({ type: 'devices_changed', kind: 'camera', devices: [cam0] })
    await flush()
    expect(revoked(events)).toHaveLength(0)
    expect(manager.getSnapshot('camera').state).toBe('active')
  })
})

describe('dispose', () => {
  it('releases hardware and stops publishing', async () => {
    const { manager, hardware, events } = setup()
    unwrap(await manager.acquire(camera()))
    await manager.dispose()
    expect(hardware.openStreams).toEqual([])
    const count = events.length
    expect(await manager.acquire(camera())).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(events.length).toBe(count)
  })
})

describe('snapshots', () => {
  it('never reports active without permission, a device and a lease', async () => {
    const { manager, events } = setup()
    unwrap(await manager.acquire(camera()))
    const active = events.flatMap((event) =>
      event.type === 'sensor.state_changed' && event.snapshot.state === 'active'
        ? [event.snapshot]
        : []
    )
    expect(active.length).toBeGreaterThan(0)
    expect(
      active.every(
        (snapshot) =>
          snapshot.permission === 'granted' &&
          snapshot.leaseCount > 0 &&
          snapshot.deviceId !== undefined
      )
    ).toBe(true)
  })

  it('publishes only real changes', async () => {
    const { manager, events } = setup()
    const lease = unwrap(await manager.acquire(camera()))
    const before = events.length
    await manager.release('unknown')
    expect(events.length).toBe(before)
    await manager.release(lease.leaseId)
  })
})
