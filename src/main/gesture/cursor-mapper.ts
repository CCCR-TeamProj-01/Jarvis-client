import type { DesktopPoint, DisplayBounds } from '../../shared/contracts/gesture'
import type { GestureTuning } from './tuning'

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/**
 * Where in the screen-spanning part of the picture a point is, 0..1 on both axes. The camera picture
 * is not mirrored, so moving the hand to the user's right moves it left in the picture: x is flipped
 * so the cursor follows the hand the way a mirror would.
 */
export function toRegionPosition(
  point: { x: number; y: number },
  region: GestureTuning['region']
): { x: number; y: number } {
  const width = 1 - region.left - region.right
  const height = 1 - region.top - region.bottom
  return {
    x: clamp01(1 - (point.x - region.left) / width),
    y: clamp01((point.y - region.top) / height)
  }
}

/** A position in the region, as a logical point on the display (the last pixel is inside). */
export function toDesktopPoint(
  position: { x: number; y: number },
  display: DisplayBounds
): DesktopPoint {
  return {
    displayId: display.displayId,
    x: display.x + clamp01(position.x) * (display.width - 1),
    y: display.y + clamp01(position.y) * (display.height - 1)
  }
}
