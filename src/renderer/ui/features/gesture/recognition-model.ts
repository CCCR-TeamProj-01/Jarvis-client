import type {
  DiagnosticsFrame,
  DiagnosticsSnapshot,
  HandAnalysis,
  Thresholds
} from '../../../../shared/contracts/gesture-diagnostics'
import type { Tone } from '../../view-model'

export const FINGER_LABEL = {
  index: '검지',
  middle: '중지',
  ring: '약지',
  pinky: '새끼'
} as const

export interface RecognitionStatus {
  chip: string
  tone: Tone
  detail: string
}

/** What the view says about itself: whether it is on, whose tracking it shows, and why not. */
export function recognitionStatus(snapshot: DiagnosticsSnapshot): RecognitionStatus {
  if (snapshot.availability === 'unavailable')
    return {
      chip: '사용할 수 없음',
      tone: 'idle',
      detail: '이 환경에서는 손 인식을 확인할 수 없어요.'
    }
  switch (snapshot.state) {
    case 'off':
      return {
        chip: '꺼짐',
        tone: 'idle',
        detail: '켜면 카메라 영상에 손을 겹쳐 보여 줘요. 커서는 움직이지 않아요.'
      }
    case 'starting':
      return { chip: '준비 중', tone: 'info', detail: '카메라와 손 인식을 준비하고 있어요.' }
    case 'failed':
      return {
        chip: '멈춤',
        tone: 'error',
        detail: snapshot.error?.message ?? '인식 확인을 시작하지 못했어요.'
      }
    case 'on':
      return snapshot.source === 'control'
        ? {
            chip: '제어와 같은 인식',
            tone: 'ok',
            detail: '제스처 제어가 쓰는 손 인식을 그대로 보여 주고 있어요.'
          }
        : {
            chip: '확인 중',
            tone: 'ok',
            detail: snapshot.preview
              ? '카메라 영상에 손 관절을 겹쳐 보여 줘요. 커서는 움직이지 않아요.'
              : '영상은 만들지 못해 손 관절만 보여 줘요. 커서는 움직이지 않아요.'
          }
  }
}

/** The line that says why a hand is, or is not, taken for pointing, in terms of what to do about it. */
export function reasonText(hand: HandAnalysis, thresholds: Thresholds): string {
  const reach = hand.reach
  switch (hand.reason) {
    case 'pointing':
      return '검지만 편 자세로 인식했어요.'
    case 'index_short':
      return reach
        ? `검지가 덜 펴졌어요. ${reach.index.toFixed(2)}인데 ${thresholds.indexEnter} 이상이어야 해요.`
        : '검지가 덜 펴졌어요.'
    case 'finger_open': {
      const finger = hand.openFinger
      if (!finger || !reach) return '다른 손가락이 덜 접혔어요.'
      return `${FINGER_LABEL[finger]}를 더 접어 주세요. ${reach[finger].toFixed(2)}인데 ${thresholds.othersEnter} 이하여야 해요.`
    }
    case 'no_measure':
      return '손가락 길이를 재지 못했어요. 손이 너무 작거나 화면에서 잘렸을 수 있어요.'
  }
}

export interface ReachRow {
  finger: keyof typeof FINGER_LABEL
  label: string
  value: number
  /** Where the bar's mark for the limit is, 0 to 1 of the bar. */
  mark: number
  /** `index` must reach at least the mark; the others must stay at or under it. */
  needs: 'at_least' | 'at_most'
  ok: boolean
}

/** The bars run from nothing to this much reach, which is a little more than a stretched finger. */
export const REACH_SCALE = 2.4

const share = (value: number) => Math.min(1, Math.max(0, value / REACH_SCALE))

export function reachRows(hand: HandAnalysis, thresholds: Thresholds): ReachRow[] {
  const reach = hand.reach
  if (!reach) return []
  return (['index', 'middle', 'ring', 'pinky'] as const).map((finger) => {
    const isIndex = finger === 'index'
    const limit = isIndex ? thresholds.indexEnter : thresholds.othersEnter
    return {
      finger,
      label: FINGER_LABEL[finger],
      value: reach[finger],
      mark: share(limit),
      needs: isIndex ? 'at_least' : 'at_most',
      ok: isIndex ? reach[finger] >= limit : reach[finger] <= limit
    }
  })
}

export interface PinchRow {
  value: number
  /** The bar's marks for starting and ending a pinch, 0 to 1 of the bar. */
  enterMark: number
  exitMark: number
  pinched: boolean
}

/** The pinch bar runs from touching to a little more than the hand's own width. */
export const PINCH_SCALE = 1.2

export function pinchRow(hand: HandAnalysis, thresholds: Thresholds): PinchRow | null {
  if (hand.pinch === null) return null
  const scaled = (value: number) => Math.min(1, Math.max(0, value / PINCH_SCALE))
  return {
    value: hand.pinch,
    enterMark: scaled(thresholds.pinchEnter),
    exitMark: scaled(thresholds.pinchExit),
    pinched: hand.pinched
  }
}

export const handName = (hand: HandAnalysis): string =>
  hand.handedness === 'left' ? '왼손' : hand.handedness === 'right' ? '오른손' : '손'

/** What to say when the view is on but no hand is in the picture. */
export function noHandText(frame: DiagnosticsFrame | null): string | null {
  if (!frame) return '첫 화면을 기다리고 있어요.'
  return frame.hands.length === 0 ? '손이 보이지 않아요. 카메라 앞에 손을 보여 주세요.' : null
}

export const fpsText = (fps: number | null): string =>
  fps === null ? '속도 측정 중' : `${fps.toFixed(1)} fps`
