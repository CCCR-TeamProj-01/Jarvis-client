import { describe, expect, it } from 'vitest'
import { ActiveHandSelector } from '../../src/main/gesture/active-hand'
import { toDesktopPoint, toRegionPosition } from '../../src/main/gesture/cursor-mapper'
import { explainPointing, fingerExtensions, PointingPose } from '../../src/main/gesture/finger-pose'
import { FrameClock } from '../../src/main/gesture/frame-clock'
import { OneEuroFilter2D } from '../../src/main/gesture/one-euro-filter'
import { PinchDetector, pinchRatio } from '../../src/main/gesture/pinch-detector'
import { DEFAULT_TUNING } from '../../src/main/gesture/tuning'
import { hand } from '../fixtures/hands'

const region = { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 }
const display = { displayId: 'd1', x: 100, y: -50, width: 1000, height: 500, scaleFactor: 2 }

describe('cursor mapping', () => {
  it('follows the hand like a mirror: right in the user’s view is left in the picture', () => {
    const left = toRegionPosition({ x: 0.2, y: 0.5 }, region)
    const right = toRegionPosition({ x: 0.8, y: 0.5 }, region)
    expect(left.x).toBeGreaterThan(right.x)
    expect(toRegionPosition({ x: 0.1, y: 0.5 }, region).x).toBe(1)
    expect(toRegionPosition({ x: 0.9, y: 0.5 }, region).x).toBe(0)
  })

  it('spans the whole screen across the region and clamps outside it', () => {
    expect(toRegionPosition({ x: 0.5, y: 0.1 }, region)).toEqual({ x: 0.5, y: 0 })
    expect(toRegionPosition({ x: 0.5, y: 0.9 }, region)).toEqual({ x: 0.5, y: 1 })
    expect(toRegionPosition({ x: 0, y: 0 }, region)).toEqual({ x: 1, y: 0 })
    expect(toRegionPosition({ x: 1, y: 1 }, region)).toEqual({ x: 0, y: 1 })
  })

  it('places positions on the display, with its offset, and stays inside the last pixel', () => {
    expect(toDesktopPoint({ x: 0, y: 0 }, display)).toEqual({ displayId: 'd1', x: 100, y: -50 })
    expect(toDesktopPoint({ x: 1, y: 1 }, display)).toEqual({ displayId: 'd1', x: 1099, y: 449 })
    expect(toDesktopPoint({ x: 0.5, y: 0.5 }, display).x).toBeCloseTo(599.5)
    expect(toDesktopPoint({ x: 2, y: -1 }, display)).toEqual({ displayId: 'd1', x: 1099, y: -50 })
  })

  it('handles a display left of and above the primary one (negative coordinates)', () => {
    const left = { ...display, x: -1920, y: -200 }
    const point = toDesktopPoint({ x: 0.5, y: 0.5 }, left)
    expect(point.x).toBeLessThan(0)
    expect(point.y).toBeLessThan(300)
  })
})

describe('OneEuroFilter2D', () => {
  const params = DEFAULT_TUNING.smoothing

  it('returns the first sample unchanged', () => {
    const filter = new OneEuroFilter2D(params)
    expect(filter.filter({ x: 0.3, y: 0.7 }, 0)).toEqual({ x: 0.3, y: 0.7 })
  })

  it('damps jitter around a resting position', () => {
    const filter = new OneEuroFilter2D(params)
    const raw: number[] = []
    const smooth: number[] = []
    for (let index = 0; index < 60; index++) {
      const noisy = 0.5 + (index % 2 === 0 ? 0.004 : -0.004)
      raw.push(noisy)
      smooth.push(filter.filter({ x: noisy, y: 0.5 }, index * 33).x)
    }
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values)
    expect(spread(smooth.slice(20))).toBeLessThan(spread(raw.slice(20)) / 2)
  })

  it('keeps up with a fast move instead of lagging far behind', () => {
    const filter = new OneEuroFilter2D(params)
    let last = { x: 0, y: 0 }
    for (let index = 0; index < 10; index++)
      last = filter.filter({ x: index * 0.08, y: 0 }, index * 33)
    expect(0.72 - last.x).toBeLessThan(0.12)
  })

  it('starts fresh after a reset and survives repeated or reversed timestamps', () => {
    const filter = new OneEuroFilter2D(params)
    filter.filter({ x: 0, y: 0 }, 100)
    filter.filter({ x: 0.1, y: 0.1 }, 100)
    expect(Number.isFinite(filter.filter({ x: 0.2, y: 0.2 }, 50).x)).toBe(true)
    filter.reset()
    expect(filter.filter({ x: 0.9, y: 0.9 }, 200)).toEqual({ x: 0.9, y: 0.9 })
  })
})

