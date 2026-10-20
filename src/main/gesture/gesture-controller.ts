import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type {
  ActiveHandPolicy,
  DesktopPoint,
  DisplayBounds,
  GestureSnapshot,
  HandTrackingEvent,
  HandTrackingFrame
} from '../../shared/contracts/gesture'
import type { InputExecutionOptions, PointerInputPort } from '../platform/ports'
import type { LocalExecutionOptions, MonotonicClock } from '../ports'
import { ActiveHandSelector } from './active-hand'
import { toDesktopPoint, toRegionPosition } from './cursor-mapper'
import { FrameClock } from './frame-clock'
import { OneEuroFilter2D } from './one-euro-filter'
import { PinchDetector, pinchRatio } from './pinch-detector'
import type { GestureControlPort, HandTrackingSource, InputPermissionPort } from './ports'
import { DEFAULT_TUNING } from './tuning'
import type { GestureTuning } from './tuning'

/**
 * The cursor follows the index knuckle, not the fingertip: when the thumb comes to meet the index
 * finger the tip moves with it, which would pull the cursor off its target just as the click
 * happens. The knuckle stays where it is while the fingers close.
 */
const POINTER_JOINT = 5
/** How often a running session re-checks that the OS still lets it move the pointer. */
const PERMISSION_RECHECK_MS = 2_000

interface GestureControllerOptions {
  tracking: HandTrackingSource
  pointer: PointerInputPort
  permission: InputPermissionPort
  /** Main's own sign-in and pause state, read when the mode starts. */
  gate: { check(): Result<void> }
  clock: MonotonicClock
  /** Returns a cancel function. Injected so timeouts can be tested without real timers. */
  schedule(callback: () => void, delayMs: number): () => void
  createId(): string
  tuning?: Partial<GestureTuning>
}

type QueuedInput = { kind: 'move'; point: DesktopPoint } | { kind: 'click'; point: DesktopPoint }

interface Session {
  generation: Generation
  display: DisplayBounds
  selector: ActiveHandSelector
  filter: OneEuroFilter2D
  pinch: PinchDetector
  frameClock: FrameClock
  phase: 'tracking' | 'lost'
  lastSequence: number
  inputSequence: number
  lastSent: DesktopPoint | null
  history: { atMs: number; point: DesktopPoint }[]
  lostSinceMs: number | null
  queue: QueuedInput[]
  pumping: boolean
  cancelWatchdog: (() => void) | null
  lastPermissionCheckMs: number
  ratios: { atMs: number; ratio: number }[]
  closing: boolean
  holdMovesUntilMs: number
  stopTracking: Unsubscribe
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

const OFF: GestureSnapshot = { phase: 'off', generation: null, activeHandId: null, displayId: null }

/**
 * Turns hand observations into pointer input for one gesture session. It owns the session's
 * generation: once the session ends nothing from it is acted on, whatever frames or queued
 * inputs are still on their way. A lost hand stops all input and, when it returns, the mode
 * resumes from a neutral state (cursor follows again, but a pinch must be released first) with
 * nothing replayed.
 */
export class GestureController implements GestureControlPort {
  private session: Session | null = null
  private starting = false
  private cancelStart = false
  private snapshot: GestureSnapshot = OFF
  private readonly listeners = new Set<(snapshot: GestureSnapshot) => void>()
  private readonly problemListeners = new Set<(error: ClientError) => void>()
  private readonly tuning: GestureTuning

  constructor(private readonly options: GestureControllerOptions) {
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning }
  }

  getSnapshot(): GestureSnapshot {
    return structuredClone(this.snapshot)
  }

