import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type { HandTrackingEvent } from '../../shared/contracts/gesture'
import type { HandPreview, MediaCommand, MediaEvent } from '../../shared/ipc/media-api'
import type { LocalExecutionOptions } from '../ports'
import type { SensorPort } from '../sensors/ports'

/** The part of the media bridge hand tracking talks through. */
interface TrackingBridge {
  command(
    command: MediaCommand,
    timeoutMs: number,
    options?: LocalExecutionOptions
  ): Promise<Result<void>>
  subscribe(listener: (event: MediaEvent) => void): Unsubscribe
}

interface HandTrackingServiceOptions {
  sensors: Pick<SensorPort, 'acquire' | 'release' | 'subscribe'>
  bridge: TrackingBridge
  /** The hand landmark model; read by Main so the media page needs no file access. */
  loadModel(): Promise<Result<Uint8Array>>
  /** Loading the engine takes a while on first start. */
  startTimeoutMs?: number
  stopTimeoutMs?: number
  maxFps?: number
}

/** Who the tracking is for. The recognition view yields to the cursor control, which never yields to it. */
export type TrackingOwner = 'gesture_control' | 'diagnostics'

interface Run {
  generation: Generation
  leaseId: string
  lastSequence: number
  ended: boolean
  owner: TrackingOwner
}

/** How a run ended: asked to stop, replaced by the control, or lost (engine, camera, permission). */
export type RunEndReason = 'stopped' | 'preempted' | 'failed'

export type TrackingRunEvent =
  | { type: 'started'; generation: Generation; owner: TrackingOwner }
  /** A start did not come to a run (no model, no camera, no tracker), whoever it was for. */
  | { type: 'start_failed'; owner: TrackingOwner }
  | { type: 'ended'; generation: Generation; owner: TrackingOwner; reason: RunEndReason }

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Owns hand tracking for one gesture session: the camera lease, the tracker in the Media Renderer
 * and the stream of observations coming back. Every way tracking can end — stop, lease revoked,
 * engine failure — releases the camera and, where the renderer cannot say so itself, reports the
 * loss, so the controller above never waits on a stream that is gone.
 */
export class HandTrackingService {
  private run: Run | null = null
  private starting: Promise<unknown> | null = null
  /** A stop that arrived while start was still preparing. */
  private cancelStart = false
  private readonly listeners = new Set<(event: HandTrackingEvent) => void>()
  private readonly previewListeners = new Set<(preview: HandPreview) => void>()
  private readonly runListeners = new Set<(event: TrackingRunEvent) => void>()
  private readonly unsubscribers: Unsubscribe[]

  constructor(private readonly options: HandTrackingServiceOptions) {
    this.unsubscribers = [
      options.bridge.subscribe((event) => this.onMedia(event)),
      options.sensors.subscribe((event) => {
        if (event.type !== 'sensor.lease_revoked') return
        const run = this.run
        if (!run || run.ended || event.lease.leaseId !== run.leaseId) return
        void this.lose(
          run,
          event.error.code === 'permission_denied' ? 'permission_revoked' : 'engine_error'
        )
      })
    ]
  }