describe('pinch', () => {
  it('measures thumb–index distance relative to hand size', () => {
    expect(pinchRatio(hand({ pinch: 0.1 }))).toBeCloseTo(0.1)
    expect(pinchRatio(hand({ pinch: 1 }))).toBeCloseTo(1)
  })

  it('has no ratio for a degenerate hand', () => {
    const flat = hand()
    flat.landmarks[9] = { ...flat.landmarks[0]! }
    expect(pinchRatio(flat)).toBeNull()
  })

  const thresholds = { enter: 0.25, exit: 0.45 }

  it('starts once when the fingers close and ends once when they open past the exit threshold', () => {
    const pinch = new PinchDetector(thresholds)
    expect(pinch.update(0.9)).toBeNull()
    expect(pinch.update(0.2)).toBe('started')
    expect(pinch.update(0.1)).toBeNull()
    expect(pinch.update(0.3)).toBeNull()
    expect(pinch.update(0.4)).toBeNull()
    expect(pinch.isPinched).toBe(true)
    expect(pinch.update(0.5)).toBe('ended')
    expect(pinch.isPinched).toBe(false)
  })

  it('does not flicker into several clicks around the enter threshold', () => {
    const pinch = new PinchDetector(thresholds)
    pinch.update(0.9)
    const transitions = [0.24, 0.26, 0.24, 0.27, 0.23].map((ratio) => pinch.update(ratio))
    expect(transitions.filter((transition) => transition === 'started')).toHaveLength(1)
  })

  it('ignores a pinch already held at the start until the hand has opened', () => {
    const pinch = new PinchDetector(thresholds)
    expect(pinch.update(0.1)).toBeNull()
    expect(pinch.update(0.1)).toBeNull()
    expect(pinch.update(0.6)).toBeNull()
    expect(pinch.update(0.1)).toBe('started')
  })

  it('needs the hand to open again after a reset', () => {
    const pinch = new PinchDetector(thresholds)
    pinch.update(0.9)
    pinch.update(0.1)
    pinch.reset()
    expect(pinch.isPinched).toBe(false)
    expect(pinch.update(0.1)).toBeNull()
  })

  it('leaves the state alone when there is no measurement', () => {
    const pinch = new PinchDetector(thresholds)
    pinch.update(0.9)
    pinch.update(0.1)
    expect(pinch.update(null)).toBeNull()
    expect(pinch.isPinched).toBe(true)
  })
})

describe('ActiveHandSelector', () => {
  const left = hand({ handId: 'left', handedness: 'left', confidence: 0.8 })
  const right = hand({ handId: 'right', handedness: 'right', confidence: 0.9 })

  it('follows the chosen physical hand only', () => {
    expect(new ActiveHandSelector('left').select([left, right])?.handId).toBe('left')
    expect(new ActiveHandSelector('right').select([left, right])?.handId).toBe('right')
    expect(new ActiveHandSelector('right').select([left])).toBeNull()
    expect(new ActiveHandSelector('left').select([])).toBeNull()
  })

  it('auto_lock takes the most confident hand and keeps it', () => {
    const selector = new ActiveHandSelector('auto_lock')
    expect(selector.select([left, right])?.handId).toBe('right')
    expect(selector.activeHandId).toBe('right')
    const better = hand({ handId: 'left', handedness: 'left', confidence: 0.99 })
    expect(selector.select([better, right])?.handId).toBe('right')
  })

  it('auto_lock does not jump to the other hand when the locked one disappears', () => {
    const selector = new ActiveHandSelector('auto_lock')
    selector.select([right])
    expect(selector.select([left])).toBeNull()
    expect(selector.select([left, right])?.handId).toBe('right')
  })

  it('auto_lock chooses again after a reset', () => {
    const selector = new ActiveHandSelector('auto_lock')
    selector.select([right])
    selector.reset()
    expect(selector.select([left])?.handId).toBe('left')
  })
})

