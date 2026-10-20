import type { ClientError, Result } from '../../../shared/contracts/common'

/** The slice of HTMLVideoElement used here, so frame capture can be tested without a browser. */
export interface VideoLike {
  srcObject: unknown
  muted: boolean
  readyState: number
  currentTime: number
  play(): Promise<void>
  pause(): void
}

export interface FrameSource {
  /** `onFrame` owns the bitmap and must close it or hand it on. */
  start(
    stream: unknown,
    options: { fps: number },
    onFrame: (frame: { image: ImageBitmap; capturedAtMs: number }) => void
  ): Promise<Result<void>>
  stop(): void
}

interface VideoFrameSourceOptions {
  createVideo(): VideoLike
  createBitmap(video: VideoLike): Promise<ImageBitmap>
  now(): number
  /** Returns a cancel function. Injected so pacing can be tested. */
  every(callback: () => void, intervalMs: number): () => void
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Samples a camera stream at a steady rate through a hidden video element. A sample is taken only
 * when the previous one is finished and the picture actually advanced, so a slow consumer or a
 * frozen camera never builds up work.
 */
export class VideoFrameSource implements FrameSource {
  private video: VideoLike | null = null
  private cancel: (() => void) | null = null
  private capturing = false
  private lastTime = -1
  private generation = 0

  constructor(private readonly options: VideoFrameSourceOptions) {}

  async start(
    stream: unknown,
    { fps }: { fps: number },
    onFrame: (frame: { image: ImageBitmap; capturedAtMs: number }) => void
  ): Promise<Result<void>> {
    this.stop()
    const run = ++this.generation
    try {
      const video = this.options.createVideo()
      video.muted = true
      video.srcObject = stream
      await video.play()
      if (run !== this.generation) {
        video.pause()
        return failure('cancelled', '프레임 수집이 취소되었습니다.')
      }
      this.video = video
    } catch {
      return failure('unavailable', '카메라 영상을 재생하지 못했습니다.')
    }
    this.lastTime = -1
    this.cancel = this.options.every(() => void this.sample(run, onFrame), Math.round(1000 / fps))
    return { ok: true, value: undefined }
  }

  stop(): void {
    this.generation += 1
    this.cancel?.()
    this.cancel = null
    const video = this.video
    this.video = null
    if (video) {
      try {
        video.pause()
        video.srcObject = null
      } catch {
        /* The element may already be gone. */
      }
    }
  }

  private async sample(
    run: number,
    onFrame: (frame: { image: ImageBitmap; capturedAtMs: number }) => void
  ): Promise<void> {
    const video = this.video
    if (!video || this.capturing || video.readyState < 2 || video.currentTime === this.lastTime)
      return
    this.capturing = true
    this.lastTime = video.currentTime
    const capturedAtMs = this.options.now()
    try {
      const image = await this.options.createBitmap(video)
      // Stopped (or restarted) while the picture was being copied: nobody wants it any more.
      if (run !== this.generation) image.close()
      else onFrame({ image, capturedAtMs })
    } catch {
      /* A failed copy only costs this frame. */
    } finally {
      this.capturing = false
    }
  }
}
