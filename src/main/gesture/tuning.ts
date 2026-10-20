/**
 * Numbers that decide how gestures feel. They are measured on real hands rather than derived, so
 * they live in one place and the controller takes them as an argument.
 */
export interface GestureTuning {
  /** Frames older than this (by capture time) are dropped instead of moving the cursor late. */
  maxFrameAgeMs: number
  /** No usable frame for this long means the hand is lost, even if no loss event arrived. */
  lostAfterMs: number
  /**
   * The part of the camera picture that spans the whole screen, as margins from each edge (0..0.5).
   * Reaching the screen edge then does not need the hand at the very edge of the picture.
   */
  region: { left: number; right: number; top: number; bottom: number }
  /** One Euro filter on the normalised region position: steadier when slow, quicker when fast. */
  smoothing: { minCutoffHz: number; beta: number; derivativeCutoffHz: number }
  /** Movement smaller than this many logical pixels is not sent. */
  deadZonePx: number
  /** Thumb–index distance over hand size: below `enter` the pinch starts, above `exit` it ends. */
  pinch: { enter: number; exit: number }
  /**
   * The cursor moves, and a click is sent, only while pointing: index finger out, the others
   * folded. Values are finger reach over knuckle reach (about 2 stretched, under 1 curled).
   */
  pose: {
    indexExtended: { enter: number; keep: number }
    othersCurled: { enter: number; keep: number }
    exitHoldMs: number
  }
  /** The click lands where the cursor was this long before the pinch, before the fingers moved. */
  pinchLookbackMs: number
  /**
   * Fingers closing is told apart from a hand merely moving by the pinch ratio falling by more
   * than `drop` within `windowMs`. From then on the cursor holds still, so it is already where the
   * click will land, and it stays put for `releaseHoldMs` after the fingers open again.
   */
  closing: { drop: number; windowMs: number; releaseHoldMs: number }
  /** How long a dispatched input may wait before it is no longer worth running. */
  inputDeadlineMs: number
}

export const DEFAULT_TUNING: GestureTuning = {
  maxFrameAgeMs: 250,
  lostAfterMs: 600,
  region: { left: 0.15, right: 0.15, top: 0.15, bottom: 0.2 },
  smoothing: { minCutoffHz: 1.5, beta: 12, derivativeCutoffHz: 1 },
  deadZonePx: 1.5,
  pinch: { enter: 0.25, exit: 0.45 },
  pose: {
    indexExtended: { enter: 1.5, keep: 1.35 },
    othersCurled: { enter: 1.3, keep: 1.45 },
    exitHoldMs: 200
  },
  pinchLookbackMs: 120,
  closing: { drop: 0.12, windowMs: 150, releaseHoldMs: 150 },
  inputDeadlineMs: 300
}
