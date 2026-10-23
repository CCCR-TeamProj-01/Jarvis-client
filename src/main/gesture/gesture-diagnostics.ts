import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type { HandTrackingEvent } from '../../shared/contracts/gesture'
import type {
  DiagnosticsCommandRequest,
  DiagnosticsEvent,
  DiagnosticsPicture,
  DiagnosticsSnapshot
} from '../../shared/contracts/gesture-diagnostics'
import type { HandPreview } from '../../shared/ipc/media-api'
import { HandAnalyser, thresholdsOf } from './hand-analysis'
import type { HandTrackingService } from './hand-tracking'
import { DEFAULT_TUNING } from './tuning'
import type { GestureTuning } from './tuning'

/** What the gesture tab's recognition view talks to; the window reaches it only through IPC. */
export interface GestureDiagnosticsPort {
  getSnapshot(): DiagnosticsSnapshot
  subscribe(listener: (event: DiagnosticsEvent) => void): Unsubscribe
  command(request: DiagnosticsCommandRequest): Promise<Result<DiagnosticsSnapshot>>
}

type Tracking = Pick<
  HandTrackingService,
  | 'start'
  | 'stop'
  | 'subscribe'
  | 'subscribePreview'
  | 'subscribeRuns'
  | 'setPreview'
  | 'currentRun'
>

export interface GestureDiagnosticsOptions {
  tracking: Tracking
  /** Main's own sign-in and pause state, read when the view starts. */
  gate: { check(): Result<void> }
  createId(): string
  tuning?: Partial<GestureTuning>
}

const noUser = {
  ok: false,
  error: {
    code: 'authentication_required',
    message: '로그인한 뒤에 손 인식을 확인할 수 있어요.'
  }
} as const

/** Previews wait here for the observation of the same picture; older ones are not worth keeping. */
const MAX_WAITING_PREVIEWS = 4

const STOPPED_BY_FAILURE: ClientError = {
  code: 'unavailable',
  message:
    '손 인식이 중단되어 인식 확인을 멈췄어요. 카메라 권한과 다른 앱의 카메라 사용을 확인해 주세요.'
}

/**
 * The recognition view: the camera picture with the hands the app sees on it, and how it judges
 * them. It follows whatever hand tracking is going on: when the cursor control is running it only
 * watches (the camera is not opened again), and when nothing is it runs the tracking itself, without
 * ever moving the pointer. The cursor control takes the camera from it when it starts and the view
 * carries on watching afterwards, and when the control stops the view takes the tracking back.
 *
 * Camera pictures are made only while the view is on, go to the window through Main and nowhere else,
 * and are not kept. Signing out, or another account signing in, ends the view.
 */
export class GestureDiagnostics implements GestureDiagnosticsPort {
  private userId: string | null = null
  private revision = 0
  private state: DiagnosticsSnapshot['state'] = 'off'
  private source: DiagnosticsSnapshot['source'] = null
  private preview = false
  private error: ClientError | null = null
  /** The user asked for the view and has not turned it off. */
  private wanted = false
  private attached: Generation | null = null
  private analyser: HandAnalyser
  private readonly pictures = new Map<number, DiagnosticsPicture>()
  /** Work on the tracking runs one step at a time. */
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(event: DiagnosticsEvent) => void>()
  private readonly unsubscribers: Unsubscribe[]
  private readonly tuning: GestureTuning