  subscribe(listener: (snapshot: GestureSnapshot) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeProblems(listener: (error: ClientError) => void): Unsubscribe {
    this.problemListeners.add(listener)
    return () => {
      this.problemListeners.delete(listener)
    }
  }

  async start(
    settings: { activeHand: ActiveHandPolicy; displayId: string },
    execution?: LocalExecutionOptions
  ): Promise<Result<Generation>> {
    if (this.session || this.starting)
      return failure('conflict', '제스처 제어가 이미 실행 중입니다.')
    const allowed = this.options.gate.check()
    if (!allowed.ok) return allowed
    if (!this.options.permission.isGranted()) {
      this.options.permission.request()
      return failure(
        'permission_denied',
        '커서를 움직이려면 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 자비스를 허용해 주세요. 허용한 뒤 다시 시작해 주세요.'
      )
    }
    this.starting = true
    this.cancelStart = false
    try {
      return await this.begin(settings, execution)
    } finally {
      this.starting = false
    }
  }

  async stop(): Promise<Result<void>> {
    if (this.starting) this.cancelStart = true
    await this.end(null)
    return { ok: true, value: undefined }
  }

  acceptTracking(event: HandTrackingEvent): void {
    const session = this.session
    if (!session) return
    if (event.type === 'tracking.frame') {
      this.onFrame(session, event.frame)
      return
    }
    if (!sameGeneration(event.generation, session.generation)) return
    if (event.reason === 'no_hand' || event.reason === 'stale') this.markLost(session, true)
    else
      void this.end(
        event.reason === 'permission_revoked'
          ? {
              code: 'permission_denied',
              message: '카메라 권한이 철회되어 제스처 제어를 중지했습니다.'
            }
          : {
              code: 'device_unavailable',
              message: '손 인식이 중단되어 제스처 제어를 중지했습니다.'
            }
      )
  }

  // --- start and end ---------------------------------------------------------------------------

  private async begin(
    settings: { activeHand: ActiveHandPolicy; displayId: string },
    execution?: LocalExecutionOptions
  ): Promise<Result<Generation>> {
    const displays = await this.options.pointer.getDisplays()
    if (!displays.ok) return displays
    // "primary" (or an unknown id) means the first display, which the pointer port lists first.
    const display =
      displays.value.find((candidate) => candidate.displayId === settings.displayId) ??
      displays.value[0]
    if (!display) return failure('unavailable', '사용할 화면이 없습니다.')

    const generation: Generation = { sessionId: `gesture-${this.options.createId()}`, revision: 1 }
    const session: Session = {
      generation,
      display,
      selector: new ActiveHandSelector(settings.activeHand),
      filter: new OneEuroFilter2D(this.tuning.smoothing),
      pinch: new PinchDetector(this.tuning.pinch),
      frameClock: new FrameClock(),
      phase: 'lost',
      lastSequence: -1,
      inputSequence: 0,
      lastSent: null,
      history: [],
      lostSinceMs: null,
      queue: [],
      pumping: false,
      cancelWatchdog: null,
      lastPermissionCheckMs: this.options.clock.now(),
      ratios: [],
      closing: false,
      holdMovesUntilMs: 0,
      stopTracking: () => undefined
    }
    this.session = session
    session.stopTracking = this.options.tracking.subscribe((event) => this.acceptTracking(event))
    this.publish(session)

    const started = await this.options.tracking.start(generation, execution)
    if (this.cancelStart || this.session !== session) {
      if (this.session === session) await this.end(null)
      else await this.options.tracking.stop()
      return failure('cancelled', '제스처 시작이 취소되었습니다.')
    }
    if (!started.ok) {
      await this.end(null)
      return started
    }
    this.armWatchdog(session)
    return { ok: true, value: generation }
  }

  private async end(problem: ClientError | null): Promise<void> {
    const session = this.session
    if (!session) {
      // A stop that arrives while the engine is still starting has nothing to end yet.
      return
    }
    // The generation is invalidated first, so frames and queued inputs still on their way are ignored.
    this.session = null
    session.stopTracking()
    session.cancelWatchdog?.()
    session.queue = []
    this.snapshot = OFF
    this.emitSnapshot()
    await this.options.pointer.cancelGeneration(session.generation).catch(() => undefined)
    await this.options.pointer.releaseOwnedInputs().catch(() => undefined)
    await this.options.tracking.stop().catch(() => undefined)
    if (problem) for (const listener of [...this.problemListeners]) safely(() => listener(problem))
  }

  // --- frames ----------------------------------------------------------------------------------

  private onFrame(session: Session, frame: HandTrackingFrame): void {
    if (this.session !== session || !sameGeneration(frame.generation, session.generation)) return
    if (frame.sequence <= session.lastSequence) return
    session.lastSequence = frame.sequence
    const nowMs = this.options.clock.now()
    // A late frame says where the hand was, not where it is; acting on it would drag the cursor.
    if (session.frameClock.age(frame.capturedAtMs, nowMs) > this.tuning.maxFrameAgeMs) return
    this.armWatchdog(session)
    if (nowMs - session.lastPermissionCheckMs >= PERMISSION_RECHECK_MS) {
      session.lastPermissionCheckMs = nowMs
      if (!this.options.permission.isGranted()) {
        void this.end({
          code: 'permission_denied',
          message: '손쉬운 사용 권한이 철회되어 제스처 제어를 중지했습니다.'
        })
        return
      }
    }

    const hand = session.selector.select(frame.hands)
    if (!hand) {
      this.markLost(session, false, frame.capturedAtMs)
      return
    }
    const tip = hand.landmarks[POINTER_JOINT]
    if (!tip) return

    if (session.phase === 'lost') {
      // Back from a loss: start from nothing, as if the hand had just appeared.
      session.filter.reset()
      session.pinch.reset()
      session.history = []
      session.ratios = []
      session.closing = false
      session.holdMovesUntilMs = 0
      session.lastSent = null
      session.lostSinceMs = null
      session.phase = 'tracking'
    }
    this.publish(session, hand.handId)

    const smoothed = session.filter.filter(
      toRegionPosition(tip, this.tuning.region),
      frame.capturedAtMs
    )
    const point = toDesktopPoint(smoothed, session.display)
    session.history.push({ atMs: frame.capturedAtMs, point })
    const horizon = frame.capturedAtMs - this.tuning.pinchLookbackMs * 4
    while (session.history.length > 1 && (session.history[0]?.atMs ?? 0) < horizon)
      session.history.shift()

    const ratio = pinchRatio(hand)
    const closing = this.isClosing(session, frame.capturedAtMs, ratio)
    const transition = session.pinch.update(ratio)
    if (transition === 'started') {
      // If the fingers were seen closing the cursor has already held still, and the click goes
      // exactly there. Otherwise (a sudden pinch) it goes where the cursor was just before.
      const target =
        session.closing && session.lastSent
          ? session.lastSent
          : this.pointBefore(session, frame.capturedAtMs)
      this.enqueue(session, { kind: 'click', point: target })
      session.lastSent = target
      session.closing = false
      return
    }
    if (transition === 'ended')
      session.holdMovesUntilMs = frame.capturedAtMs + this.tuning.closing.releaseHoldMs
    session.closing = closing
    // While the fingers are closing, together or opening, the cursor stays where the click goes.
    if (closing || session.pinch.isPinched || frame.capturedAtMs < session.holdMovesUntilMs) return
    const last = session.lastSent
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < this.tuning.deadZonePx) return
    session.lastSent = point
    this.enqueue(session, { kind: 'move', point })
  }

