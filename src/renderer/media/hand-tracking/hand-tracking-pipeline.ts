import type { ClientError, Generation, Result } from '../../../shared/contracts/common'
import { sameGeneration } from '../../../shared/contracts/common'
import type { HandTrackingStart, MediaEvent } from '../../../shared/ipc/media-api'
import type { HandTrackerPort } from './ports'
import type { FrameSource } from './video-frame-source'

const DEFAULT_FPS = 30
/** A few bad frames are noise; this many in a row means the engine is not coming back. */
const MAX_CONSECUTIVE_ERRORS = 5

export interface TrackerHandle extends HandTrackerPort {
  whenReady(): Promise<Result<void>>
}

/** A small JPEG of a camera picture, for the screen. */
export interface PreviewPicture {
  width: number
  height: number
  jpeg: Uint8Array
}

export interface PreviewEncoder {
  /**
   * Copies the picture at once, before the bitmap is handed on and gone, and gives the small JPEG
   * when it is ready. Null when no picture could be made; it costs only that preview.
   */
  capture(image: ImageBitmap): Promise<PreviewPicture | null>
}

interface PipelineOptions {
  source: FrameSource
  createTracker(model: Uint8Array): TrackerHandle
  publish(event: MediaEvent): void
  /** Without it, previews are never made. */
  preview?: PreviewEncoder
  /** The least time between two previews. */
  previewIntervalMs?: number
}

interface Run {
  generation: Generation
  tracker: TrackerHandle
  sequence: number
  inFlight: boolean
  waiting: { image: ImageBitmap; capturedAtMs: number } | null
  errors: number
  ended: boolean
  /** Preview pictures are being made. */
  preview: boolean
  lastPreviewAtMs: number
  /** A preview is still being encoded; no second one is started until it is done. */
  encoding: boolean
}

/** About thirty a second at most: the picture and the hands found on it go together, frame by frame. */
const DEFAULT_PREVIEW_INTERVAL_MS = 33

/** What the media controller needs from hand tracking. */
export interface HandTrackingControl {
  start(stream: unknown, request: HandTrackingStart): Promise<Result<null>>
  /** Turns the preview pictures of the run of `generation` on or off. */
  setPreview(generation: Generation, enabled: boolean): boolean
  stop(generation?: Generation): Promise<void>
  cameraLost(error: ClientError): Promise<void>
  dispose(): Promise<void>
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Camera picture → hand observations, as fast as the engine can keep up. Only the newest picture
 * waits behind the one being analysed; older ones are dropped, so latency never builds up.
 */
export class HandTrackingPipeline implements HandTrackingControl {
  private run: Run | null = null

  constructor(private readonly options: PipelineOptions) {}

  async start(stream: unknown, request: HandTrackingStart): Promise<Result<null>> {
    await this.end()
    const tracker = this.options.createTracker(request.model)
    const run: Run = {
      generation: request.generation,
      tracker,
      sequence: 0,
      inFlight: false,
      waiting: null,
      errors: 0,
      ended: false,
      preview: false,
      lastPreviewAtMs: Number.NEGATIVE_INFINITY,
      encoding: false
    }
    this.run = run
    tracker.reset(request.generation)

    const ready = await tracker.whenReady()
    if (this.run !== run) return failure('cancelled', '손 인식 시작이 취소되었습니다.')
    if (!ready.ok) {
      await this.finish(run)
      return ready
    }
    const started = await this.options.source.start(
      stream,
      { fps: request.maxFps ?? DEFAULT_FPS },
      (frame) => this.accept(run, frame)
    )
    if (this.run !== run) {
      if (started.ok) this.options.source.stop()
      return failure('cancelled', '손 인식 시작이 취소되었습니다.')
    }
    if (!started.ok) {
      await this.finish(run)
      return started
    }
    this.options.publish({
      type: 'handtracking.state',
      generation: request.generation,
      state: 'started'
    })
    return { ok: true, value: null }
  }

  /** Stops if `generation` is the current run (or when none is given). */
  async stop(generation?: Generation): Promise<void> {
    const run = this.run
    if (!run || (generation && !sameGeneration(run.generation, generation))) return
    await this.finish(run)
    this.options.publish({
      type: 'handtracking.state',
      generation: run.generation,
      state: 'stopped'
    })
  }

