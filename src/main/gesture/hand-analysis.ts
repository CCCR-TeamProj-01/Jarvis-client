import type { HandAnalysis, Thresholds } from '../../shared/contracts/gesture-diagnostics'
import type { HandObservation, HandTrackingFrame } from '../../shared/contracts/gesture'
import { ActiveHandSelector } from './active-hand'
import { explainPointing, fingerExtensions, PointingPose } from './finger-pose'
import { PinchDetector, pinchRatio } from './pinch-detector'
import { DEFAULT_TUNING } from './tuning'
import type { GestureTuning } from './tuning'

/** The numbers the judgement goes by, for the view to show next to the values. */
export function thresholdsOf(
  tuning: Pick<GestureTuning, 'pinch' | 'pose'> = DEFAULT_TUNING
): Thresholds {
  return {
    pinchEnter: tuning.pinch.enter,
    pinchExit: tuning.pinch.exit,
    indexEnter: tuning.pose.indexExtended.enter,
    indexKeep: tuning.pose.indexExtended.keep,
    othersEnter: tuning.pose.othersCurled.enter,
    othersKeep: tuning.pose.othersCurled.keep
  }
}

/** How long without a hand lets the choice of the active hand start over. */
const FPS_WINDOW_MS = 1_000

/**
 * Judges the hands of each frame the way the cursor control does: the same finger reach, the same
 * pointing pose with its hysteresis and its short hold, the same pinch with its two thresholds, and
 * the same way of choosing one hand and staying with it. It keeps a little state per hand so that
 * what it says matches what the control would do from the same frames; it never touches the pointer.
 */
export class HandAnalyser {
  private selector = new ActiveHandSelector('auto_lock')
  private readonly poses = new Map<string, PointingPose>()
  private readonly pinches = new Map<string, PinchDetector>()
  private arrivals: number[] = []
  private lastHandAtMs: number | null = null

  constructor(private readonly tuning: GestureTuning = DEFAULT_TUNING) {}

  reset(): void {
    this.selector = new ActiveHandSelector('auto_lock')
    this.poses.clear()
    this.pinches.clear()
    this.arrivals = []
    this.lastHandAtMs = null
  }

  /** Frames a second over the last second, or null until enough frames have come to tell. */
  fps(): number | null {
    if (this.arrivals.length < 3) return null
    const span = this.arrivals[this.arrivals.length - 1]! - this.arrivals[0]!
    return span > 0 ? Math.round(((this.arrivals.length - 1) / span) * 10_000) / 10 : null
  }

  analyse(frame: HandTrackingFrame): HandAnalysis[] {
    const at = frame.capturedAtMs
    this.arrivals.push(at)
    while (this.arrivals.length > 1 && this.arrivals[0]! < at - FPS_WINDOW_MS) this.arrivals.shift()

    if (frame.hands.length === 0) {
      // A hand gone for long enough is a new start: the next one it sees is chosen afresh.
      if (this.lastHandAtMs !== null && at - this.lastHandAtMs >= this.tuning.lostAfterMs) {
        this.selector.reset()
        this.poses.clear()
        this.pinches.clear()
        this.lastHandAtMs = null
      }
      return []
    }
    this.lastHandAtMs = at
    const active = this.selector.select(frame.hands)
    // A hand that has gone starts over when it is back, as for the control.
    for (const id of [...this.poses.keys()])
      if (!frame.hands.some((hand) => hand.handId === id)) {
        this.poses.delete(id)
        this.pinches.delete(id)
      }
    return frame.hands.map((hand) => this.judge(hand, at, hand.handId === active?.handId))
  }

  private judge(hand: HandObservation, atMs: number, active: boolean): HandAnalysis {
    const pose = this.poses.get(hand.handId) ?? new PointingPose(this.tuning.pose)
    const pinch = this.pinches.get(hand.handId) ?? new PinchDetector(this.tuning.pinch)
    this.poses.set(hand.handId, pose)
    this.pinches.set(hand.handId, pinch)
    const ratio = pinchRatio(hand)
    pinch.update(ratio)
    const extensions = fingerExtensions(hand)
    // Closing the fingers bends the index finger; that must not look like the pose ending.
    const pointing = pose.update(extensions, atMs, pinch.isPinched)
    // What is said about a hand that points is that it points, even if only the hold keeps it so.
    const why = pointing
      ? { reason: 'pointing' as const, finger: null }
      : explainPointing(extensions, this.tuning.pose, 'enter')
    return {
      handId: hand.handId,
      handedness: hand.handedness,
      confidence: hand.confidence,
      active,
      landmarks: hand.landmarks,
      pinch: ratio,
      pinched: pinch.isPinched,
      reach: extensions
        ? {
            index: extensions.index,
            middle: extensions.middle,
            ring: extensions.ring,
            pinky: extensions.pinky
          }
        : null,
      pointing,
      reason: why.reason,
      openFinger: why.finger
    }
  }
}
