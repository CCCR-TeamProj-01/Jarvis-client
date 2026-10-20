import type { ClientError, Generation, Result } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type { DesktopPoint, DisplayBounds, InputObservation } from '../../shared/contracts/gesture'
import type { MonotonicClock } from '../ports'
import type { InputExecutionOptions, PointerInputPort } from './ports'

/** The operating system's pointer, in the global logical coordinates the rest of the app uses. */
export interface PointerDriver {
  moveTo(point: { x: number; y: number }): void
  /** A single press and release of the primary button at the current position. */
  click(): void
  position(): { x: number; y: number }
}

export interface DisplaySource {
  /** The primary display first. */
  list(): DisplayBounds[]
}

interface PointerInputOptions {
  driver: PointerDriver
  displays: DisplaySource
  clock: MonotonicClock
  /**
   * Hand tracking delivers a new target some 25 times a second, which looks like stepping if the
   * pointer simply jumps to each. With this the pointer glides towards the newest target between
   * updates, many times a second. Without it every move is applied at once.
   */
  glide?: {
    /** Returns a cancel function. Injected so the animation can be tested without real timers. */
    schedule(callback: () => void, delayMs: number): () => void
    intervalMs: number
    /** How quickly the pointer closes in on the target: it covers 63 % of the gap in this time. */
    timeConstantMs: number
  }
}

interface Glide {
  target: { x: number; y: number }
  current: { x: number; y: number }
  atMs: number
  generation: Generation
  cancel: (() => void) | null
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Turns the controller's intentions into OS pointer calls, after checking that each one is still
 * wanted: its generation has not been cancelled, it is newer than what already ran, and its
 * deadline has not passed. The pointer is only ever moved and clicked here; no button is held, so
 * there is nothing of ours to leave pressed.
 */
export class PointerInput implements PointerInputPort {
  private cancelled: Generation[] = []
  private lastSequence = new Map<string, number>()
  private glide: Glide | null = null

  constructor(private readonly options: PointerInputOptions) {}

  async getDisplays(): Promise<Result<DisplayBounds[]>> {
    try {
      const displays = this.options.displays.list()
      return displays.length > 0
        ? { ok: true, value: displays }
        : failure('unavailable', '화면 정보를 가져오지 못했습니다.')
    } catch {
      return failure('unavailable', '화면 정보를 가져오지 못했습니다.')
    }
  }

  async moveTo(
    point: DesktopPoint,
    options: InputExecutionOptions
  ): Promise<Result<InputObservation>> {
    const refused = this.refuse(options)
    if (refused) return refused
    const display = this.options.displays.list().find((d) => d.displayId === point.displayId)
    if (!display) return failure('not_found', '대상 화면을 찾을 수 없습니다.')
    const target = {
      x: clamp(point.x, display.x, display.x + display.width - 1),
      y: clamp(point.y, display.y, display.y + display.height - 1)
    }
    try {
      if (this.options.glide) this.glideTo(target, options.generation)
      else this.options.driver.moveTo(target)
    } catch {
      return failure(
        'permission_denied',
        '포인터를 움직이지 못했습니다. 입력 권한을 확인해 주세요.'
      )
    }
    this.remember(options)
    return {
      ok: true,
      value: { status: 'dispatched', position: { ...target, displayId: display.displayId } }
    }
  }

  async click(options: InputExecutionOptions): Promise<Result<InputObservation>> {
    const refused = this.refuse(options)
    if (refused) return refused
    try {
      // A click goes exactly where the last move was aimed, not to wherever the glide has got to.
      this.arrive()
      this.options.driver.click()
    } catch {
      return failure('permission_denied', '클릭을 보내지 못했습니다. 입력 권한을 확인해 주세요.')
    }
    this.remember(options)
    // The press was handed to the OS; whether any program reacted is not known here.
    return { ok: true, value: { status: 'dispatched' } }
  }

  async releaseOwnedInputs(): Promise<Result<void>> {
    this.stopGlide()
    // Nothing is ever held down, so there is nothing to release.
    return { ok: true, value: undefined }
  }

  async cancelGeneration(generation: Generation): Promise<Result<void>> {
    if (!this.cancelled.some((known) => sameGeneration(known, generation)))
      this.cancelled = [...this.cancelled, generation].slice(-16)
    this.lastSequence.delete(key(generation))
    // Anything still on its way is dropped, never carried out late.
    if (this.glide && sameGeneration(this.glide.generation, generation)) this.stopGlide()
    return { ok: true, value: undefined }
  }

  // --- glide -----------------------------------------------------------------------------------

  private glideTo(target: { x: number; y: number }, generation: Generation): void {
    const glide = this.glide
    if (glide) {
      glide.target = target
      glide.generation = generation
      return
    }
    // Start from where the pointer really is, so a pointer the user moved is not snapped back.
    const current = this.options.driver.position()
    this.glide = { target, current, atMs: this.options.clock.now(), generation, cancel: null }
    this.scheduleTick(this.glide)
  }

  private scheduleTick(glide: Glide): void {
    const { schedule, intervalMs } = this.options.glide!
    glide.cancel = schedule(() => this.tick(glide), intervalMs)
  }

  private tick(glide: Glide): void {
    if (this.glide !== glide) return
    const { timeConstantMs } = this.options.glide!
    const now = this.options.clock.now()
    const elapsed = Math.max(0, now - glide.atMs)
    glide.atMs = now
    const share = 1 - Math.exp(-elapsed / timeConstantMs)
    const dx = glide.target.x - glide.current.x
    const dy = glide.target.y - glide.current.y
    const arrived = Math.hypot(dx, dy) < 0.5
    glide.current = arrived
      ? glide.target
      : { x: glide.current.x + dx * share, y: glide.current.y + dy * share }
    try {
      this.options.driver.moveTo(glide.current)
    } catch {
      this.stopGlide()
      return
    }
    if (arrived) this.glide = null
    else this.scheduleTick(glide)
  }

  /** Puts the pointer on the target at once and ends the glide. */
  private arrive(): void {
    const glide = this.glide
    if (!glide) return
    this.stopGlide()
    this.options.driver.moveTo(glide.target)
  }

  private stopGlide(): void {
    this.glide?.cancel?.()
    this.glide = null
  }

  private refuse(options: InputExecutionOptions): Result<never> | null {
    if (options.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    if (this.cancelled.some((known) => sameGeneration(known, options.generation)))
      return failure('cancelled', '취소된 제스처 세션의 입력입니다.')
    if (options.deadlineMs <= this.options.clock.now())
      return failure('expired', '입력 시간이 지났습니다.')
    // An older input finishing after a newer one must not pull the pointer back.
    const last = this.lastSequence.get(key(options.generation))
    if (last !== undefined && options.sequence <= last)
      return failure('conflict', '이미 더 새로운 입력이 처리되었습니다.')
    return null
  }

  private remember(options: InputExecutionOptions): void {
    this.lastSequence.set(key(options.generation), options.sequence)
  }
}

const key = (generation: Generation) => `${generation.sessionId}:${generation.revision}`
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
