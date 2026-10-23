import { describe, expect, it } from 'vitest'
import { HandAnalyser, thresholdsOf } from '../../src/main/gesture/hand-analysis'
import { DEFAULT_TUNING } from '../../src/main/gesture/tuning'
import type { HandObservation, HandTrackingFrame } from '../../src/shared/contracts/gesture'
import { HandAnalysisSchema } from '../../src/shared/contracts/gesture-diagnostics'
import { frame, hand } from '../fixtures/hands'

const generation = { sessionId: 'g', revision: 1 }
const at = (sequence: number, hands: HandObservation[]): HandTrackingFrame =>
  frame(generation, sequence, sequence * 33, hands)

describe('HandAnalyser', () => {
  it('judges a pointing hand as pointing, with its reach, pinch and the hand itself', () => {
    const analyser = new HandAnalyser()
    const observed = hand({ pose: 'pointing', handedness: 'left', confidence: 0.8 })
    const [analysis] = analyser.analyse(at(1, [observed]))
    expect(analysis).toMatchObject({
      handId: 'right',
      handedness: 'left',
      confidence: 0.8,
      active: true,
      pointing: true,
      reason: 'pointing',
      openFinger: null,
      pinched: false
    })
    expect(analysis!.landmarks).toEqual(observed.landmarks)
    expect(analysis!.reach!.index).toBeGreaterThan(2)
    expect(analysis!.pinch).toBeCloseTo(1)
    expect(HandAnalysisSchema.safeParse(analysis).success).toBe(true)
  })

  it('says why an open hand and a fist are not pointing', () => {
    const analyser = new HandAnalyser()
    const [open] = analyser.analyse(at(1, [hand({ pose: 'open' })]))
    expect(open).toMatchObject({ pointing: false, reason: 'finger_open', openFinger: 'middle' })
    const [fist] = new HandAnalyser().analyse(at(1, [hand({ pose: 'fist' })]))
    expect(fist).toMatchObject({ pointing: false, reason: 'index_short', openFinger: null })
  })

  it('says it could not measure a hand that is too small in the picture', () => {
    const flat = hand()
    flat.landmarks[5] = { ...flat.landmarks[0]! }
    const [analysis] = new HandAnalyser().analyse(at(1, [flat]))
    expect(analysis).toMatchObject({ reach: null, pointing: false, reason: 'no_measure' })
  })

  it('follows the pinch with its two thresholds', () => {
    const analyser = new HandAnalyser()
    const pinchAt = (sequence: number, ratio: number) =>
      analyser.analyse(at(sequence, [hand({ pose: 'pointing', pinch: ratio })]))[0]!
    expect(pinchAt(1, 1).pinched).toBe(false)
    expect(pinchAt(2, 0.2)).toMatchObject({ pinched: true })
    expect(pinchAt(3, 0.4).pinched).toBe(true)
    expect(pinchAt(4, 0.5).pinched).toBe(false)
    expect(pinchAt(5, 0.3).pinched).toBe(false)
    expect(pinchAt(6, 0.2).pinched).toBe(true)
  })

  it('keeps saying pointing through the short hold, then says why it stopped', () => {
    const analyser = new HandAnalyser()
    analyser.analyse(at(1, [hand({ pose: 'pointing' })]))
    // 33 ms later the pose looks open for a moment: it is still pointing.
    expect(analyser.analyse(at(2, [hand({ pose: 'open' })]))[0]).toMatchObject({
      pointing: true,
      reason: 'pointing'
    })
    let last = analyser.analyse(at(3, [hand({ pose: 'open' })]))[0]!
    for (let sequence = 4; sequence <= 10; sequence++)
      last = analyser.analyse(at(sequence, [hand({ pose: 'open' })]))[0]!
    expect(last).toMatchObject({ pointing: false, reason: 'finger_open' })
  })

  it('keeps pointing while the fingers close for a pinch, as the control does', () => {
    const analyser = new HandAnalyser()
    analyser.analyse(at(1, [hand({ pose: 'pointing', pinch: 1 })]))
    const closing = (sequence: number, ratio: number) =>
      analyser.analyse(
        at(sequence, [hand({ pose: 'pointing', pinch: ratio, fingertip: { x: 0.5, y: 0.5 } })])
      )[0]!
    expect(closing(2, 0.2)).toMatchObject({ pinched: true, pointing: true })
    // The index finger is bent now, which on its own would not be pointing.
    expect(closing(15, 0.2)).toMatchObject({ pinched: true, pointing: true })
  })

  it('chooses the most confident hand and stays with it, even when the other becomes more confident', () => {
    const analyser = new HandAnalyser()
    const two = (a: number, b: number) => [
      hand({ handId: 'a', handedness: 'right', confidence: a }),
      hand({ handId: 'b', handedness: 'left', confidence: b })
    ]
    expect(
      analyser.analyse(at(1, two(0.7, 0.9))).map((hand) => [hand.handId, hand.active])
    ).toEqual([
      ['a', false],
      ['b', true]
    ])
    expect(analyser.analyse(at(2, two(0.99, 0.5))).map((hand) => hand.active)).toEqual([
      false,
      true
    ])
  })

  it('chooses again once no hand has been seen for long enough, but not after a blink', () => {
    const analyser = new HandAnalyser()
    const two = (a: number, b: number) => [
      hand({ handId: 'a', confidence: a }),
      hand({ handId: 'b', handedness: 'left', confidence: b })
    ]
    analyser.analyse(at(1, two(0.5, 0.9)))
    analyser.analyse(at(2, []))
    expect(analyser.analyse(at(3, two(0.99, 0.5))).map((h) => h.active)).toEqual([false, true])
    // Hands gone for the time that counts as lost: the next choice is fresh.
    analyser.analyse(at(4, []))
    const later = at(4 + Math.ceil(DEFAULT_TUNING.lostAfterMs / 33) + 1, [])
    analyser.analyse(later)
    const back = frame(generation, later.sequence + 1, later.capturedAtMs + 33, two(0.99, 0.5))
    expect(analyser.analyse(back).map((h) => h.active)).toEqual([true, false])
  })

  it('starts a hand that left over when it returns', () => {
    const analyser = new HandAnalyser()
    analyser.analyse(at(1, [hand({ pose: 'pointing' })]))
    analyser.analyse(at(2, [hand({ pose: 'pointing', handId: 'other' })]))
    // The first hand is back, but its pointing pose was forgotten, so it needs the strict thresholds again.
    // A little bent: reaches 1.45, enough to keep pointing but not to start.
    const bent = hand({ pose: 'pointing', fingertip: { x: 0.5, y: 0.41 } })
    expect(analyser.analyse(at(3, [bent]))[0]).toMatchObject({ pointing: false })
  })

  it('tells frames a second once enough have come, over the last second only', () => {
    const analyser = new HandAnalyser()
    expect(analyser.fps()).toBeNull()
    analyser.analyse(at(1, []))
    analyser.analyse(at(2, []))
    expect(analyser.fps()).toBeNull()
    for (let sequence = 3; sequence <= 40; sequence++) analyser.analyse(at(sequence, []))
    expect(analyser.fps()).toBeGreaterThan(29)
    expect(analyser.fps()).toBeLessThan(31)
    // A slow stretch brings the number down.
    for (let sequence = 41; sequence <= 46; sequence++)
      analyser.analyse(frame(generation, sequence, 40 * 33 + (sequence - 40) * 250, []))
    expect(analyser.fps()).toBeLessThan(10)
  })

  it('forgets everything on reset', () => {
    const analyser = new HandAnalyser()
    for (let sequence = 1; sequence <= 5; sequence++) analyser.analyse(at(sequence, [hand()]))
    analyser.reset()
    expect(analyser.fps()).toBeNull()
    expect(analyser.analyse(at(6, [hand({ handId: 'z', confidence: 0.1 })]))[0]!.active).toBe(true)
  })
})

describe('the thresholds the view shows', () => {
  it('are the ones the control judges by', () => {
    expect(thresholdsOf()).toEqual({
      pinchEnter: DEFAULT_TUNING.pinch.enter,
      pinchExit: DEFAULT_TUNING.pinch.exit,
      indexEnter: DEFAULT_TUNING.pose.indexExtended.enter,
      indexKeep: DEFAULT_TUNING.pose.indexExtended.keep,
      othersEnter: DEFAULT_TUNING.pose.othersCurled.enter,
      othersKeep: DEFAULT_TUNING.pose.othersCurled.keep
    })
  })
})
