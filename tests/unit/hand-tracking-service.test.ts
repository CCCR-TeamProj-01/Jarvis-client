import { describe, expect, it } from 'vitest'
import { HandTrackingService } from '../../src/main/gesture/hand-tracking'
import type { ClientError, Generation, Result } from '../../src/shared/contracts/common'
import type { HandTrackingEvent, HandTrackingFrame } from '../../src/shared/contracts/gesture'
import type { SensorEvent, SensorLease } from '../../src/shared/contracts/sensors'
import type { MediaCommand, MediaEvent } from '../../src/shared/ipc/media-api'

const generation: Generation = { sessionId: 'gesture-1', revision: 1 }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const failure = (code: ClientError['code']): Result<never> => ({
  ok: false,
  error: { code, message: 'x' }
})

function setup() {
  const commands: MediaCommand[] = []
  const released: string[] = []
  const acquired: unknown[] = []
  let mediaListener: (event: MediaEvent) => void = () => undefined
  let sensorListener: (event: SensorEvent) => void = () => undefined
  const state = {
    commandResult: { ok: true, value: undefined } as Result<void>,
    hold: null as Promise<void> | null,
    acquire: { ok: true } as { ok: boolean },
    model: { ok: true, value: new Uint8Array([1, 2, 3]) } as Result<Uint8Array>
  }
  const lease: SensorLease = {
    kind: 'camera',
    owner: 'gesture_control',
    generation,
    leaseId: 'lease-1',
    deviceId: 'cam-0'
  }
  const service = new HandTrackingService({
    sensors: {
      acquire: async (request) => {
        acquired.push(request)
        return state.acquire.ok ? { ok: true, value: lease } : failure('permission_denied')
      },
      release: async (leaseId) => {
        released.push(leaseId)
        return { ok: true, value: { status: 'released' } }
      },
      subscribe: (listener) => {
        sensorListener = listener
        return () => undefined
      }
    },
    bridge: {
      command: async (command) => {
        commands.push(command)
        if (state.hold && command.type === 'handtracking.start') await state.hold
        return state.commandResult
      },
      subscribe: (listener) => {
        mediaListener = listener
        return () => undefined
      }
    },
    loadModel: async () => state.model
  })
  const events: HandTrackingEvent[] = []
  service.subscribe((event) => events.push(event))
  return {
    service,
    commands,
    released,
    acquired,
    events,
    state,
    media: (event: MediaEvent) => mediaListener(event),
    revoke: (code: ClientError['code']) =>
      sensorListener({
        type: 'sensor.lease_revoked',
        lease,
        error: { code, message: 'x' }
      })
  }
}

const frame = (sequence: number, g: Generation = generation): HandTrackingFrame => ({
  generation: g,
  sequence,
  capturedAtMs: sequence * 10,
  hands: []
})
const frameEvent = (sequence: number, g?: Generation): MediaEvent => ({
  type: 'hand.tracking',
  event: { type: 'tracking.frame', frame: frame(sequence, g) }
})

