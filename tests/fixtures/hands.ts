import type {
  HandObservation,
  HandTrackingFrame,
  HandTrackingEvent
} from '../../src/shared/contracts/gesture'
import type { Generation } from '../../src/shared/contracts/common'

/**
 * A hand whose wrist and middle knuckle are 0.2 apart, with the index fingertip at `tip` and the
 * thumb tip placed so that thumb–index distance over hand size equals `pinch`.
 */
export function hand(
  options: {
    handId?: string
    handedness?: HandObservation['handedness']
    confidence?: number
    tip?: { x: number; y: number }
    pinch?: number
  } = {}
): HandObservation {
  const tip = options.tip ?? { x: 0.5, y: 0.5 }
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  landmarks[0] = { x: 0.5, y: 0.8, z: 0 }
  landmarks[9] = { x: 0.5, y: 0.6, z: 0 }
  landmarks[8] = { x: tip.x, y: tip.y, z: 0 }
  landmarks[4] = { x: tip.x + (options.pinch ?? 1) * 0.2, y: tip.y, z: 0 }
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
