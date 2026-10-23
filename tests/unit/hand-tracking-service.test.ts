import { describe, expect, it } from 'vitest'
import { HandTrackingService } from '../../src/main/gesture/hand-tracking'
import type { ClientError, Generation, Result } from '../../src/shared/contracts/common'
import type { HandTrackingEvent, HandTrackingFrame } from '../../src/shared/contracts/gesture'
import type { SensorEvent, SensorLease } from '../../src/shared/contracts/sensors'
import type { HandPreview, MediaCommand, MediaEvent } from '../../src/shared/ipc/media-api'
import type { TrackingRunEvent } from '../../src/main/gesture/hand-tracking'

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

describe('HandTrackingService for the recognition view', () => {
  const other: Generation = { sessionId: 'diag-1', revision: 1 }
  const preview = (sequence: number, g: Generation = generation): HandPreview => ({
    generation: g,
    sequence,
    width: 320,
    height: 180,
    jpeg: new Uint8Array([1, 2, 3])
  })
  const previewEvent = (sequence: number, g?: Generation): MediaEvent => ({
    type: 'hand.preview',
    preview: preview(sequence, g)
  })

  it('takes the camera for the owner it was asked for', async () => {
    const t = setup()
    await t.service.start(other, undefined, { owner: 'diagnostics' })
    expect(t.acquired).toEqual([{ kind: 'camera', owner: 'diagnostics', generation: other }])
    expect(t.service.currentRun()).toEqual({ generation: other, owner: 'diagnostics' })
  })

  it('says which run is going on, and none when there is none', async () => {
    const t = setup()
    expect(t.service.currentRun()).toBeNull()
    await t.service.start(generation)
    expect(t.service.currentRun()).toEqual({ generation, owner: 'gesture_control' })
    await t.service.stop()
    expect(t.service.currentRun()).toBeNull()
  })

  it('lets the cursor control take over from the recognition view, which gives the camera back first', async () => {
    const t = setup()
    const runs: TrackingRunEvent[] = []
    t.service.subscribeRuns((event) => runs.push(event))
    await t.service.start(other, undefined, { owner: 'diagnostics' })
    expect(await t.service.start(generation)).toEqual({ ok: true, value: undefined })
    expect(t.commands.map((command) => command.type)).toEqual([
      'handtracking.start',
      'handtracking.stop',
      'handtracking.start'
    ])
    expect(t.released).toEqual(['lease-1'])
    expect(runs).toEqual([
      { type: 'started', generation: other, owner: 'diagnostics' },
      { type: 'ended', generation: other, owner: 'diagnostics', reason: 'preempted' },
      { type: 'started', generation, owner: 'gesture_control' }
    ])
    expect(t.service.currentRun()).toEqual({ generation, owner: 'gesture_control' })
  })

  it('never takes the camera from the cursor control, or from another run of its own kind', async () => {
    const t = setup()
    await t.service.start(generation)
    expect(await t.service.start(other, undefined, { owner: 'diagnostics' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    expect(t.service.currentRun()).toEqual({ generation, owner: 'gesture_control' })
    await t.service.stop()
    await t.service.start(other, undefined, { owner: 'diagnostics' })
    expect(await t.service.start(generation, undefined, { owner: 'diagnostics' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
  })

  it('turns previews on and off for the run that is going on, and refuses with no run', async () => {
    const t = setup()
    expect(await t.service.setPreview(true)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(t.commands).toEqual([])
    await t.service.start(generation)
    expect(await t.service.setPreview(true)).toEqual({ ok: true, value: undefined })
    expect(await t.service.setPreview(false)).toEqual({ ok: true, value: undefined })
    expect(t.commands.slice(1)).toEqual([
      { type: 'handtracking.preview', generation, enabled: true },
      { type: 'handtracking.preview', generation, enabled: false }
    ])
    t.state.commandResult = failure('unavailable')
    expect(await t.service.setPreview(true)).toMatchObject({ ok: false })
  })

  it('forwards previews of the current run only, and only while a run is going on', async () => {
    const t = setup()
    const heard: number[] = []
    const stop = t.service.subscribePreview((picture) => heard.push(picture.sequence))
    t.media(previewEvent(1))
    expect(heard).toEqual([])
    await t.service.start(generation)
    t.media(previewEvent(2))
    t.media(previewEvent(3, { sessionId: 'older', revision: 1 }))
    t.media(previewEvent(4))
    expect(heard).toEqual([2, 4])
    stop()
    t.media(previewEvent(5))
    expect(heard).toEqual([2, 4])
  })

  it('lets a failing preview listener leave the others and tracking alone', async () => {
    const t = setup()
    await t.service.start(generation)
    const heard: number[] = []
    t.service.subscribePreview(() => {
      throw new Error('listener failed')
    })
    t.service.subscribePreview((picture) => heard.push(picture.sequence))
    t.media(previewEvent(1))
    t.media(frameEvent(1))
    expect(heard).toEqual([1])
    expect(t.events).toHaveLength(1)
  })

  it('says when a run ends and why, and says it once the camera has been given back', async () => {
    const t = setup()
    const runs: string[] = []
    t.service.subscribeRuns((event) => {
      runs.push(event.type === 'ended' ? `ended:${event.reason}:${t.released.length}` : event.type)
    })
    await t.service.start(generation)
    await t.service.stop()
    expect(runs).toEqual(['started', 'ended:stopped:1'])
    await t.service.start(generation)
    t.revoke('permission_denied')
    await flush()
    expect(runs.at(-1)).toBe('ended:failed:2')
  })

  it('says a run failed when the renderer reports it failed, or the engine is lost', async () => {
    const lost: MediaEvent = {
      type: 'hand.tracking',
      event: { type: 'tracking.lost', generation, sequence: 2, reason: 'engine_error' }
    }
    const failed: MediaEvent = {
      type: 'handtracking.state',
      generation,
      state: 'failed',
      error: { code: 'unavailable', message: 'x' }
    }
    for (const event of [lost, failed]) {
      const t = setup()
      const reasons: string[] = []
      t.service.subscribeRuns((run) => run.type === 'ended' && reasons.push(run.reason))
      await t.service.start(generation)
      t.media(event)
      await flush()
      expect(reasons).toEqual(['failed'])
    }
  })

  it('says a start came to nothing, without ever saying a run started', async () => {
    const t = setup()
    const runs: TrackingRunEvent[] = []
    t.service.subscribeRuns((event) => runs.push(event))
    // The tracker cannot start: the run that was being made ends, and the start is said to have failed.
    t.state.commandResult = failure('unavailable')
    await t.service.start(generation)
    expect(runs.map((run) => run.type)).toEqual(['ended', 'start_failed'])
    expect(runs[0]).toMatchObject({ reason: 'failed', owner: 'gesture_control' })
    // No camera at all: only the failed start is said, for whoever it was for.
    runs.length = 0
    t.state.commandResult = { ok: true, value: undefined }
    t.state.acquire = { ok: false }
    await t.service.start(other, undefined, { owner: 'diagnostics' })
    expect(runs).toEqual([{ type: 'start_failed', owner: 'diagnostics' }])
    // A start refused outright as a conflict is no run's business, and says nothing.
    t.state.acquire = { ok: true }
    await t.service.start(generation)
    runs.length = 0
    await t.service.start(generation)
    expect(runs).toEqual([])
  })

  it('does not let a failing run listener keep the others from hearing', async () => {
    const t = setup()
    const heard: string[] = []
    t.service.subscribeRuns(() => {
      throw new Error('listener failed')
    })
    const stop = t.service.subscribeRuns((event) => heard.push(event.type))
    await t.service.start(generation)
    expect(heard).toEqual(['started'])
    stop()
    await t.service.stop()
    expect(heard).toEqual(['started'])
  })
})
