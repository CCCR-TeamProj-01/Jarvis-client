import type { HandObservation } from '../../shared/contracts/gesture'

const WRIST = 0
const THUMB_TIP = 4
const INDEX_TIP = 8
const MIDDLE_MCP = 9

/** Thumb–index distance over the hand's size (wrist to middle knuckle); null if the hand is degenerate. */
export function pinchRatio(hand: HandObservation): number | null {
  const [wrist, thumb, index, knuckle] = [WRIST, THUMB_TIP, INDEX_TIP, MIDDLE_MCP].map(
    (joint) => hand.landmarks[joint]
  )
  if (!wrist || !thumb || !index || !knuckle) return null
  const size = Math.hypot(knuckle.x - wrist.x, knuckle.y - wrist.y)
  if (size < 1e-4) return null
  return Math.hypot(thumb.x - index.x, thumb.y - index.y) / size
}

export type PinchTransition = 'started' | 'ended' | null

/**
 * Pinch with two thresholds so a ratio hovering near one of them cannot flicker into several
 * clicks. A pinch already held when tracking begins (or resumes) is not a click: the hand has to
 * open first.
 */
export class PinchDetector {
  private pinched = false
  private armed = false

  constructor(private readonly thresholds: { enter: number; exit: number }) {}

  get isPinched(): boolean {
    return this.pinched
  }

  /** Forget everything; the next observation starts from a neutral state. */
  reset(): void {
    this.pinched = false
    this.armed = false
  }

  update(ratio: number | null): PinchTransition {
    if (ratio === null) return null
    if (this.pinched) {
      if (ratio > this.thresholds.exit) {
        this.pinched = false
        this.armed = true
        return 'ended'
      }
      return null
    }
    if (ratio > this.thresholds.exit) this.armed = true
    if (this.armed && ratio < this.thresholds.enter) {
      this.pinched = true
      return 'started'
    }
    return null
  }
}