  constructor(private readonly options: GestureDiagnosticsOptions) {
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning }
    this.analyser = new HandAnalyser(this.tuning)
    this.unsubscribers = [
      options.tracking.subscribe((event) => this.onTracking(event)),
      options.tracking.subscribePreview((preview) => this.onPreview(preview)),
      options.tracking.subscribeRuns((event) => {
        if (event.type === 'ended') this.onEnded(event.generation, event.reason)
        else if (event.owner !== 'gesture_control') return
        else this.onControlRunChanged()
      })
    ]
  }

  start(userId: string): void {
    if (this.userId === userId) return
    const switching = this.userId !== null
    this.userId = userId
    if (switching) this.turnOff(null)
  }

  async stop(): Promise<void> {
    if (this.userId === null) return
    this.userId = null
    await this.release()
    this.turnOff(null)
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers.length = 0
    this.listeners.clear()
    void this.release()
  }

  getSnapshot(): DiagnosticsSnapshot {
    return {
      revision: this.revision,
      availability: 'ready',
      state: this.state,
      source: this.source,
      preview: this.preview,
      error: this.error,
      thresholds: thresholdsOf(this.tuning)
    }
  }

  subscribe(listener: (event: DiagnosticsEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async command(request: DiagnosticsCommandRequest): Promise<Result<DiagnosticsSnapshot>> {
    if (this.userId === null) return noUser
    if (request.action === 'start') {
      const allowed = this.options.gate.check()
      if (!allowed.ok) return allowed
      this.wanted = true
      this.error = null
      await this.enqueue(() => this.follow())
    } else {
      // Nothing more is wanted at once, so nothing that is going on takes the tracking up again.
      this.wanted = false
      await this.enqueue(() => this.release())
      this.turnOff(null)
    }
    return { ok: true, value: this.getSnapshot() }
  }

  // --- following the tracking ------------------------------------------------------------------

  /** Shows the run that is going on, or starts one of its own when there is none. */
  private async follow(): Promise<void> {
    if (!this.wanted || this.userId === null) return
    const run = this.options.tracking.currentRun()
    if (run) {
      // Already showing this run.
      if (this.attached && sameGeneration(this.attached, run.generation)) return
      return this.attach(run.generation, run.owner === 'diagnostics' ? 'own' : 'control')
    }
    this.state = 'starting'
    this.changed()
    const generation: Generation = { sessionId: `diag-${this.options.createId()}`, revision: 1 }
    const started = await this.options.tracking.start(generation, undefined, {
      owner: 'diagnostics'
    })
    if (!this.wanted || this.userId === null) {
      // Turned off, or signed out, while the camera was being opened.
      if (started.ok) await this.options.tracking.stop().catch(() => undefined)
      return
    }
    if (!started.ok) {
      if (started.error.code === 'conflict') {
        // The cursor control has the camera, or is about to: then it is what is shown, as soon as it runs.
        const taken = this.options.tracking.currentRun()
        if (taken) return this.attach(taken.generation, 'control')
        this.state = 'starting'
        this.changed()
        return
      }
      return this.fail(started.error)
    }
    await this.attach(generation, 'own')
  }

  private async attach(generation: Generation, source: 'own' | 'control'): Promise<void> {
    this.attached = generation
    this.analyser.reset()
    this.pictures.clear()
    this.source = source
    this.state = 'on'
    this.error = null
    // Without pictures the hands are still drawn, on a plain background.
    const turned = await this.options.tracking.setPreview(true)
    // Another run, or none, took over while the preview was being asked for.
    if (!this.attached || !sameGeneration(this.attached, generation)) return
    this.preview = turned.ok
    this.changed()
  }

  /** Stops showing, gives back a camera the view opened itself, and turns the pictures off. */
  private async release(): Promise<void> {
    const generation = this.attached
    const own = this.source === 'own'
    this.attached = null
    this.pictures.clear()
    if (!generation) return
    if (own) await this.options.tracking.stop().catch(() => undefined)
    else await this.options.tracking.setPreview(false).catch(() => undefined)
  }

  private onEnded(generation: Generation, reason: 'stopped' | 'preempted' | 'failed'): void {
    if (this.attached && sameGeneration(this.attached, generation)) {
      const watching = this.source === 'control'
      this.attached = null
      this.pictures.clear()
      this.preview = false
      this.source = null
      // Its own tracking failing ends the view. The control's failing is the control's: the view tries its own.
      if (reason === 'failed' && !watching) {
        this.fail(STOPPED_BY_FAILURE)
        return
      }
      // A run replaced by the cursor control is followed by the control's own; any other end is the control stopping.
      this.state = this.wanted ? 'starting' : 'off'
      this.changed()
    }
    // The tracking is gone and the view is still wanted: take it up again (or follow the next run).
    if (this.wanted && this.userId !== null && !this.attached && reason !== 'preempted')
      void this.enqueue(() => this.follow())
  }

  /**
   * The cursor control started a run (that is the one to show from now on), or its start came to
   * nothing (the view, which it displaced, takes up its own again). Either way `follow` finds out which.
   */
  private onControlRunChanged(): void {
    if (!this.wanted || this.userId === null) return
    void this.enqueue(() => this.follow())
  }

  private fail(error: ClientError): void {
    this.wanted = false
    this.attached = null
    this.preview = false
    this.source = null
    this.state = 'failed'
    this.error = error
    this.changed()
  }

  /** The view is over for now: off, with nothing wanted, and no error unless one is given. */
  private turnOff(error: ClientError | null): void {
    this.wanted = false
    this.preview = false
    this.source = null
    this.state = 'off'
    this.error = error
    this.analyser.reset()
    this.changed()
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  // --- what the tracking says ------------------------------------------------------------------

  private onPreview(preview: HandPreview): void {
    if (!this.attached || !sameGeneration(preview.generation, this.attached)) return
    this.pictures.set(preview.sequence, {
      width: preview.width,
      height: preview.height,
      jpeg: preview.jpeg
    })
    // Pictures come a little before the hands found on them; those that never got theirs are dropped.
    while (this.pictures.size > MAX_WAITING_PREVIEWS) {
      const oldest = this.pictures.keys().next().value
      if (oldest === undefined) break
      this.pictures.delete(oldest)
    }
  }

  private onTracking(event: HandTrackingEvent): void {
    if (event.type !== 'tracking.frame') return
    const frame = event.frame
    if (!this.attached || !sameGeneration(frame.generation, this.attached)) return
    const hands = this.analyser.analyse(frame)
    const picture = this.pictures.get(frame.sequence) ?? null
    this.emit({
      type: 'gesture_diagnostics.frame',
      frame: { sequence: frame.sequence, hands, fps: this.analyser.fps(), picture }
    })
  }

  private changed(): void {
    this.revision += 1
    this.emit({ type: 'gesture_diagnostics.state_changed', snapshot: this.getSnapshot() })
  }

  private emit(event: DiagnosticsEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        /* A listener that fails must not stop the others. */
      }
    }
  }
}

/**
 * Used when there is no way to run hand tracking: the view says so instead of offering to start.
 */
export class UnavailableGestureDiagnostics implements GestureDiagnosticsPort {
  private readonly snapshot: DiagnosticsSnapshot = {
    revision: 0,
    availability: 'unavailable',
    state: 'off',
    source: null,
    preview: false,
    error: null,
    thresholds: thresholdsOf()
  }

  getSnapshot(): DiagnosticsSnapshot {
    return this.snapshot
  }

  subscribe(): Unsubscribe {
    return () => undefined
  }

  async command(): Promise<Result<DiagnosticsSnapshot>> {
    return { ok: true, value: this.snapshot }
  }
}
