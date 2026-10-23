import { describe, expect, it, vi } from 'vitest'
import { GestureDiagnostics } from '../../src/main/gesture/gesture-diagnostics'
import { HandTrackingService } from '../../src/main/gesture/hand-tracking'
import type { ClientError, Generation, Result } from '../../src/shared/contracts/common'
import type { HandTrackingFrame } from '../../src/shared/contracts/gesture'
import type { DiagnosticsEvent } from '../../src/shared/contracts/gesture-diagnostics'
import { DiagnosticsEventSchema } from '../../src/shared/contracts/gesture-diagnostics'
import type { SensorEvent, SensorLease } from '../../src/shared/contracts/sensors'
import type { MediaCommand, MediaEvent } from '../../src/shared/ipc/media-api'
import { hand } from '../fixtures/hands'

const flush = async () => {
  for (let index = 0; index < 5; index++)
    await new Promise<void>((resolve) => setImmediate(resolve))
}
const failure = (code: ClientError['code'], message = 'x'): Result<never> => ({
  ok: false,
  error: { code, message }
})
const control: Generation = { sessionId: 'gesture-1', revision: 1 }

/** The real tracking service over a fake camera and fake media page, with the recognition view on top of it. */
function setup(options: { signedIn?: boolean } = {}) {
  const commands: MediaCommand[] = []
  const released: string[] = []
  let leases = 0
  let mediaListener: (event: MediaEvent) => void = () => undefined
  let sensorListener: (event: SensorEvent) => void = () => undefined
  const state = {
    startResult: { ok: true, value: undefined } as Result<void>,
    previewResult: { ok: true, value: undefined } as Result<void>,
    acquire: { ok: true } as { ok: boolean },
    hold: null as Promise<void> | null,
    holdCamera: null as Promise<void> | null,
    gate: { ok: true, value: undefined } as Result<void>
  }
  let lastLease: SensorLease | null = null
  const tracking = new HandTrackingService({
    sensors: {
      acquire: async (request) => {
        if (state.holdCamera) await state.holdCamera
        if (!state.acquire.ok) return failure('permission_denied')
        lastLease = {
          kind: 'camera',
          owner: request.owner,
          generation: request.generation,
          leaseId: `lease-${++leases}`,
          deviceId: 'cam-0'
        }
        return { ok: true, value: lastLease }
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
        if (command.type === 'handtracking.preview') return state.previewResult
        if (command.type === 'handtracking.start') {
          if (state.hold) await state.hold
          return state.startResult
        }
        return { ok: true, value: undefined }
      },
      subscribe: (listener) => {
        mediaListener = listener
        return () => undefined
      }
    },
    loadModel: async () => ({ ok: true, value: new Uint8Array([1]) })
  })
  let ids = 0
  const diagnostics = new GestureDiagnostics({
    tracking,
    gate: { check: () => state.gate },
    createId: () => `d${++ids}`
  })
  if (options.signedIn !== false) diagnostics.start('u1')
  const events: DiagnosticsEvent[] = []
  diagnostics.subscribe((event) => events.push(event))
  const run = async (request: 'start' | 'stop') => {
    const result = await diagnostics.command({ action: request })
    await flush()
    return result
  }
  const snapshot = () => diagnostics.getSnapshot()
  const frames = () =>
    events.flatMap((event) => (event.type === 'gesture_diagnostics.frame' ? [event.frame] : []))
  const frameOf = (g: Generation, sequence: number, hands = [hand({ pose: 'pointing' })]) => {
    const value: HandTrackingFrame = { generation: g, sequence, capturedAtMs: sequence * 33, hands }
    mediaListener({ type: 'hand.tracking', event: { type: 'tracking.frame', frame: value } })
  }
  const pictureOf = (g: Generation, sequence: number) =>
    mediaListener({
      type: 'hand.preview',
      preview: { generation: g, sequence, width: 320, height: 180, jpeg: new Uint8Array([9, 9]) }
    })
  const currentGeneration = () => tracking.currentRun()?.generation ?? null
  return {
    tracking,
    diagnostics,
    commands,
    released,
    state,
    events,
    run,
    snapshot,
    frames,
    frameOf,
    pictureOf,
    currentGeneration,
    media: (event: MediaEvent) => mediaListener(event),
    revoke: () =>
      sensorListener({
        type: 'sensor.lease_revoked',
        lease: lastLease!,
        error: { code: 'permission_denied', message: 'x' }
      }),
    types: () => commands.map((command) => command.type)
  }
}

