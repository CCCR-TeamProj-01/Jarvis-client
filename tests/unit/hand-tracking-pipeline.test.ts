import { describe, expect, it, vi } from 'vitest'
import { HandTrackingPipeline } from '../../src/renderer/media/hand-tracking/hand-tracking-pipeline'
import type { TrackerHandle } from '../../src/renderer/media/hand-tracking/hand-tracking-pipeline'
import type { FrameSource } from '../../src/renderer/media/hand-tracking/video-frame-source'
import type { CameraFrame } from '../../src/shared/ports/camera'
import type { ClientError, Generation, Result } from '../../src/shared/contracts/common'
import type { HandTrackingFrame } from '../../src/shared/contracts/gesture'
import type { MediaEvent } from '../../src/shared/ipc/media-api'

const generation: Generation = { sessionId: 'g1', revision: 1 }
const request = { generation, model: new Uint8Array([1]) }
const bitmap = () =>
  ({ close: vi.fn<() => void>() }) as unknown as ImageBitmap & { close: () => void }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const error = (code: ClientError['code']): Result<never> => ({
  ok: false,
  error: { code, message: 'x' }
})

class FakeSource implements FrameSource {
  push: (frame: { image: ImageBitmap; capturedAtMs: number }) => void = () => undefined
  startResult: Result<void> = { ok: true, value: undefined }
  stops = 0
  started: { fps: number }[] = []
  async start(
    _stream: unknown,
    options: { fps: number },
    onFrame: (frame: { image: ImageBitmap; capturedAtMs: number }) => void
  ) {
    this.started.push(options)
    this.push = onFrame
    return this.startResult
  }
  stop() {
    this.stops += 1
  }
}

class FakeTracker implements TrackerHandle {
  ready: Result<void> = { ok: true, value: undefined }
  detected: CameraFrame[] = []
  disposed = false
  generation: Generation | null = null
  /** Results are produced by this, so tests can hold a detection open. */
  next: (frame: CameraFrame) => Promise<Result<HandTrackingFrame>> = async (frame) => {
    frame.image.close()
    return {
      ok: true,
      value: {
        generation: frame.generation,
        sequence: frame.sequence,
        capturedAtMs: frame.capturedAtMs,
        hands: []
      }
    }
  }
  async whenReady() {
    return this.ready
  }
  detect(frame: CameraFrame) {
    this.detected.push(frame)
    return this.next(frame)
  }
  reset(value: Generation) {
    this.generation = value
  }
  async dispose() {
    this.disposed = true
  }
}

function setup() {
  const source = new FakeSource()
  const tracker = new FakeTracker()
  const events: MediaEvent[] = []
  const pipeline = new HandTrackingPipeline({
    source,
    createTracker: () => tracker,
    publish: (event) => events.push(event)
  })
  return { source, tracker, events, pipeline }
}

const frames = (events: MediaEvent[]) =>
  events.flatMap((event) =>
    event.type === 'hand.tracking' && event.event.type === 'tracking.frame'
      ? [event.event.frame]
      : []
  )
const states = (events: MediaEvent[]) =>
  events.flatMap((event) => (event.type === 'handtracking.state' ? [event.state] : []))