  /** The pinch ratio has fallen quickly lately: the fingers are on their way together. */
  private isClosing(session: Session, atMs: number, ratio: number | null): boolean {
    if (ratio === null) return session.closing
    const { drop, windowMs } = this.tuning.closing
    session.ratios.push({ atMs, ratio })
    while (session.ratios.length > 1 && (session.ratios[0]?.atMs ?? 0) < atMs - windowMs)
      session.ratios.shift()
    if (session.pinch.isPinched) return false
    return Math.max(...session.ratios.map((entry) => entry.ratio)) - ratio > drop
  }

  /** Where the cursor was just before the fingers began to close, so the click lands on target. */
  private pointBefore(session: Session, atMs: number): DesktopPoint {
    const cutoff = atMs - this.tuning.pinchLookbackMs
    let chosen = session.history[0]
    for (const entry of session.history) if (entry.atMs <= cutoff) chosen = entry
    return (chosen ?? session.history[session.history.length - 1])!.point
  }

  private markLost(session: Session, immediate: boolean, frameTimeMs?: number): void {
    if (this.session !== session) return
    session.queue = []
    if (session.phase === 'tracking') {
      session.phase = 'lost'
      session.filter.reset()
      session.pinch.reset()
      session.lastSent = null
      session.lostSinceMs = frameTimeMs ?? null
      void this.options.pointer.releaseOwnedInputs().catch(() => undefined)
      this.publish(session)
    }
    // The chosen hand has been gone long enough that another hand may take over.
    if (
      immediate ||
      (frameTimeMs !== undefined &&
        session.lostSinceMs !== null &&
        frameTimeMs - session.lostSinceMs >= this.tuning.lostAfterMs)
    )
      session.selector.reset()
    if (frameTimeMs !== undefined && session.lostSinceMs === null) session.lostSinceMs = frameTimeMs
  }