describe('starting the recognition view', () => {
  it('runs the tracking itself when nothing is running, with previews on, and does not touch the control', async () => {
    const t = setup()
    const result = await t.run('start')
    expect(result).toMatchObject({ ok: true, value: { state: 'on', source: 'own', preview: true } })
    expect(t.types()).toEqual(['handtracking.start', 'handtracking.preview'])
    expect(t.commands[1]).toMatchObject({ enabled: true })
    expect(t.tracking.currentRun()?.owner).toBe('diagnostics')
  })

  it('only watches when the cursor control is already tracking, without opening the camera again', async () => {
    const t = setup()
    await t.tracking.start(control)
    t.commands.length = 0
    const result = await t.run('start')
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'on', source: 'control', preview: true }
    })
    expect(t.types()).toEqual(['handtracking.preview'])
    expect(t.tracking.currentRun()?.owner).toBe('gesture_control')
  })

  it('shows the thresholds the control judges by', async () => {
    const t = setup()
    expect(t.snapshot().thresholds).toEqual({
      pinchEnter: 0.25,
      pinchExit: 0.45,
      indexEnter: 1.5,
      indexKeep: 1.35,
      othersEnter: 1.3,
      othersKeep: 1.45
    })
  })

  it('does not start without a sign-in, or when the gate says no, and says why', async () => {
    const out = setup({ signedIn: false })
    expect(await out.diagnostics.command({ action: 'start' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    const paused = setup()
    paused.state.gate = failure('unavailable', '인식이 일시 중지되어 있어요.')
    expect(await paused.diagnostics.command({ action: 'start' })).toMatchObject({
      ok: false,
      error: { message: '인식이 일시 중지되어 있어요.' }
    })
    expect(paused.commands).toEqual([])
    expect(paused.snapshot().state).toBe('off')
  })

  it('says it failed, and stops wanting the view, when the camera cannot be opened', async () => {
    const t = setup()
    t.state.acquire = { ok: false }
    const result = await t.run('start')
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'failed', error: { code: 'permission_denied' }, source: null }
    })
    // Nothing starts it again by itself.
    t.state.acquire = { ok: true }
    await t.tracking.start(control)
    await flush()
    expect(t.snapshot().state).toBe('failed')
  })

  it('shows the hands without pictures when pictures cannot be made', async () => {
    const t = setup()
    t.state.previewResult = failure('unavailable')
    expect(await t.run('start')).toMatchObject({
      ok: true,
      value: { state: 'on', source: 'own', preview: false }
    })
    t.frameOf(t.currentGeneration()!, 1)
    expect(t.frames()).toHaveLength(1)
    expect(t.frames()[0]!.picture).toBeNull()
  })

  it('starting twice does not open the camera twice, nor ask for pictures twice', async () => {
    const t = setup()
    await t.run('start')
    await t.run('start')
    expect(t.types().filter((type) => type === 'handtracking.start')).toHaveLength(1)
    expect(t.types().filter((type) => type === 'handtracking.preview')).toHaveLength(1)
  })
})