describe('HandTrackingPipeline', () => {
  it('starts the tracker for the generation, then the source at the requested rate', async () => {
    const t = setup()
    expect(await t.pipeline.start({}, { ...request, maxFps: 15 })).toEqual({
      ok: true,
      value: null
    })
    expect(t.tracker.generation).toEqual(generation)
    expect(t.source.started).toEqual([{ fps: 15 }])
    expect(states(t.events)).toEqual(['started'])
  })

  it('publishes one frame per picture with rising sequence numbers', async () => {
    const t = setup()
    await t.pipeline.start({}, request)
    t.source.push({ image: bitmap(), capturedAtMs: 10 })
    await flush()
    t.source.push({ image: bitmap(), capturedAtMs: 20 })
    await flush()
    expect(frames(t.events).map((frame) => [frame.sequence, frame.capturedAtMs])).toEqual([
      [1, 10],
      [2, 20]
    ])
  })

  it('keeps only the newest waiting picture while one is being analysed', async () => {
    const t = setup()
    await t.pipeline.start({}, request)
    let finish: () => void = () => undefined
    const held = new Promise<void>((resolve) => (finish = resolve))
    const original = t.tracker.next
    t.tracker.next = async (frame) => {
      if (frame.sequence === 1) await held
      return original(frame)
    }
    const [a, b, c] = [bitmap(), bitmap(), bitmap()]
    t.source.push({ image: a, capturedAtMs: 1 })
    t.source.push({ image: b, capturedAtMs: 2 })
    t.source.push({ image: c, capturedAtMs: 3 })
    expect(b.close).toHaveBeenCalled()
    finish()
    await flush()
    await flush()
    expect(t.tracker.detected.map((frame) => frame.capturedAtMs)).toEqual([1, 3])
  })

  it('fails to start, and cleans up, when the engine cannot load', async () => {
    const t = setup()
    t.tracker.ready = error('unavailable')
    expect(await t.pipeline.start({}, request)).toMatchObject({ ok: false })
    expect(t.tracker.disposed).toBe(true)
    expect(t.source.started).toEqual([])
  })

  it('fails to start, and cleans up, when the camera picture cannot be read', async () => {
    const t = setup()
    t.source.startResult = error('unavailable')
    expect(await t.pipeline.start({}, request)).toMatchObject({ ok: false })
    expect(t.tracker.disposed).toBe(true)
    expect(t.source.stops).toBeGreaterThan(0)
  })

  it('tolerates a few bad frames but reports an engine failure after many in a row', async () => {
    const t = setup()
    await t.pipeline.start({}, request)
    let failing = true
    t.tracker.next = async (frame) => {
      frame.image.close()
      return failing
        ? error('internal')
        : { ok: true, value: { generation, sequence: frame.sequence, capturedAtMs: 0, hands: [] } }
    }
    for (let index = 0; index < 4; index++) {
      t.source.push({ image: bitmap(), capturedAtMs: index })
      await flush()
    }
    expect(t.tracker.disposed).toBe(false)
    failing = false
    t.source.push({ image: bitmap(), capturedAtMs: 10 })
    await flush()
    failing = true
    // The earlier run of errors was broken by a success, so it takes a full run to give up.
    for (let index = 0; index < 5; index++) {
      t.source.push({ image: bitmap(), capturedAtMs: 20 + index })
      await flush()
    }
    expect(t.tracker.disposed).toBe(true)
    expect(states(t.events)).toEqual(['started', 'failed'])
    expect(t.events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: 'tracking.lost', reason: 'engine_error' })
      })
    )
  })

  it('stops only the run it is asked to, and releases everything', async () => {
    const t = setup()
    await t.pipeline.start({}, request)
    await t.pipeline.stop({ sessionId: 'other', revision: 1 })
    expect(t.tracker.disposed).toBe(false)
    await t.pipeline.stop(generation)
    expect(t.tracker.disposed).toBe(true)
    expect(t.source.stops).toBeGreaterThan(0)
    expect(states(t.events)).toEqual(['started', 'stopped'])
  })

  it('discards a picture that arrives after stop', async () => {
    const t = setup()
    await t.pipeline.start({}, request)
    await t.pipeline.stop()
    const late = bitmap()
    t.source.push({ image: late, capturedAtMs: 5 })
    expect(late.close).toHaveBeenCalled()
    expect(t.tracker.detected).toEqual([])
  })

  it('reports lost permission when the camera goes away', async () => {
    const t = setup()
    await t.pipeline.start({}, request)
    await t.pipeline.cameraLost({ code: 'permission_denied', message: 'x' })
    expect(t.events).toContainEqual(
      expect.objectContaining({ event: expect.objectContaining({ reason: 'permission_revoked' }) })
    )
    expect(states(t.events)).toEqual(['started', 'failed'])
    expect(t.tracker.disposed).toBe(true)
  })

  it('a new start replaces the previous run', async () => {
    const t = setup()
    await t.pipeline.start({}, request)
    await t.pipeline.start({}, { ...request, generation: { sessionId: 'g2', revision: 1 } })
    expect(t.tracker.generation).toEqual({ sessionId: 'g2', revision: 1 })
    expect(t.source.stops).toBeGreaterThan(0)
  })
})
