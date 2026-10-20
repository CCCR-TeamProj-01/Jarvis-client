import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type { HandTrackingEvent } from '../../shared/contracts/gesture'
import type { MediaCommand, MediaEvent } from '../../shared/ipc/media-api'
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

interface Run {
  generation: Generation
  leaseId: string
  lastSequence: number
  ended: boolean
}

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

  isActive(): boolean {
    return this.run !== null && !this.run.ended
  }

  async start(generation: Generation, execution?: LocalExecutionOptions): Promise<Result<void>> {
    if (this.run || this.starting) return failure('conflict', '이미 손 인식이 실행 중입니다.')
    this.cancelStart = false
    const attempt = this.begin(generation, execution)
    this.starting = attempt
    try {
      return await attempt
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
  }

  private async begin(
    generation: Generation,
    execution?: LocalExecutionOptions
  ): Promise<Result<void>> {
    const cancelled = () => failure('cancelled', '손 인식 시작이 취소되었습니다.')
    const model = await this.options.loadModel()
    if (!model.ok) return model
    if (this.cancelStart) return cancelled()

    const lease = await this.options.sensors.acquire(
      { kind: 'camera', owner: 'gesture_control', generation },
      execution
    )
    if (!lease.ok) return lease
    if (this.cancelStart) {
      await this.options.sensors.release(lease.value.leaseId).catch(() => undefined)
      return cancelled()
    }
    const run: Run = { generation, leaseId: lease.value.leaseId, lastSequence: -1, ended: false }
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
      await this.end(run, true)
      return started
    }
    return { ok: true, value: undefined }
  }

  private onMedia(event: MediaEvent): void {
    const run = this.run
    if (!run || run.ended) return
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
        void this.end(run, true)
      return
    }
    if (
      event.type === 'handtracking.state' &&
      event.state === 'failed' &&
      sameGeneration(event.generation, run.generation)
    )
      void this.end(run, false)
  }

  private async lose(run: Run, reason: 'permission_revoked' | 'engine_error'): Promise<void> {
    if (run.ended) return
    this.emit({
      type: 'tracking.lost',
      generation: run.generation,
      sequence: Math.max(run.lastSequence, 0),
      reason
    })
    await this.end(run, true)
  }

  /** `tellRenderer` is false when the renderer is the one that reported the end. */
  private async end(run: Run, tellRenderer: boolean): Promise<void> {
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
