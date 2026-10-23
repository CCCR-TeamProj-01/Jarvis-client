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

const previews = (events: MediaEvent[]) =>
  events.flatMap((event) => (event.type === 'hand.preview' ? [event.preview] : []))

describe('HandTrackingPipeline previews', () => {
  const picture = { width: 320, height: 240, jpeg: new Uint8Array([1, 2, 3]) }
  function withPreview(interval = 50) {
    const captured: { image: ImageBitmap; at: string[] }[] = []
    const order: string[] = []
    const encoder = {
      capture: vi.fn<(image: ImageBitmap) => Promise<typeof picture | null>>(async (image) => {
        order.push('capture')
        captured.push({ image, at: [...order] })
        return picture
      })
    }
    const source = new FakeSource()
    const tracker = new FakeTracker()
    const original = tracker.next
    tracker.next = async (frame) => {
      order.push('detect')
      return original(frame)
    }
    const events: MediaEvent[] = []
    const pipeline = new HandTrackingPipeline({
      source,
      createTracker: () => tracker,
      publish: (event) => events.push(event),
      preview: encoder,
      previewIntervalMs: interval
    })
    return { source, tracker, events, pipeline, encoder, order, captured }
  }

  it('makes no preview until asked, and none without an encoder', async () => {
    const t = withPreview()
    await t.pipeline.start({}, request)
    t.source.push({ image: bitmap(), capturedAtMs: 0 })
    await flush()
    expect(t.encoder.capture).not.toHaveBeenCalled()
    expect(previews(t.events)).toEqual([])
    const bare = setup()
    await bare.pipeline.start({}, request)
    expect(bare.pipeline.setPreview(generation, true)).toBe(false)
  })

  it('makes a preview of the picture a frame came from, with that frame’s sequence, before detection takes the picture', async () => {
    const t = withPreview()
    await t.pipeline.start({}, request)
    expect(t.pipeline.setPreview(generation, true)).toBe(true)
    const image = bitmap()
    t.source.push({ image, capturedAtMs: 100 })
    await flush()
    expect(t.order.slice(0, 2)).toEqual(['capture', 'detect'])
    expect(t.captured[0]!.image).toBe(image)
    expect(previews(t.events)).toEqual([{ generation, sequence: 1, ...picture }])
    // The observation of the same picture carries the same sequence.
    expect(frames(t.events).map((frame) => frame.sequence)).toEqual([1])
  })

  it('gives every frame its picture by default, even when the camera’s frames come a little closer than thirty a second', async () => {
    const encoder = {
      capture: vi.fn<(image: ImageBitmap) => Promise<typeof picture | null>>(async () => picture)
    }
    const source = new FakeSource()
    const events: MediaEvent[] = []
    const pipeline = new HandTrackingPipeline({
      source,
      createTracker: () => new FakeTracker(),
      publish: (event) => events.push(event),
      preview: encoder
    })
    await pipeline.start({}, request)
    pipeline.setPreview(generation, true)
    // Frames 30.5 ms apart: a fixed spacing of 33 ms would leave out most of their pictures.
    for (let index = 0; index < 8; index++) {
      source.push({ image: bitmap(), capturedAtMs: index * 30.5 })
      await flush()
    }
    expect(previews(events).map((preview) => preview.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('makes previews no more often than the interval', async () => {
    const t = withPreview(50)
    await t.pipeline.start({}, request)
    t.pipeline.setPreview(generation, true)
    for (const at of [0, 20, 40, 60, 80, 100, 130]) {
      t.source.push({ image: bitmap(), capturedAtMs: at })
      await flush()
    }
    expect(previews(t.events).map((preview) => preview.sequence)).toEqual([1, 4, 7])
  })

  it('stops making previews when turned off, and drops one that was still being encoded', async () => {
    const t = withPreview(0)
    await t.pipeline.start({}, request)
    t.pipeline.setPreview(generation, true)
    let finish: (value: typeof picture) => void = () => undefined
    t.encoder.capture.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    t.source.push({ image: bitmap(), capturedAtMs: 0 })
    await flush()
    t.pipeline.setPreview(generation, false)
    finish(picture)
    await flush()
    expect(previews(t.events)).toEqual([])
    t.source.push({ image: bitmap(), capturedAtMs: 10 })
    await flush()
    expect(t.encoder.capture).toHaveBeenCalledTimes(1)
  })

  it('does not start a second preview while one is still being encoded', async () => {
    const t = withPreview(0)
    await t.pipeline.start({}, request)
    t.pipeline.setPreview(generation, true)
    let finish: (value: typeof picture) => void = () => undefined
    t.encoder.capture.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    for (const at of [0, 10, 20]) {
      t.source.push({ image: bitmap(), capturedAtMs: at })
      await flush()
    }
    expect(t.encoder.capture).toHaveBeenCalledTimes(1)
    finish(picture)
    await flush()
    t.source.push({ image: bitmap(), capturedAtMs: 30 })
    await flush()
    expect(t.encoder.capture).toHaveBeenCalledTimes(2)
    expect(previews(t.events).map((preview) => preview.sequence)).toEqual([1, 4])
  })

  it('does not let a failed or empty preview affect tracking', async () => {
    const t = withPreview(0)
    await t.pipeline.start({}, request)
    t.pipeline.setPreview(generation, true)
    t.encoder.capture.mockResolvedValueOnce(null)
    t.encoder.capture.mockRejectedValueOnce(new Error('canvas lost'))
    for (let at = 0; at < 3; at++) {
      t.source.push({ image: bitmap(), capturedAtMs: at })
      await flush()
    }
    expect(frames(t.events)).toHaveLength(3)
    expect(previews(t.events).map((preview) => preview.sequence)).toEqual([3])
  })

  it('only answers for the run that is going on, and not after it ended', async () => {
    const t = withPreview()
    expect(t.pipeline.setPreview(generation, true)).toBe(false)
    await t.pipeline.start({}, request)
    expect(t.pipeline.setPreview({ sessionId: 'other', revision: 1 }, true)).toBe(false)
    expect(t.pipeline.setPreview(generation, true)).toBe(true)
    await t.pipeline.stop()
    expect(t.pipeline.setPreview(generation, true)).toBe(false)
  })

  it('makes the first picture at once after being turned off and on again, without waiting out the interval', async () => {
    const t = withPreview(50)
    await t.pipeline.start({}, request)
    t.pipeline.setPreview(generation, true)
    t.source.push({ image: bitmap(), capturedAtMs: 0 })
    await flush()
    t.pipeline.setPreview(generation, false)
    t.pipeline.setPreview(generation, true)
    t.source.push({ image: bitmap(), capturedAtMs: 10 })
    await flush()
    expect(previews(t.events).map((preview) => preview.sequence)).toEqual([1, 2])
  })

  it('starts each run with the preview off', async () => {
    const t = withPreview(0)
    await t.pipeline.start({}, request)
    t.pipeline.setPreview(generation, true)
    await t.pipeline.stop()
    await t.pipeline.start({}, request)
    t.source.push({ image: bitmap(), capturedAtMs: 0 })
    await flush()
    expect(t.encoder.capture).not.toHaveBeenCalled()
  })
})

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
