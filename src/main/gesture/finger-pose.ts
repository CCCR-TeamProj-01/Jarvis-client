import type { HandObservation } from '../../shared/contracts/gesture'

const WRIST = 0
/** [knuckle, tip] of each finger other than the thumb. */
const FINGER_JOINTS = {
  index: [5, 8],
  middle: [9, 12],
  ring: [13, 16],
  pinky: [17, 20]
} as const

export type FingerName = keyof typeof FINGER_JOINTS
export type FingerExtensions = Record<FingerName, number>

/**
 * How far each finger reaches: wrist-to-tip over wrist-to-knuckle. A stretched finger reaches about
 * twice as far as its knuckle, a curled one barely as far. Distances from the wrist do not change
 * when the hand turns, which is why this is used rather than joint angles in the picture.
 */
export function fingerExtensions(hand: HandObservation): FingerExtensions | null {
  const wrist = hand.landmarks[WRIST]
  if (!wrist) return null
  const result = {} as FingerExtensions
  for (const [name, [knuckleIndex, tipIndex]] of Object.entries(FINGER_JOINTS) as [
    FingerName,
    readonly [number, number]
  ][]) {
    const knuckle = hand.landmarks[knuckleIndex]
    const tip = hand.landmarks[tipIndex]
    if (!knuckle || !tip) return null
    const base = Math.hypot(knuckle.x - wrist.x, knuckle.y - wrist.y)
    if (base < 1e-4) return null
    result[name] = Math.hypot(tip.x - wrist.x, tip.y - wrist.y) / base
  }
  return result
}

/** Why a hand is or is not pointing, in the terms of the checks that decide it. */
export type PointingReason =
  | 'pointing'
  /** The index finger does not reach out far enough. */
  | 'index_short'
  /** One of the other fingers is not folded far enough. */
  | 'finger_open'
  /** The fingers could not be measured (a hand too small or cut off in the picture). */
  | 'no_measure'

export interface PointingExplanation {
  reason: PointingReason
  /** For `finger_open`: which finger, the one that reaches furthest of the three. */
  finger: 'middle' | 'ring' | 'pinky' | null
  /** The thresholds that applied (strict to start, loose once pointing). */
  indexNeeds: number
  othersNeed: number
}

export interface PoseThresholds {
  indexExtended: { enter: number; keep: number }
  othersCurled: { enter: number; keep: number }
  /** A pose that stops matching only counts as gone after this long. */
  exitHoldMs: number
}

/**
 * Says why `extensions` is or is not pointing at the thresholds for `level`, with the same checks
 * `PointingPose` makes: the index must reach `indexExtended` and the other three stay under
 * `othersCurled`. When both fail the index is named first, since it is the one to fix.
 */
export function explainPointing(
  extensions: FingerExtensions | null,
  thresholds: Pick<PoseThresholds, 'indexExtended' | 'othersCurled'>,
  level: 'enter' | 'keep'
): PointingExplanation {
  const indexNeeds = thresholds.indexExtended[level]
  const othersNeed = thresholds.othersCurled[level]
  if (extensions === null) return { reason: 'no_measure', finger: null, indexNeeds, othersNeed }
  if (extensions.index < indexNeeds)
    return { reason: 'index_short', finger: null, indexNeeds, othersNeed }
  const others = (['middle', 'ring', 'pinky'] as const).map(
    (finger) => [finger, extensions[finger]] as const
  )
  const open = others.reduce((far, current) => (current[1] > far[1] ? current : far))
  if (open[1] > othersNeed)
    return { reason: 'finger_open', finger: open[0], indexNeeds, othersNeed }
  return { reason: 'pointing', finger: null, indexNeeds, othersNeed }
}

/**
 * Pointing: the index finger out and the middle, ring and little fingers folded in. It starts at
 * the strict thresholds and persists at the looser ones, and briefly survives a miss, so a pose
 * hovering at an edge does not flicker the cursor on and off.
 */
export class PointingPose {
  private active = false
  private lastMatchMs = 0

  constructor(private readonly thresholds: PoseThresholds) {}

  get isPointing(): boolean {
    return this.active
  }

  reset(): void {
    this.active = false
    this.lastMatchMs = 0
  }

  /**
   * `latched` keeps the pose while the fingers are closing for a pinch, which bends the index
   * finger and would otherwise look like the pose ending just as the click happens.
   */
  update(extensions: FingerExtensions | null, atMs: number, latched: boolean): boolean {
    const matches = extensions !== null && this.matches(extensions, this.active ? 'keep' : 'enter')
    if (matches || (latched && this.active)) {
      this.active = true
      this.lastMatchMs = atMs
    } else if (this.active && atMs - this.lastMatchMs > this.thresholds.exitHoldMs) {
      this.active = false
    }
    return this.active
  }

  private matches(extensions: FingerExtensions, level: 'enter' | 'keep'): boolean {
    const { indexExtended, othersCurled } = this.thresholds
    return (
      extensions.index >= indexExtended[level] &&
      Math.max(extensions.middle, extensions.ring, extensions.pinky) <= othersCurled[level]
    )
  }
}
