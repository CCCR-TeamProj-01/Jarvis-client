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
      this.options.driver.moveTo(target)
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
      this.options.driver.click()
    } catch {
      return failure('permission_denied', '클릭을 보내지 못했습니다. 입력 권한을 확인해 주세요.')
    }
    this.remember(options)
    // The press was handed to the OS; whether any program reacted is not known here.
    return { ok: true, value: { status: 'dispatched' } }
  }

  async releaseOwnedInputs(): Promise<Result<void>> {
    // Nothing is ever held down, so there is nothing to release.
    return { ok: true, value: undefined }
  }

  async cancelGeneration(generation: Generation): Promise<Result<void>> {
    if (!this.cancelled.some((known) => sameGeneration(known, generation)))
      this.cancelled = [...this.cancelled, generation].slice(-16)
    this.lastSequence.delete(key(generation))
    return { ok: true, value: undefined }
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
