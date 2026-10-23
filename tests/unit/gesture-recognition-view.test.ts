import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { thresholdsOf } from '../../src/main/gesture/hand-analysis'
import type {
  DiagnosticsFrame,
  DiagnosticsSnapshot,
  HandAnalysis
} from '../../src/shared/contracts/gesture-diagnostics'
import {
  COLORS,
  drawHands,
  HAND_BONES,
  tipIsWanted
} from '../../src/renderer/ui/features/gesture/hand-draw'
import type { DrawingContext } from '../../src/renderer/ui/features/gesture/hand-draw'
import {
  CALM_INTERVAL_MS,
  HAND_HOLD_MS,
  calmNext,
  fpsText,
  handName,
  noHandText,
  pinchRow,
  reachRows,
  reasonText,
  recognitionStatus,
  shouldPaint
} from '../../src/renderer/ui/features/gesture/recognition-model'
import {
  HandCard,
  RecognitionPanel
} from '../../src/renderer/ui/features/gesture/recognition-panel'
import { newestDiagnosticsSnapshot } from '../../src/renderer/ui/features/gesture/use-gesture-diagnostics'
import { hand } from '../fixtures/hands'

const thresholds = thresholdsOf()
const snapshot = (patch: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot => ({
  revision: 1,
  availability: 'ready',
  state: 'off',
  source: null,
  preview: false,
  error: null,
  thresholds,
  ...patch
})
const analysis = (patch: Partial<HandAnalysis> = {}): HandAnalysis => ({
  handId: 'right',
  handedness: 'right',
  confidence: 0.93,
  active: true,
  landmarks: hand({ pose: 'pointing' }).landmarks,
  pinch: 1.05,
  pinched: false,
  reach: { index: 1.84, middle: 0.68, ring: 0.63, pinky: 0.72 },
  pointing: true,
  reason: 'pointing',
  openFinger: null,
  ...patch
})
const frameOf = (hands: HandAnalysis[], fps: number | null = 29.8): DiagnosticsFrame => ({
  sequence: 5,
  hands,
  fps,
  picture: null
})
const html = (
  state: DiagnosticsSnapshot | null,
  frame: DiagnosticsFrame | null = null,
  error: string | null = null
) =>
  renderToStaticMarkup(
    createElement(RecognitionPanel, {
      snapshot: state,
      frame,
      connectionError: error,
      onStart: () => undefined,
      onStop: () => undefined
    })
  )

describe('what the view says about itself', () => {
  it('says each state, and whose tracking it shows', () => {
    expect(recognitionStatus(snapshot())).toMatchObject({ chip: '꺼짐', tone: 'idle' })
    expect(recognitionStatus(snapshot({ state: 'starting' }))).toMatchObject({ chip: '준비 중' })
    expect(
      recognitionStatus(snapshot({ state: 'on', source: 'own', preview: true }))
    ).toMatchObject({
      chip: '확인 중',
      tone: 'ok',
      detail: expect.stringContaining('커서는 움직이지 않아요')
    })
    expect(recognitionStatus(snapshot({ state: 'on', source: 'control' }))).toMatchObject({
      chip: '제어와 같은 인식'
    })
  })

  it('says when there are no pictures, and why it failed in the failure’s own words', () => {
    expect(
      recognitionStatus(snapshot({ state: 'on', source: 'own', preview: false })).detail
    ).toContain('손 관절만')
    expect(
      recognitionStatus(
        snapshot({
          state: 'failed',
          error: { code: 'permission_denied', message: '카메라 권한이 없어요.' }
        })
      )
    ).toMatchObject({ chip: '멈춤', tone: 'error', detail: '카메라 권한이 없어요.' })
    expect(recognitionStatus(snapshot({ state: 'failed' })).detail).toContain('시작하지 못했어요')
    expect(recognitionStatus(snapshot({ availability: 'unavailable' }))).toMatchObject({
      chip: '사용할 수 없음'
    })
  })

  it('tells how fast the tracking goes, and when it cannot yet', () => {
    expect(fpsText(null)).toBe('속도 측정 중')
    expect(fpsText(29.84)).toBe('29.8 fps')
  })

  it('says what to do when no hand is in the picture, and waits for the first frame', () => {
    expect(noHandText(null)).toContain('기다리고')
    expect(noHandText(frameOf([]))).toContain('손이 보이지 않아요')
    expect(noHandText(frameOf([analysis()]))).toBeNull()
  })
})

describe('why a hand is or is not pointing', () => {
  it('says pointing, and for the others names what to do with numbers', () => {
    expect(reasonText(analysis(), thresholds)).toBe('검지만 편 자세로 인식했어요.')
    expect(
      reasonText(
        analysis({
          pointing: false,
          reason: 'index_short',
          reach: { index: 1.2, middle: 0.7, ring: 0.7, pinky: 0.7 }
        }),
        thresholds
      )
    ).toBe('검지가 덜 펴졌어요. 1.20인데 1.5 이상이어야 해요.')
    expect(
      reasonText(
        analysis({
          pointing: false,
          reason: 'finger_open',
          openFinger: 'ring',
          reach: { index: 1.8, middle: 0.7, ring: 1.62, pinky: 0.7 }
        }),
        thresholds
      )
    ).toBe('약지를 더 접어 주세요. 1.62인데 1.3 이하여야 해요.')
    expect(
      reasonText(analysis({ pointing: false, reason: 'no_measure', reach: null }), thresholds)
    ).toContain('재지 못했어요')
  })

  it('says something sensible even without the numbers', () => {
    expect(
      reasonText(analysis({ pointing: false, reason: 'index_short', reach: null }), thresholds)
    ).toBe('검지가 덜 펴졌어요.')
    expect(
      reasonText(analysis({ pointing: false, reason: 'finger_open', openFinger: null }), thresholds)
    ).toBe('다른 손가락이 덜 접혔어요.')
  })

  it('draws a bar for each finger with its limit and whether it is as wanted', () => {
    const rows = reachRows(
      analysis({ reach: { index: 1.84, middle: 1.6, ring: 0.63, pinky: 0.72 } }),
      thresholds
    )
    expect(rows.map((row) => [row.label, row.needs, row.ok])).toEqual([
      ['검지', 'at_least', true],
      ['중지', 'at_most', false],
      ['약지', 'at_most', true],
      ['새끼', 'at_most', true]
    ])
    expect(rows[0]!.mark).toBeCloseTo(1.5 / 2.4)
    expect(rows[1]!.mark).toBeCloseTo(1.3 / 2.4)
    expect(reachRows(analysis({ reach: null }), thresholds)).toEqual([])
  })

  it('draws the pinch bar with both of its marks, and nothing when it could not be measured', () => {
    expect(pinchRow(analysis({ pinch: 0.2, pinched: true }), thresholds)).toEqual({
      value: 0.2,
      enterMark: 0.25 / 1.2,
      exitMark: 0.45 / 1.2,
      pinched: true
    })
    expect(pinchRow(analysis({ pinch: null }), thresholds)).toBeNull()
    expect(pinchRow(analysis({ pinch: 5 }), thresholds)!.value).toBe(5)
  })

  it('names the hand', () => {
    expect(handName(analysis({ handedness: 'left' }))).toBe('왼손')
    expect(handName(analysis({ handedness: 'right' }))).toBe('오른손')
    expect(handName(analysis({ handedness: 'unknown' }))).toBe('손')
  })
})

describe('the recognition panel', () => {
  it('offers to turn the view on, and says what it does and does not do', () => {
    const page = html(snapshot())
    expect(page).toContain('인식 확인')
    expect(page).toContain('손 인식 확인')
    expect(page).toContain('커서는 움직이지 않아요')
    expect(page).toContain('저장하거나 서버로 보내지 않고')
    expect(page).not.toContain('hand-canvas')
  })

  it('offers to turn it off while it is on, and shows the hand with its judgement', () => {
    const page = html(
      snapshot({ state: 'on', source: 'own', preview: true }),
      frameOf([analysis()])
    )
    expect(page).toContain('확인 끄기')
    expect(page).toContain('hand-canvas')
    expect(page).toContain('29.8 fps')
    expect(page).toContain('오른손 · 제어에 쓰는 손')
    expect(page).toContain('포인팅')
    expect(page).toContain('검지만 편 자세로 인식했어요.')
    expect(page).toContain('1.84')
    expect(page).toContain('충분히 폄')
    expect(page).toContain('Pinch')
    expect(page).toContain('벌어짐')
    expect(page).toContain('신뢰도 93%')
  })

  it('says in words, not only colour, which finger is off', () => {
    const page = html(
      snapshot({ state: 'on', source: 'own', preview: true }),
      frameOf([
        analysis({
          pointing: false,
          reason: 'finger_open',
          openFinger: 'middle',
          reach: { index: 1.8, middle: 1.94, ring: 0.7, pinky: 0.7 }
        })
      ])
    )
    expect(page).toContain('포인팅 아님')
    expect(page).toContain('중지를 더 접어 주세요')
    expect(page).toContain('더 접어야 해요')
    expect(page).toContain('aria-label="중지 1.94, 더 접어야 해요"')
  })

  it('shows both hands, and a hand that is pinching as pinching', () => {
    const page = html(
      snapshot({ state: 'on', source: 'own' }),
      frameOf([
        analysis({ handId: 'a', active: false, handedness: 'left' }),
        analysis({ handId: 'b', pinch: 0.2, pinched: true })
      ])
    )
    expect(page.match(/class="hand-card"/g)).toHaveLength(2)
    expect(page).toContain('왼손')
    expect(page).toContain('모음(클릭)')
    expect(page).not.toContain('왼손 · 제어에 쓰는 손')
  })

  it('says when there is no hand, and when the first frame has not come', () => {
    const none = html(snapshot({ state: 'on', source: 'own' }), frameOf([]))
    expect(none).toContain('손이 보이지 않아요')
    expect(none).not.toContain('class="hand-card"')
    const waiting = html(snapshot({ state: 'on', source: 'own' }), null)
    expect(waiting).toContain('첫 화면을 기다리고 있어요')
    expect(waiting).not.toContain('hand-canvas')
  })

  it('shows nothing of the picture before it is on or when it failed, and the failure in words', () => {
    expect(html(snapshot({ state: 'starting' }), frameOf([analysis()]))).not.toContain(
      'hand-canvas'
    )
    const failed = html(
      snapshot({
        state: 'failed',
        error: { code: 'permission_denied', message: '카메라 권한이 없어요.' }
      }),
      frameOf([analysis()])
    )
    expect(failed).not.toContain('hand-canvas')
    expect(failed).toContain('카메라 권한이 없어요.')
    expect(failed).toContain('손 인식 확인')
  })

  it('cannot be started while it is starting, and has no button without the service', () => {
    expect(html(snapshot({ state: 'starting' }))).toMatch(
      /<button[^>]*disabled=""[^>]*>[^<]*(<svg[^>]*>.*?<\/svg>)?준비 중/
    )
    expect(html(snapshot({ availability: 'unavailable' }))).not.toContain('<button')
    expect(html(null)).not.toContain('<button')
    expect(html(null, null, '앱과 연결하지 못했어요.')).toContain('앱과 연결하지 못했어요.')
  })

  it('renders nothing the hand tracking said as markup', () => {
    const page = html(
      snapshot({ state: 'on' }),
      frameOf([analysis({ handId: '<img src=x onerror=alert(1)>' })])
    )
    expect(page).not.toContain('<img')
  })

  it('does not let a late snapshot replace a newer one', () => {
    const newer = snapshot({ revision: 5 })
    const older = snapshot({ revision: 4 })
    expect(newestDiagnosticsSnapshot(newer, older)).toBe(newer)
    expect(newestDiagnosticsSnapshot(older, newer)).toBe(newer)
    expect(newestDiagnosticsSnapshot(null, older)).toBe(older)
  })
})

/** A context that remembers what was drawn. */
function recorder() {
  const calls: string[] = []
  const state = { stroke: '', fill: '' }
  const context: DrawingContext = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    beginPath: () => calls.push('begin'),
    moveTo: (x, y) => calls.push(`move ${Math.round(x)},${Math.round(y)}`),
    lineTo: (x, y) => calls.push(`line ${Math.round(x)},${Math.round(y)}`),
    arc: (x, y, r) =>
      calls.push(`arc ${Math.round(x)},${Math.round(y)} r${r} fill=${String(context.fillStyle)}`),
    stroke: () => {
      state.stroke = String(context.strokeStyle)
      calls.push(`stroke ${state.stroke} w${context.lineWidth}`)
    },
    fill: () => {
      state.fill = String(context.fillStyle)
      calls.push('fill')
    }
  }
  return { context, calls }
}