  subscribe(listener: (event: HandTrackingEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Preview pictures of the camera, for the recognition view; they come only after `setPreview(true)`. */
  subscribePreview(listener: (preview: HandPreview) => void): Unsubscribe {
    this.previewListeners.add(listener)
    return () => {
      this.previewListeners.delete(listener)
    }
  }

  /** Runs starting and ending, so something that only watches can follow them. */
  subscribeRuns(listener: (event: TrackingRunEvent) => void): Unsubscribe {
    this.runListeners.add(listener)
    return () => {
      this.runListeners.delete(listener)
    }
  }

  isActive(): boolean {
    return this.run !== null && !this.run.ended
  }

  /** The run that is going on, if any. */
  currentRun(): { generation: Generation; owner: TrackingOwner } | null {
    const run = this.run
    return run && !run.ended ? { generation: run.generation, owner: run.owner } : null
  }

  /** Turns the preview pictures of the run that is going on on or off; tracking itself is not touched. */
  async setPreview(enabled: boolean): Promise<Result<void>> {
    const run = this.run
    if (!run || run.ended) return failure('unavailable', '손 인식이 실행 중이 아닙니다.')
    const done = await this.options.bridge.command(
      { type: 'handtracking.preview', generation: run.generation, enabled },
      this.options.stopTimeoutMs ?? 5_000
    )
    return done.ok ? { ok: true, value: undefined } : done
  }

  /**
   * Starts tracking. A run for the recognition view makes way for one for the cursor control, which
   * takes over the camera at once; the other way round, or two of a kind, is a conflict.
   */
  async start(
    generation: Generation,
    execution?: LocalExecutionOptions,
    options?: { owner?: TrackingOwner }
  ): Promise<Result<void>> {
    const owner = options?.owner ?? 'gesture_control'
    if (this.starting) return failure('conflict', '이미 손 인식이 실행 중입니다.')
    if (this.run && !this.run.ended) {
      if (this.run.owner !== 'diagnostics' || owner !== 'gesture_control')
        return failure('conflict', '이미 손 인식이 실행 중입니다.')
      await this.end(this.run, true, 'preempted')
    }
    this.cancelStart = false
    const attempt = this.begin(generation, owner, execution)
    this.starting = attempt
    try {
      const result = await attempt
      if (!result.ok) this.emitRun({ type: 'start_failed', owner })
      return result
    } finally {
      this.starting = null
    }
  }

  async stop(): Promise<void> {
    if (this.starting) this.cancelStart = true
    const run = this.run
    if (run) await this.end(run, true)
  }

  dispose(): void {
    void this.stop()
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.listeners.clear()
    this.previewListeners.clear()
    this.runListeners.clear()
  }

  private async begin(
    generation: Generation,
    owner: TrackingOwner,
    execution?: LocalExecutionOptions
  ): Promise<Result<void>> {
    const cancelled = () => failure('cancelled', '손 인식 시작이 취소되었습니다.')
    const model = await this.options.loadModel()
    if (!model.ok) return model
    if (this.cancelStart) return cancelled()

    const lease = await this.options.sensors.acquire(
      { kind: 'camera', owner, generation },
      execution
    )
    if (!lease.ok) return lease
    if (this.cancelStart) {
      await this.options.sensors.release(lease.value.leaseId).catch(() => undefined)
      return cancelled()
    }
    const run: Run = {
      generation,
      leaseId: lease.value.leaseId,
      lastSequence: -1,
      ended: false,
      owner
    }
    this.run = run

    const started = await this.options.bridge.command(
      {
        type: 'handtracking.start',
        request: {
          generation,
          model: model.value,
          ...(this.options.maxFps ? { maxFps: this.options.maxFps } : {})
        }
      },
      this.options.startTimeoutMs ?? 30_000,
      execution
    )
    // Stopped or lost while starting: whoever ended the run has already cleaned up.
    if (run.ended) return cancelled()
    if (!started.ok) {
      await this.end(run, true, 'failed')
      return started
    }
    this.emitRun({ type: 'started', generation, owner })
    return { ok: true, value: undefined }
  }

  private onMedia(event: MediaEvent): void {
    const run = this.run
    if (!run || run.ended) return
    if (event.type === 'hand.preview') {
      // A picture of an earlier run is history, like any observation of one.
      if (!sameGeneration(event.preview.generation, run.generation)) return
      for (const listener of [...this.previewListeners]) {
        try {
          listener(event.preview)
        } catch {
          /* One observer cannot affect others. */
        }
      }
      return
    }
    if (event.type === 'hand.tracking') {
      const tracked = event.event
      const generation =
        tracked.type === 'tracking.frame' ? tracked.frame.generation : tracked.generation
      // Anything from an earlier run is history.
      if (!sameGeneration(generation, run.generation)) return
      const sequence = tracked.type === 'tracking.frame' ? tracked.frame.sequence : tracked.sequence
      if (tracked.type === 'tracking.frame' && sequence <= run.lastSequence) return
      run.lastSequence = Math.max(run.lastSequence, sequence)
      this.emit(tracked)
      if (
        tracked.type === 'tracking.lost' &&
        tracked.reason !== 'no_hand' &&
        tracked.reason !== 'stale'
      )
        void this.end(run, true, 'failed')
      return
    }
    if (
      event.type === 'handtracking.state' &&
      event.state === 'failed' &&
      sameGeneration(event.generation, run.generation)
    )
      void this.end(run, false, 'failed')
  }

  private async lose(run: Run, reason: 'permission_revoked' | 'engine_error'): Promise<void> {
    if (run.ended) return
    this.emit({
      type: 'tracking.lost',
      generation: run.generation,
      sequence: Math.max(run.lastSequence, 0),
      reason
    })
    await this.end(run, true, 'failed')
  }

  /** `tellRenderer` is false when the renderer is the one that reported the end. */
  private async end(
    run: Run,
    tellRenderer: boolean,
    reason: RunEndReason = 'stopped'
  ): Promise<void> {
    if (run.ended) return
    run.ended = true
    if (this.run === run) this.run = null
    if (tellRenderer)
      await this.options.bridge
        .command(
          { type: 'handtracking.stop', generation: run.generation },
          this.options.stopTimeoutMs ?? 5_000
        )
        .catch(() => undefined)
    await this.options.sensors.release(run.leaseId).catch(() => undefined)
    // Said last, once the camera is given back, so a watcher that starts its own run does not meet this one.
    this.emitRun({ type: 'ended', generation: run.generation, owner: run.owner, reason })
  }

  private emitRun(event: TrackingRunEvent): void {
    for (const listener of [...this.runListeners]) {
      try {
        listener(event)
      } catch {
        /* One observer cannot affect others. */
      }
    }
  }

  private emit(event: HandTrackingEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        /* One observer cannot affect others. */
      }
    }
  }
}
