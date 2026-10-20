import { describe, expect, it } from 'vitest'
import {
  DesktopPointSchema,
  GestureSnapshotSchema,
  HandTrackingFrameSchema,
  canUseTrackingFrame
} from '../../src/shared/contracts/gesture'
import { generation, trackingFrame } from '../fixtures/contracts'

describe('hand tracking data', () => {
  it('accepts 21 normalized landmarks and wrist-relative negative depth', () => {
    expect(HandTrackingFrameSchema.safeParse(trackingFrame()).success).toBe(true)
    expect(HandTrackingFrameSchema.safeParse(trackingFrame({ hands: [] })).success).toBe(true)
  })

  it.each([NaN, Infinity, -0.01, 1.01])('rejects invalid camera x=%s', (x) => {
    const frame = trackingFrame()
    frame.hands[0].landmarks[0].x = x
    expect(HandTrackingFrameSchema.safeParse(frame).success).toBe(false)
  })

  it('rejects missing joints and duplicated hand IDs', () => {
    const frame = trackingFrame()
    expect(
      HandTrackingFrameSchema.safeParse({ ...frame, hands: [frame.hands[0], frame.hands[0]] })
        .success
    ).toBe(false)
    frame.hands[0].landmarks.pop()
    expect(HandTrackingFrameSchema.safeParse(frame).success).toBe(false)
  })

  it('allows negative desktop monitor coordinates while rejecting non-finite positions', () => {
    expect(DesktopPointSchema.parse({ displayId: 'left', x: -1400, y: -300 }).x).toBe(-1400)
    expect(DesktopPointSchema.safeParse({ displayId: 'left', x: Infinity, y: 0 }).success).toBe(
      false
    )
  })

  it('rejects active gesture modes without a generation', () => {
    const snapshot = {
      phase: 'tracking',
      generation: null,
      activeHandId: null,
      displayId: null,
      pointing: false
    }
    expect(GestureSnapshotSchema.safeParse(snapshot).success).toBe(false)
    expect(GestureSnapshotSchema.safeParse({ ...snapshot, generation }).success).toBe(true)
  })
})

describe('frame freshness in its capture clock', () => {
  const options = { generation, afterSequence: null, nowMs: 110, maxAgeMs: 20 }

  it('accepts a recent frame but drops frames completed after stop/restart', () => {
    expect(canUseTrackingFrame(trackingFrame(), options)).toBe(true)
    expect(
      canUseTrackingFrame(trackingFrame(), {
        ...options,
        generation: { ...generation, revision: 2 }
      })
    ).toBe(false)
    expect(
      canUseTrackingFrame(trackingFrame(), {
        ...options,
        generation: { sessionId: 'another-session', revision: 1 }
      })
    ).toBe(false)
  })

  it('drops duplicates and out-of-order results without blocking the next frame', () => {
    expect(canUseTrackingFrame(trackingFrame(), { ...options, afterSequence: 1 })).toBe(false)
    expect(canUseTrackingFrame(trackingFrame(), { ...options, afterSequence: 2 })).toBe(false)
    expect(
      canUseTrackingFrame(trackingFrame({ sequence: 3 }), { ...options, afterSequence: 2 })
    ).toBe(true)
  })

  it('drops expired, future-clock and invalid age-limit frames', () => {
    expect(canUseTrackingFrame(trackingFrame(), { ...options, nowMs: 121 })).toBe(false)
    expect(canUseTrackingFrame(trackingFrame(), { ...options, nowMs: 99 })).toBe(false)
    expect(canUseTrackingFrame(trackingFrame(), { ...options, maxAgeMs: -1 })).toBe(false)
    expect(canUseTrackingFrame(trackingFrame(), { ...options, maxAgeMs: NaN })).toBe(false)
  })
})