describe('drawing the hands', () => {
  it('draws every bone and joint of a hand at its place in the picture', () => {
    const t = recorder()
    drawHands(t.context, [analysis()], 400, 200, thresholds)
    const lines = t.calls.filter((call) => call.startsWith('line'))
    // The bones, and the thumb–index line.
    expect(lines).toHaveLength(HAND_BONES.length + 1)
    const joints = t.calls.filter((call) => call.startsWith('arc') && call.includes('r3'))
    expect(joints).toHaveLength(21)
    const knuckle = analysis().landmarks[5]!
    expect(t.calls).toContain(`move ${Math.round(knuckle.x * 400)},${Math.round(knuckle.y * 200)}`)
  })

  it('colours a fingertip as the pointing pose wants it: green when right, amber when not', () => {
    const t = recorder()
    drawHands(
      t.context,
      [analysis({ reach: { index: 1.84, middle: 1.9, ring: 0.6, pinky: 0.6 } })],
      100,
      100,
      thresholds
    )
    const tips = t.calls.filter((call) => /r7 /.test(call))
    expect(tips).toHaveLength(4)
    expect(tips.filter((call) => call.endsWith(COLORS.good))).toHaveLength(3)
    expect(tips.filter((call) => call.endsWith(COLORS.warn))).toHaveLength(1)
  })

  it('draws a hand with no measurement without judging its tips', () => {
    const t = recorder()
    drawHands(t.context, [analysis({ reach: null })], 100, 100, thresholds)
    expect(t.calls.filter((call) => /r7 /.test(call))).toHaveLength(0)
    expect(tipIsWanted(analysis({ reach: null }), 'index', thresholds)).toBeNull()
  })

  it('draws a pinch as a thick pink line, and an open one as a thin pale one', () => {
    const open = recorder()
    drawHands(open.context, [analysis({ pinched: false })], 100, 100, thresholds)
    expect(open.calls).toContain(`stroke ${COLORS.pinchOpen} w1.5`)
    const closed = recorder()
    drawHands(closed.context, [analysis({ pinched: true })], 100, 100, thresholds)
    expect(closed.calls).toContain(`stroke ${COLORS.pinch} w4`)
  })

  it('draws the hand the control follows bolder than the other', () => {
    const t = recorder()
    drawHands(
      t.context,
      [analysis({ active: false }), analysis({ active: true })],
      100,
      100,
      thresholds
    )
    expect(t.calls).toContain(`stroke ${COLORS.boneOther} w2`)
    expect(t.calls).toContain(`stroke ${COLORS.bone} w3`)
    expect(t.calls.filter((call) => call.includes('r5 ')).length).toBe(4)
    expect(t.calls.filter((call) => call.includes('r7 ')).length).toBe(4)
  })

  it('draws nothing for no hands', () => {
    const t = recorder()
    drawHands(t.context, [], 100, 100, thresholds)
    expect(t.calls.filter((call) => call !== 'begin')).toEqual([])
  })

  it('judges a tip against the limit of its own finger', () => {
    const reach = (index: number, middle: number) =>
      analysis({ reach: { index, middle, ring: 0.5, pinky: 0.5 } })
    expect(tipIsWanted(reach(1.5, 0.5), 'index', thresholds)).toBe(true)
    expect(tipIsWanted(reach(1.49, 0.5), 'index', thresholds)).toBe(false)
    expect(tipIsWanted(reach(2, 1.3), 'middle', thresholds)).toBe(true)
    expect(tipIsWanted(reach(2, 1.31), 'middle', thresholds)).toBe(false)
  })
})