  private armWatchdog(session: Session): void {
    session.cancelWatchdog?.()
    session.cancelWatchdog = this.options.schedule(
      () => this.markLost(session, true),
      this.tuning.lostAfterMs
    )
  }

  // --- input -----------------------------------------------------------------------------------

  private enqueue(session: Session, input: QueuedInput): void {
    if (input.kind === 'move') {
      // Only the newest move matters; anything older still waiting is replaced.
      const tail = session.queue[session.queue.length - 1]
      if (tail?.kind === 'move') session.queue[session.queue.length - 1] = input
      else session.queue.push(input)
    } else {
      session.queue = session.queue.filter((queued) => queued.kind !== 'move')
      session.queue.push(input)
    }
    if (!session.pumping) void this.pump(session)
  }

  private async pump(session: Session): Promise<void> {
    session.pumping = true
    try {
      while (this.session === session) {
        const input = session.queue.shift()
        if (!input) return
        const moved = await this.send(session, (options) =>
          this.options.pointer.moveTo(input.point, options)
        )
        if (!moved) return
        if (input.kind === 'click' && this.session === session)
          if (!(await this.send(session, (options) => this.options.pointer.click(options)))) return
      }
    } finally {
      session.pumping = false
    }
  }

  /** Runs one pointer call; false means the session was ended because the OS refused input. */
  private async send(
    session: Session,
    call: (options: InputExecutionOptions) => Promise<Result<unknown>>
  ): Promise<boolean> {
    const result = await call({
      generation: session.generation,
      sequence: ++session.inputSequence,
      deadlineMs: this.options.clock.now() + this.tuning.inputDeadlineMs
    })
    if (result.ok || this.session !== session) return true
    // Late, superseded or cancelled inputs are normal; only a refusal by the OS ends the mode.
    if (result.error.code === 'permission_denied') {
      void this.end(result.error)
      return false
    }
    return true
  }

  // --- state -----------------------------------------------------------------------------------

  private publish(session: Session, activeHandId?: string): void {
    const next: GestureSnapshot = {
      phase: session.phase,
      generation: session.generation,
      activeHandId:
        session.phase === 'tracking' ? (activeHandId ?? session.selector.activeHandId) : null,
      displayId: session.display.displayId
    }
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return
    this.snapshot = next
    this.emitSnapshot()
  }

  private emitSnapshot(): void {
    for (const listener of [...this.listeners]) safely(() => listener(this.getSnapshot()))
  }
}

function safely(action: () => void): void {
  try {
    action()
  } catch {
    /* One observer cannot affect others. */
  }
}