describe('FrameClock', () => {
  it('reports how much longer than the quickest frame a frame waited, whatever the clock zero', () => {
    const clock = new FrameClock()
    expect(clock.age(1_000, 51_000)).toBe(0)
    expect(clock.age(1_100, 51_105)).toBe(5)
    expect(clock.age(1_200, 51_400)).toBe(200)
  })

  it('forgets old minimums and can be reset', () => {
    const clock = new FrameClock(3)
    clock.age(0, 100)
    clock.age(10, 110)
    clock.age(20, 125)
    clock.age(30, 140)
    // The two quickest frames (difference 100) have left the window, so the baseline moved up.
    expect(clock.age(40, 150)).toBe(5)
    clock.reset()
    expect(clock.age(0, 500)).toBe(0)
  })
})

describe('finger pose', () => {
  const thresholds = DEFAULT_TUNING.pose

  it('measures how far each finger reaches relative to its knuckle', () => {
    const pointing = fingerExtensions(hand({ pose: 'pointing' }))!
    expect(pointing.index).toBeGreaterThan(2)
    expect(Math.max(pointing.middle, pointing.ring, pointing.pinky)).toBeLessThan(1)
    const open = fingerExtensions(hand({ pose: 'open' }))!
    expect(Math.min(open.index, open.middle, open.ring, open.pinky)).toBeGreaterThan(2)
    const fist = fingerExtensions(hand({ pose: 'fist' }))!
    expect(Math.max(fist.index, fist.middle, fist.ring, fist.pinky)).toBeLessThan(1)
  })

  it('does not depend on which way the hand points', () => {
    const upright = hand({ pose: 'pointing' })
    const turned = {
      ...upright,
      landmarks: upright.landmarks.map((point) => ({
        x: 0.5 - (point.y - 0.5),
        y: 0.5 + (point.x - 0.5),
        z: 0
      }))
    }
    const a = fingerExtensions(upright)!
    const b = fingerExtensions(turned)!
    expect(b.index).toBeCloseTo(a.index)
    expect(b.middle).toBeCloseTo(a.middle)
  })

  it('has no extensions for a degenerate hand', () => {
    const flat = hand()
    flat.landmarks[5] = { ...flat.landmarks[0]! }
    expect(fingerExtensions(flat)).toBeNull()
  })

  const pointing = () => fingerExtensions(hand({ pose: 'pointing' }))
  const open = () => fingerExtensions(hand({ pose: 'open' }))

  it('is pointing only with the index out and the others folded', () => {
    const pose = new PointingPose(thresholds)
    expect(pose.update(open(), 0, false)).toBe(false)
    expect(pose.update(fingerExtensions(hand({ pose: 'fist' })), 33, false)).toBe(false)
    expect(pose.update(pointing(), 66, false)).toBe(true)
  })

  it('survives a short miss but not a long one', () => {
    const pose = new PointingPose(thresholds)
    pose.update(pointing(), 0, false)
    expect(pose.update(open(), 100, false)).toBe(true)
    expect(pose.update(open(), 190, false)).toBe(true)
    expect(pose.update(open(), 250, false)).toBe(false)
  })

  it('starts at the strict thresholds and keeps at the loose ones', () => {
    const pose = new PointingPose(thresholds)
    const between = { index: 1.4, middle: 1.4, ring: 1, pinky: 1 }
    expect(pose.update(between, 0, false)).toBe(false)
    pose.update(pointing(), 33, false)
    expect(pose.update(between, 400, false)).toBe(true)
  })

  it('stays while latched, and needs the strict thresholds again after a reset', () => {
    const pose = new PointingPose(thresholds)
    pose.update(pointing(), 0, false)
    expect(pose.update(open(), 5_000, true)).toBe(true)
    pose.reset()
    expect(pose.isPointing).toBe(false)
    expect(pose.update(null, 6_000, true)).toBe(false)
  })

  it('is not pointing without a measurement', () => {
    const pose = new PointingPose(thresholds)
    expect(pose.update(null, 0, false)).toBe(false)
  })
})