describe('HandTrackingService', () => {
  it('takes a gesture camera lease and starts the tracker with the model', async () => {
    const t = setup()
    expect(await t.service.start(generation)).toEqual({ ok: true, value: undefined })
    expect(t.acquired).toEqual([{ kind: 'camera', owner: 'gesture_control', generation }])
    expect(t.commands[0]).toMatchObject({
      type: 'handtracking.start',
      request: { generation, model: new Uint8Array([1, 2, 3]) }
    })
    expect(t.service.isActive()).toBe(true)
  })

  it('does not take the camera when the model is missing', async () => {
    const t = setup()
    t.state.model = failure('unavailable')
    expect(await t.service.start(generation)).toMatchObject({ ok: false })
    expect(t.acquired).toEqual([])
  })

  it('reports a denied camera and starts nothing', async () => {
    const t = setup()
    t.state.acquire = { ok: false }
    expect(await t.service.start(generation)).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' }
    })
    expect(t.commands).toEqual([])
    expect(t.service.isActive()).toBe(false)
  })

  it('returns the camera when the tracker cannot start', async () => {
    const t = setup()
    t.state.commandResult = failure('unavailable')
    expect(await t.service.start(generation)).toMatchObject({ ok: false })
    expect(t.released).toEqual(['lease-1'])
    expect(t.service.isActive()).toBe(false)
  })

  it('refuses a second start while one is active or starting', async () => {
    const t = setup()
    await t.service.start(generation)
    expect(await t.service.start(generation)).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
  })

  it('forwards frames of the current run in order and drops stale or old ones', async () => {
    const t = setup()
    await t.service.start(generation)
    t.media(frameEvent(1))
    t.media(frameEvent(3))
    t.media(frameEvent(2))
    t.media(frameEvent(1))
    t.media(frameEvent(4, { sessionId: 'older', revision: 1 }))
    expect(
      t.events.map((event) => (event.type === 'tracking.frame' ? event.frame.sequence : -1))
    ).toEqual([1, 3])
  })

  it('ignores tracking events when no run is active', () => {
    const t = setup()
    t.media(frameEvent(1))
    expect(t.events).toEqual([])
  })

  it('stop tells the renderer, returns the camera and ends forwarding', async () => {
    const t = setup()
    await t.service.start(generation)
    await t.service.stop()
    expect(t.commands.at(-1)).toEqual({ type: 'handtracking.stop', generation })
    expect(t.released).toEqual(['lease-1'])
    t.media(frameEvent(1))
    expect(t.events).toEqual([])
    await t.service.stop()
    expect(t.released).toEqual(['lease-1'])
  })

  it('a stop that arrives while starting cancels the start and returns the camera', async () => {
    const t = setup()
    let release: () => void = () => undefined
    t.state.hold = new Promise((resolve) => (release = resolve))
    const started = t.service.start(generation)
    await flush()
    const stopped = t.service.stop()
    release()
    expect(await started).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    await stopped
    expect(t.released).toEqual(['lease-1'])
    expect(t.service.isActive()).toBe(false)
  })

  it('reports lost permission and returns the camera when the lease is revoked', async () => {
    const t = setup()
    await t.service.start(generation)
    t.media(frameEvent(5))
    t.revoke('permission_denied')
    await flush()
    expect(t.events.at(-1)).toEqual({
      type: 'tracking.lost',
      generation,
      sequence: 5,
      reason: 'permission_revoked'
    })
    expect(t.released).toEqual(['lease-1'])
    expect(t.service.isActive()).toBe(false)
  })

  it('treats other revocations (sign-out, pause, device loss) as the engine being gone', async () => {
    const t = setup()
    await t.service.start(generation)
    t.revoke('device_unavailable')
    await flush()
    expect(t.events.at(-1)).toMatchObject({ type: 'tracking.lost', reason: 'engine_error' })
  })

  it('ends the run when the renderer reports an engine failure, without telling it to stop', async () => {
    const t = setup()
    await t.service.start(generation)
    t.media({
      type: 'hand.tracking',
      event: { type: 'tracking.lost', generation, sequence: 7, reason: 'engine_error' }
    })
    await flush()
    expect(t.events.at(-1)).toMatchObject({ type: 'tracking.lost', reason: 'engine_error' })
    expect(t.released).toEqual(['lease-1'])
    expect(t.service.isActive()).toBe(false)
  })

  it('keeps tracking when a hand merely leaves the picture', async () => {
    const t = setup()
    await t.service.start(generation)
    t.media({
      type: 'hand.tracking',
      event: { type: 'tracking.lost', generation, sequence: 2, reason: 'no_hand' }
    })
    await flush()
    expect(t.service.isActive()).toBe(true)
    expect(t.released).toEqual([])
  })

  it('disposing the service stops tracking and returns the camera', async () => {
    const t = setup()
    await t.service.start(generation)
    t.service.dispose()
    await flush()
    expect(t.released).toEqual(['lease-1'])
  })
})
