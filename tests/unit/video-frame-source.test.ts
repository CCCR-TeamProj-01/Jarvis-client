import { describe, expect, it, vi } from 'vitest'
import { VideoFrameSource } from '../../src/renderer/media/hand-tracking/video-frame-source'
import type { VideoLike } from '../../src/renderer/media/hand-tracking/video-frame-source'

const bitmap = () =>
  ({ close: vi.fn<() => void>() }) as unknown as ImageBitmap & { close: () => void }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function setup(options: { playError?: boolean } = {}) {
  const video: VideoLike & { paused: boolean } = {
    srcObject: null,
    muted: false,
    readyState: 4,
    currentTime: 0,
    paused: false,
    play: vi.fn<() => Promise<void>>(async () => {
      if (options.playError) throw new Error('blocked')
    }),
    pause() {
      this.paused = true
    }
  }
  let tick: () => void = () => undefined
  const cancel = vi.fn<() => void>()
  let release: () => void = () => undefined
  let hold: Promise<void> | null = null
  const created: ImageBitmap[] = []
  const source = new VideoFrameSource({
    createVideo: () => video,
    createBitmap: async () => {
      if (hold) await hold
      const image = bitmap()
      created.push(image)
      return image
    },
    now: () => 1234,
    every: (callback, intervalMs) => {
      expect(intervalMs).toBe(100)
      tick = callback
      return cancel
    }
  })
  const frames: { image: ImageBitmap; capturedAtMs: number }[] = []
  return {
    source,
    video,
    frames,
    created,
    cancel,
    tick: () => tick(),
    holdBitmaps: () => {
      hold = new Promise((resolve) => (release = resolve))
    },
    releaseBitmaps: () => release(),
    start: () => source.start({ id: 'stream' }, { fps: 10 }, (frame) => frames.push(frame))
  }
}

describe('VideoFrameSource', () => {
  it('plays the stream muted and hands out a frame each time the picture advances', async () => {
    const t = setup()
    expect((await t.start()).ok).toBe(true)
    expect(t.video.muted).toBe(true)
    expect(t.video.srcObject).toEqual({ id: 'stream' })
    t.video.currentTime = 0.1
    t.tick()
    await flush()
    expect(t.frames).toHaveLength(1)
    expect(t.frames[0]?.capturedAtMs).toBe(1234)
  })

  it('skips a tick when the picture has not changed or is not ready yet', async () => {
    const t = setup()
    await t.start()
    t.video.currentTime = 0.1
    t.tick()
    await flush()
    t.tick()
    await flush()
    expect(t.frames).toHaveLength(1)
    t.video.readyState = 1
    t.video.currentTime = 0.2
    t.tick()
    await flush()
    expect(t.frames).toHaveLength(1)
  })

  it('does not start a second copy while one is still being made', async () => {
    const t = setup()
    await t.start()
    t.holdBitmaps()
    t.video.currentTime = 0.1
    t.tick()
    t.video.currentTime = 0.2
    t.tick()
    t.releaseBitmaps()
    await flush()
    expect(t.created).toHaveLength(1)
  })

  it('closes a picture that finishes after stop, and releases the camera element', async () => {
    const t = setup()
    await t.start()
    t.holdBitmaps()
    t.video.currentTime = 0.1
    t.tick()
    t.source.stop()
    t.releaseBitmaps()
    await flush()
    expect(t.frames).toHaveLength(0)
    expect(t.created[0]?.close).toHaveBeenCalled()
    expect(t.cancel).toHaveBeenCalled()
    expect(t.video.paused).toBe(true)
    expect(t.video.srcObject).toBeNull()
  })

  it('reports failure when the video cannot play', async () => {
    const t = setup({ playError: true })
    const result = await t.start()
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('a start that is stopped while playback begins is cancelled', async () => {
    const t = setup()
    const started = t.start()
    t.source.stop()
    expect(await started).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(t.cancel).not.toHaveBeenCalled()
  })
})
