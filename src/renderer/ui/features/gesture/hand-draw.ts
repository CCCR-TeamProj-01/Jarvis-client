import type { HandAnalysis, Thresholds } from '../../../../shared/contracts/gesture-diagnostics'

/** The parts of a 2D canvas context the drawing uses, so it can be tested without a browser. */
export interface DrawingContext {
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: CanvasLineCap
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, radius: number, start: number, end: number): void
  stroke(): void
  fill(): void
}

/** The bones of a hand, as pairs of landmark indices (the hand model's own layout). */
export const HAND_BONES: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17]
]

const THUMB_TIP = 4
const INDEX_TIP = 8
/** The tip of each finger the pose judges, with the key of its reach. */
const JUDGED_TIPS = [
  [8, 'index'],
  [12, 'middle'],
  [16, 'ring'],
  [20, 'pinky']
] as const

export const COLORS = {
  bone: 'rgba(255, 255, 255, 0.9)',
  boneOther: 'rgba(255, 255, 255, 0.45)',
  joint: '#ffffff',
  good: '#34d399',
  warn: '#fbbf24',
  pinch: '#f472b6',
  pinchOpen: 'rgba(255, 255, 255, 0.55)'
} as const

/**
 * Whether the fingertip is where the pointing pose wants it: the index out, the others folded. A
 * tip with no measurement has no opinion (null).
 */
export function tipIsWanted(
  hand: HandAnalysis,
  finger: 'index' | 'middle' | 'ring' | 'pinky',
  thresholds: Thresholds
): boolean | null {
  if (!hand.reach) return null
  return finger === 'index'
    ? hand.reach.index >= thresholds.indexEnter
    : hand.reach[finger] <= thresholds.othersEnter
}

/**
 * Draws the hands on a picture `width` by `height`: their bones and joints, each fingertip the
 * pose judges green when it is as the pointing pose wants and amber when it is not, and a line
 * between thumb and index that turns pink while pinched. The hand the control follows is drawn
 * bolder. Landmarks are 0 to 1 across the picture; mirroring is the view's business, not this.
 */
export function drawHands(
  context: DrawingContext,
  hands: readonly HandAnalysis[],
  width: number,
  height: number,
  thresholds: Thresholds
): void {
  const at = (hand: HandAnalysis, index: number) => {
    const point = hand.landmarks[index]!
    return { x: point.x * width, y: point.y * height }
  }
  context.lineCap = 'round'
  for (const hand of hands) {
    context.strokeStyle = hand.active ? COLORS.bone : COLORS.boneOther
    context.lineWidth = hand.active ? 3 : 2
    for (const [from, to] of HAND_BONES) {
      const a = at(hand, from)
      const b = at(hand, to)
      context.beginPath()
      context.moveTo(a.x, a.y)
      context.lineTo(b.x, b.y)
      context.stroke()
    }
    context.fillStyle = COLORS.joint
    for (let index = 0; index < hand.landmarks.length; index++) {
      const point = at(hand, index)
      context.beginPath()
      context.arc(point.x, point.y, hand.active ? 3 : 2, 0, Math.PI * 2)
      context.fill()
    }
    const thumb = at(hand, THUMB_TIP)
    const index = at(hand, INDEX_TIP)
    context.strokeStyle = hand.pinched ? COLORS.pinch : COLORS.pinchOpen
    context.lineWidth = hand.pinched ? 4 : 1.5
    context.beginPath()
    context.moveTo(thumb.x, thumb.y)
    context.lineTo(index.x, index.y)
    context.stroke()
    for (const [landmark, finger] of JUDGED_TIPS) {
      const wanted = tipIsWanted(hand, finger, thresholds)
      if (wanted === null) continue
      const tip = at(hand, landmark)
      context.fillStyle = wanted ? COLORS.good : COLORS.warn
      context.beginPath()
      context.arc(tip.x, tip.y, hand.active ? 7 : 5, 0, Math.PI * 2)
      context.fill()
    }
  }
}