describe('what the view is told about each frame', () => {
  it('gives the hands with their judgement for frames of the run it shows, and nothing else', async () => {
    const t = setup()
    await t.run('start')
    const g = t.currentGeneration()!
    t.frameOf(g, 1)
    t.frameOf(g, 2, [])
    t.frameOf({ sessionId: 'older', revision: 1 }, 3)
    expect(t.frames().map((frame) => frame.sequence)).toEqual([1, 2])
    const first = t.frames()[0]!
    expect(first.hands).toHaveLength(1)
    expect(first.hands[0]).toMatchObject({
      active: true,
      pointing: true,
      reason: 'pointing',
      pinched: false
    })
    expect(t.frames()[1]!.hands).toEqual([])
    for (const event of t.events) expect(DiagnosticsEventSchema.safeParse(event).success).toBe(true)
  })

  it('attaches the picture made from the same camera picture, and only to that frame', async () => {
    const t = setup()
    await t.run('start')
    const g = t.currentGeneration()!
    t.pictureOf(g, 1)
    t.pictureOf(g, 3)
    t.frameOf(g, 1)
    t.frameOf(g, 2)
    t.frameOf(g, 3)
    t.frameOf(g, 4)
    expect(t.frames().map((frame) => frame.picture?.jpeg.byteLength ?? null)).toEqual([
      2,
      null,
      2,
      null
    ])
    expect(t.frames()[0]!.picture).toMatchObject({ width: 320, height: 180 })
  })

  it('keeps only a few pictures waiting for their frames', async () => {
    const t = setup()
    await t.run('start')
    const g = t.currentGeneration()!
    for (let sequence = 1; sequence <= 10; sequence++) t.pictureOf(g, sequence)
    t.frameOf(g, 2)
    t.frameOf(g, 10)
    expect(t.frames().map((frame) => frame.picture !== null)).toEqual([false, true])
  })

  it('ignores pictures of another run', async () => {
    const t = setup()
    await t.run('start')
    t.pictureOf({ sessionId: 'older', revision: 1 }, 1)
    t.frameOf(t.currentGeneration()!, 1)
    expect(t.frames()[0]!.picture).toBeNull()
  })

  it('says how many frames a second the tracking gives, once it can tell', async () => {
    const t = setup()
    await t.run('start')
    const g = t.currentGeneration()!
    for (let sequence = 1; sequence <= 12; sequence++) t.frameOf(g, sequence)
    expect(t.frames()[0]!.fps).toBeNull()
    // Frames 33 ms apart: about thirty a second.
    expect(t.frames().at(-1)!.fps).toBeGreaterThan(29)
    expect(t.frames().at(-1)!.fps).toBeLessThan(31)
  })

  it('does not hear frames after it was turned off', async () => {
    const t = setup()
    await t.run('start')
    const g = t.currentGeneration()!
    await t.run('stop')
    t.frameOf(g, 1)
    expect(t.frames()).toEqual([])
  })

  it('does not let a failing listener keep the others from hearing', async () => {
    const t = setup()
    const heard = vi.fn<(event: DiagnosticsEvent) => void>()
    t.diagnostics.subscribe(() => {
      throw new Error('listener failed')
    })
    const stop = t.diagnostics.subscribe(heard)
    await t.run('start')
    t.frameOf(t.currentGeneration()!, 1)
    expect(heard).toHaveBeenCalled()
    stop()
    heard.mockClear()
    t.frameOf(t.currentGeneration()!, 2)
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('stopping the recognition view', () => {
  it('gives back a camera it opened itself, and turns pictures off for one it only watched', async () => {
    const own = setup()
    await own.run('start')
    own.commands.length = 0
    expect(await own.run('stop')).toMatchObject({
      ok: true,
      value: { state: 'off', source: null, preview: false }
    })
    expect(own.types()).toEqual(['handtracking.stop'])
    expect(own.released).toEqual(['lease-1'])
    expect(own.tracking.isActive()).toBe(false)

    const watching = setup()
    await watching.tracking.start(control)
    await watching.run('start')
    watching.commands.length = 0
    await watching.run('stop')
    expect(watching.commands).toEqual([
      { type: 'handtracking.preview', generation: control, enabled: false }
    ])
    // The control's camera is not given back.
    expect(watching.tracking.isActive()).toBe(true)
    expect(watching.released).toEqual([])
  })

  it('does not take the tracking up again after it was turned off', async () => {
    const t = setup()
    await t.run('start')
    await t.run('stop')
    await t.tracking.start(control)
    await t.tracking.stop()
    await flush()
    expect(t.snapshot().state).toBe('off')
    expect(t.tracking.isActive()).toBe(false)
  })

  it('ends the view and gives back the camera when the user signs out, and shows nothing of it to the next', async () => {
    const t = setup()
    await t.run('start')
    await t.diagnostics.stop()
    await flush()
    expect(t.tracking.isActive()).toBe(false)
    expect(t.snapshot()).toMatchObject({ state: 'off', source: null })
    expect(await t.diagnostics.command({ action: 'start' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    t.diagnostics.start('u2')
    expect(t.snapshot().state).toBe('off')
  })

  it('ends the view when another account signs in', async () => {
    const t = setup()
    await t.run('start')
    t.diagnostics.start('u2')
    expect(t.snapshot()).toMatchObject({ state: 'off', preview: false })
  })

  it('turns the camera off again when it was stopped while it was still being opened', async () => {
    const t = setup()
    let release: () => void = () => undefined
    t.state.hold = new Promise((resolve) => (release = resolve))
    const starting = t.diagnostics.command({ action: 'start' })
    await flush()
    expect(t.snapshot().state).toBe('starting')
    const stopping = t.diagnostics.command({ action: 'stop' })
    release()
    await starting
    await stopping
    await flush()
    expect(t.tracking.isActive()).toBe(false)
    expect(t.snapshot()).toMatchObject({ state: 'off', source: null })
  })
})

describe('together with the cursor control', () => {
  it('gives the camera to the control when it starts, and goes on showing the control’s tracking', async () => {
    const t = setup()
    await t.run('start')
    const own = t.currentGeneration()!
    expect(await t.tracking.start(control)).toEqual({ ok: true, value: undefined })
    await flush()
    expect(t.snapshot()).toMatchObject({ state: 'on', source: 'control', preview: true })
    // It shows the control's frames, and not the old run's.
    t.frameOf(own, 1)
    t.frameOf(control, 1)
    expect(t.frames()).toHaveLength(1)
    expect(t.tracking.currentRun()).toEqual({ generation: control, owner: 'gesture_control' })
    expect(t.commands.at(-1)).toMatchObject({ type: 'handtracking.preview', generation: control })
  })

  it('judges the control’s hands afresh, not from what it had seen of its own', async () => {
    const t = setup()
    await t.run('start')
    const own = t.currentGeneration()!
    t.frameOf(own, 1, [hand({ pose: 'pointing' })])
    expect(t.frames().at(-1)!.hands[0]!.pointing).toBe(true)
    await t.tracking.start(control)
    await flush()
    // A little bent: enough to go on pointing, but not to start, so only a stale pose would say pointing.
    t.frameOf(control, 1, [hand({ pose: 'pointing', fingertip: { x: 0.5, y: 0.41 } })])
    expect(t.frames().at(-1)!.hands[0]).toMatchObject({ pointing: false, reason: 'index_short' })
  })

  it('takes the tracking up itself again when the control stops', async () => {
    const t = setup()
    await t.tracking.start(control)
    await t.run('start')
    await t.tracking.stop()
    await flush()
    expect(t.snapshot()).toMatchObject({ state: 'on', source: 'own', preview: true })
    expect(t.tracking.currentRun()?.owner).toBe('diagnostics')
  })

  it('takes the tracking up itself again when the control could not start', async () => {
    const t = setup()
    await t.run('start')
    t.state.startResult = failure('unavailable')
    expect(await t.tracking.start(control)).toMatchObject({ ok: false })
    t.state.startResult = { ok: true, value: undefined }
    await flush()
    expect(t.snapshot()).toMatchObject({ state: 'on', source: 'own' })
    expect(t.tracking.currentRun()?.owner).toBe('diagnostics')
  })

  it('waits for the control, then shows it, when it asks to start while the control is opening the camera', async () => {
    const t = setup()
    let release: () => void = () => undefined
    t.state.holdCamera = new Promise((resolve) => (release = resolve))
    const controlStart = t.tracking.start(control)
    await flush()
    await t.run('start')
    expect(t.snapshot()).toMatchObject({ state: 'starting', error: null })
    t.state.holdCamera = null
    release()
    await controlStart
    await flush()
    expect(t.snapshot()).toMatchObject({ state: 'on', source: 'control', preview: true })
  })

  it('shows a control run that is still starting, and its pictures begin once it is up', async () => {
    const t = setup()
    let release: () => void = () => undefined
    t.state.hold = new Promise((resolve) => (release = resolve))
    const controlStart = t.tracking.start(control)
    await flush()
    await t.run('start')
    expect(t.snapshot()).toMatchObject({ state: 'on', source: 'control' })
    t.state.hold = null
    release()
    await controlStart
  })

  it('tries its own tracking when the control it was watching fails, and fails only if that fails too', async () => {
    const ok = setup()
    await ok.tracking.start(control)
    await ok.run('start')
    ok.revoke()
    await flush()
    expect(ok.snapshot()).toMatchObject({ state: 'on', source: 'own' })

    const denied = setup()
    await denied.tracking.start(control)
    await denied.run('start')
    denied.state.acquire = { ok: false }
    denied.revoke()
    await flush()
    expect(denied.snapshot()).toMatchObject({
      state: 'failed',
      error: { code: 'permission_denied' }
    })
  })

  it('does not interfere with a control it was never watching', async () => {
    const t = setup()
    await t.tracking.start(control)
    await t.tracking.stop()
    await flush()
    expect(t.snapshot().state).toBe('off')
    expect(t.commands.filter((command) => command.type === 'handtracking.preview')).toEqual([])
  })
})

describe('when the tracking breaks', () => {
  it('says so and stops wanting the view, without starting itself again in a loop', async () => {
    const t = setup()
    await t.run('start')
    const starts = () => t.types().filter((type) => type === 'handtracking.start').length
    t.revoke()
    await flush()
    expect(t.snapshot()).toMatchObject({ state: 'failed', source: null, preview: false })
    expect(t.snapshot().error?.message).toContain('인식 확인을 멈췄어요')
    await flush()
    expect(starts()).toBe(1)
  })

  it('reacts the same when the media page reports the tracking failed', async () => {
    const t = setup()
    await t.tracking.start(control)
    await t.run('start')
    t.state.acquire = { ok: false }
    t.media({
      type: 'handtracking.state',
      generation: control,
      state: 'failed',
      error: { code: 'unavailable', message: 'x' }
    })
    await flush()
    expect(t.snapshot()).toMatchObject({ state: 'failed', error: { code: 'permission_denied' } })
  })
})