  setPreview(generation: Generation, enabled: boolean): boolean {
    const run = this.run
    // Only a preview for the run that is going on, and only when pictures can be made at all.
    if (!run || run.ended || !sameGeneration(run.generation, generation)) return false
    if (enabled && !this.options.preview) return false
    run.preview = enabled
    run.lastPreviewAtMs = Number.NEGATIVE_INFINITY
    run.encoding = false
    return true
  }

  /** The camera went away underneath the tracker. */
  async cameraLost(error: ClientError): Promise<void> {
    const run = this.run
    if (!run) return
    await this.finish(run)
    this.options.publish({
      type: 'hand.tracking',
      event: {
        type: 'tracking.lost',
        generation: run.generation,
        sequence: run.sequence,
        reason: error.code === 'permission_denied' ? 'permission_revoked' : 'engine_error'
      }
    })
    this.options.publish({
      type: 'handtracking.state',
      generation: run.generation,
      state: 'failed',
      error
    })
  }

  async dispose(): Promise<void> {
    await this.end()
  }

  private async end(): Promise<void> {
    const run = this.run
    if (run) await this.finish(run)
  }

  private async finish(run: Run): Promise<void> {
    if (run.ended) return
    run.ended = true
    if (this.run === run) this.run = null
    this.options.source.stop()
    run.waiting?.image.close()
    run.waiting = null
    await run.tracker.dispose()
  }

  private accept(run: Run, frame: { image: ImageBitmap; capturedAtMs: number }): void {
    if (run.ended) {
      frame.image.close()
      return
    }
    // Newest wins: a picture still waiting is already out of date.
    run.waiting?.image.close()
    run.waiting = frame
    if (!run.inFlight) void this.drain(run)
  }

  private async drain(run: Run): Promise<void> {
    run.inFlight = true
    try {
      while (!run.ended && run.waiting) {
        const { image, capturedAtMs } = run.waiting
        run.waiting = null
        const sequence = ++run.sequence
        // The picture is copied now, before detection takes the bitmap; the JPEG follows on its own.
        this.preview(run, image, sequence, capturedAtMs)
        const result = await run.tracker.detect({
          generation: run.generation,
          sequence,
          capturedAtMs,
          image
        })
        if (run.ended) return
        if (result.ok) {
          run.errors = 0
          this.options.publish({
            type: 'hand.tracking',
            event: { type: 'tracking.frame', frame: result.value }
          })
        } else if (++run.errors >= MAX_CONSECUTIVE_ERRORS) {
          await this.fail(run, result.error)
          return
        }
      }
    } finally {
      run.inFlight = false
    }
  }

  private preview(run: Run, image: ImageBitmap, sequence: number, capturedAtMs: number): void {
    const encoder = this.options.preview
    // A slow encoder skips pictures; it never builds up a queue of them.
    if (!run.preview || !encoder || run.encoding) return
    if (
      capturedAtMs - run.lastPreviewAtMs <
      (this.options.previewIntervalMs ?? DEFAULT_PREVIEW_INTERVAL_MS)
    )
      return
    run.lastPreviewAtMs = capturedAtMs
    run.encoding = true
    void encoder
      .capture(image)
      .finally(() => {
        run.encoding = false
      })
      .then((picture) => {
        // Turned off, or the run ended, while the picture was being encoded: nobody wants it now.
        if (!picture || run.ended || !run.preview) return
        this.options.publish({
          type: 'hand.preview',
          preview: { generation: run.generation, sequence, ...picture }
        })
      })
      .catch(() => undefined)
  }

  private async fail(run: Run, error: ClientError): Promise<void> {
    await this.finish(run)
    this.options.publish({
      type: 'hand.tracking',
      event: {
        type: 'tracking.lost',
        generation: run.generation,
        sequence: run.sequence,
        reason: 'engine_error'
      }
    })
    this.options.publish({
      type: 'handtracking.state',
      generation: run.generation,
      state: 'failed',
      error
    })
  }
}
