import type { HandObservation } from '../../../shared/contracts/gesture'
import { HAND_LANDMARK_NAMES } from '../../../shared/contracts/gesture'

/** The parts of MediaPipe's HandLandmarker result used here. */
export interface RawHandResult {
  landmarks: { x: number; y: number; z: number }[][]
  handedness: { categoryName: string; score: number }[][]
}

const inUnitRange = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1

/**
 * Turn the engine's result into observations. MediaPipe assumes a mirrored (selfie) image, but
 * these frames are not mirrored, so its left/right labels are swapped to get the physical hand.
 * A hand whose joints fall outside the image, or that is incomplete, is not a valid observation
 * and is left out rather than clipped.
 */
export function toHandObservations(result: RawHandResult): HandObservation[] {
  const observations: HandObservation[] = []
  const used = new Map<string, number>()
  result.landmarks.forEach((joints, index) => {
    if (joints.length !== HAND_LANDMARK_NAMES.length) return
    if (
      !joints.every(
        (joint) => inUnitRange(joint.x) && inUnitRange(joint.y) && Number.isFinite(joint.z)
      )
    )
      return
    const category = result.handedness[index]?.[0]
    const label = category?.categoryName?.toLowerCase()
    const handedness: HandObservation['handedness'] =
      label === 'left' ? 'right' : label === 'right' ? 'left' : 'unknown'
    // IDs must be unique within a frame, and stay recognisable between frames for the same hand.
    const base = handedness
    const count = (used.get(base) ?? 0) + 1
    used.set(base, count)
    observations.push({
      handId: count === 1 ? base : `${base}-${count}`,
      handedness,
      confidence: Math.min(1, Math.max(0, category?.score ?? 0)),
      landmarks: joints.map((joint) => ({ x: joint.x, y: joint.y, z: joint.z }))
    })
  })
  return observations
}