describe('keeping the view from flickering', () => {
  const picture = { width: 320, height: 180, jpeg: new Uint8Array([1]) }
  const withPicture = (hands: HandAnalysis[]): DiagnosticsFrame => ({
    ...frameOf(hands),
    picture
  })

  it('leaves out a frame without a picture while pictures are coming, once one has been drawn', () => {
    expect(shouldPaint(withPicture([]), true, true)).toBe(true)
    expect(shouldPaint(frameOf([]), true, true)).toBe(false)
    // Nothing is on the canvas yet: the hands are drawn on the plain background.
    expect(shouldPaint(frameOf([]), true, false)).toBe(true)
    // No pictures at all: every frame is drawn, there is nothing to flash away.
    expect(shouldPaint(frameOf([]), false, true)).toBe(true)
    expect(shouldPaint(frameOf([]), false, false)).toBe(true)
  })

  it('shows a frame with hands as it is', () => {
    const a = analysis()
    const incoming = frameOf([a])
    expect(calmNext(null, incoming, 1000)).toEqual({ frame: incoming, lostSinceMs: null })
    const earlier = { frame: frameOf([analysis({ handId: 'old' })]), lostSinceMs: 500 }
    expect(calmNext(earlier, incoming, 1000)).toEqual({ frame: incoming, lostSinceMs: null })
  })

  it('keeps the last hands for a short while when they go, marked as lost, with the newest speed', () => {
    const before = { frame: frameOf([analysis()], 29), lostSinceMs: null }
    const first = calmNext(before, frameOf([], 24), 1000)
    expect(first.lostSinceMs).toBe(1000)
    expect(first.frame.hands).toEqual(before.frame.hands)
    expect(first.frame.fps).toBe(24)
    const later = calmNext(first, frameOf([], 25), 1000 + HAND_HOLD_MS - 1)
    expect(later.lostSinceMs).toBe(1000)
    expect(later.frame.hands).toHaveLength(1)
  })

  it('lets the hands go once they have been missing for the hold, and does not bring back old ones', () => {
    const lost = { frame: frameOf([analysis()]), lostSinceMs: 1000 }
    const gone = calmNext(lost, frameOf([]), 1000 + HAND_HOLD_MS)
    expect(gone).toEqual({ frame: frameOf([]), lostSinceMs: null })
    expect(calmNext(gone, frameOf([]), 5000).frame.hands).toEqual([])
    expect(calmNext(null, frameOf([]), 100).frame.hands).toEqual([])
  })

  it('changes the words at a calm pace', () => {
    expect(CALM_INTERVAL_MS).toBeGreaterThanOrEqual(200)
    expect(HAND_HOLD_MS).toBeGreaterThan(CALM_INTERVAL_MS)
  })

  it('shows a hand that was just lost dimmed, with its last values, and says so in words', () => {
    const page = renderToStaticMarkup(
      createElement(HandCard, { hand: analysis(), thresholds, lost: true })
    )
    expect(page).toContain('hand-card hand-card-lost')
    expect(page).toContain('손을 잠깐 놓쳤어요')
    expect(page).not.toContain('신뢰도')
    const present = renderToStaticMarkup(
      createElement(HandCard, { hand: analysis(), thresholds, lost: false })
    )
    expect(present).not.toContain('hand-card-lost')
    expect(present).toContain('신뢰도 93%')
  })
})