describe('explaining the pointing judgement', () => {
  const thresholds = DEFAULT_TUNING.pose
  const at = (index: number, middle: number, ring: number, pinky: number) => ({
    index,
    middle,
    ring,
    pinky
  })

  it('says pointing, with the thresholds that applied, when the checks pass', () => {
    expect(explainPointing(at(1.8, 0.7, 0.7, 0.7), thresholds, 'enter')).toEqual({
      reason: 'pointing',
      finger: null,
      indexNeeds: 1.5,
      othersNeed: 1.3
    })
    expect(explainPointing(at(1.8, 0.7, 0.7, 0.7), thresholds, 'keep')).toMatchObject({
      indexNeeds: 1.35,
      othersNeed: 1.45
    })
  })

  it('names the index finger when it does not reach out far enough', () => {
    expect(explainPointing(at(1.2, 0.7, 0.7, 0.7), thresholds, 'enter')).toMatchObject({
      reason: 'index_short',
      finger: null
    })
    // At the loose thresholds of an ongoing pose the same finger is far enough.
    expect(explainPointing(at(1.4, 0.7, 0.7, 0.7), thresholds, 'enter').reason).toBe('index_short')
    expect(explainPointing(at(1.4, 0.7, 0.7, 0.7), thresholds, 'keep').reason).toBe('pointing')
  })

  it('names the finger that is not folded, the one that reaches furthest', () => {
    expect(explainPointing(at(1.8, 1.6, 0.7, 0.7), thresholds, 'enter')).toMatchObject({
      reason: 'finger_open',
      finger: 'middle'
    })
    expect(explainPointing(at(1.8, 0.7, 1.4, 1.9), thresholds, 'enter')).toMatchObject({
      finger: 'pinky'
    })
    expect(explainPointing(at(1.8, 0.7, 1.5, 1.0), thresholds, 'enter')).toMatchObject({
      finger: 'ring'
    })
    // The loose threshold lets a half-folded finger be.
    expect(explainPointing(at(1.8, 1.4, 0.7, 0.7), thresholds, 'keep').reason).toBe('pointing')
  })

  it('names the index first when both are wrong, since that is the one to fix', () => {
    expect(explainPointing(at(1.0, 1.6, 1.6, 1.6), thresholds, 'enter').reason).toBe('index_short')
  })

  it('says it could not measure for a hand that has no extensions', () => {
    expect(explainPointing(null, thresholds, 'enter')).toMatchObject({
      reason: 'no_measure',
      finger: null
    })
  })

  it('agrees with PointingPose about what is pointing', () => {
    for (const reach of [
      at(1.8, 0.7, 0.7, 0.7),
      at(1.2, 0.7, 0.7, 0.7),
      at(1.8, 1.6, 0.7, 0.7),
      at(1.5, 1.3, 1.3, 1.3),
      at(1.49, 0.7, 0.7, 0.7),
      at(1.5, 1.31, 0.7, 0.7)
    ]) {
      const pose = new PointingPose(thresholds)
      expect(explainPointing(reach, thresholds, 'enter').reason === 'pointing').toBe(
        pose.update(reach, 0, false)
      )
    }
  })
})
