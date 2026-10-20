import type {
  HandObservation,
  HandTrackingFrame,
  HandTrackingEvent
} from '../../src/shared/contracts/gesture'
import type { Generation } from '../../src/shared/contracts/common'

type Pose = 'pointing' | 'open' | 'fist'

/**
 * A hand whose wrist and middle knuckle are 0.2 apart. `tip` is where the hand points, which is
 * the index knuckle the cursor follows. The fingertips are laid out for the pose: in `pointing` the
 * index finger is stretched and the others folded, `open` has all four stretched, `fist` none. The
 * thumb tip is placed so that thumb–index distance over hand size equals `pinch`.
 */
export function hand(
  options: {
    handId?: string
    handedness?: HandObservation['handedness']
    confidence?: number
    tip?: { x: number; y: number }
    /** Where the index fingertip is, if not straight above the knuckle. */
    fingertip?: { x: number; y: number }
    pose?: Pose
    pinch?: number
  } = {}
): HandObservation {
  const knuckle = options.tip ?? { x: 0.5, y: 0.5 }
  const pose = options.pose ?? 'pointing'
  const landmarks = Array.from({ length: 21 }, () => ({ x: knuckle.x, y: knuckle.y, z: 0 }))
  const at = (x: number, y: number) => ({ x, y, z: 0 })
  const stretched = at(knuckle.x, knuckle.y - 0.3)
  const folded = at(knuckle.x, knuckle.y + 0.05)
  landmarks[0] = at(knuckle.x, knuckle.y + 0.2)
  const indexTip = options.fingertip
    ? at(options.fingertip.x, options.fingertip.y)
    : pose === 'fist'
      ? folded
      : stretched
  landmarks[8] = indexTip
  landmarks[12] = pose === 'open' ? stretched : folded
  landmarks[16] = pose === 'open' ? stretched : folded
  landmarks[20] = pose === 'open' ? stretched : folded
  landmarks[4] = at(indexTip.x + (options.pinch ?? 1) * 0.2, indexTip.y)
  return {
    handId: options.handId ?? 'right',
    handedness: options.handedness ?? 'right',
    confidence: options.confidence ?? 0.9,
    landmarks
  }
}

export function frame(
  generation: Generation,
  sequence: number,
  capturedAtMs: number,
  hands: HandObservation[]
): HandTrackingFrame {
  return { generation, sequence, capturedAtMs, hands }
}

export const frameEvent = (value: HandTrackingFrame): HandTrackingEvent => ({
  type: 'tracking.frame',
  frame: value
})
