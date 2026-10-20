import { describe, expect, it } from 'vitest'
import { toHandObservations } from '../../src/renderer/media/hand-tracking/landmarks'
import type { RawHandResult } from '../../src/renderer/media/hand-tracking/landmarks'
import { HandObservationSchema } from '../../src/shared/contracts/gesture'

const joints = (offset = 0.5, count = 21) =>
  Array.from({ length: count }, (_, index) => ({ x: offset, y: 0.1 + index / 100, z: -0.02 }))

describe('toHandObservations', () => {
  it('turns engine joints into schema-valid observations', () => {
    const result: RawHandResult = {
      landmarks: [joints()],
      handedness: [[{ categoryName: 'Right', score: 0.93 }]]
    }
    const [hand] = toHandObservations(result)
    expect(HandObservationSchema.safeParse(hand).success).toBe(true)
    expect(hand?.confidence).toBeCloseTo(0.93)
    expect(hand?.landmarks).toHaveLength(21)
  })

  it('swaps left and right because the engine assumes a mirrored image', () => {
    const result: RawHandResult = {
      landmarks: [joints(0.2), joints(0.8)],
      handedness: [[{ categoryName: 'Left', score: 0.9 }], [{ categoryName: 'Right', score: 0.8 }]]
    }
    expect(toHandObservations(result).map((hand) => hand.handedness)).toEqual(['right', 'left'])
  })

  it('keeps hand IDs unique when the engine labels both hands the same', () => {
    const result: RawHandResult = {
      landmarks: [joints(0.2), joints(0.8)],
      handedness: [[{ categoryName: 'Left', score: 0.9 }], [{ categoryName: 'Left', score: 0.7 }]]
    }
    const ids = toHandObservations(result).map((hand) => hand.handId)
    expect(new Set(ids).size).toBe(2)
  })

  it('reports unknown handedness when the label is missing or unfamiliar', () => {
    const result: RawHandResult = {
      landmarks: [joints(), joints()],
      handedness: [[], [{ categoryName: '??', score: 1 }]]
    }
    const hands = toHandObservations(result)
    expect(hands.map((hand) => hand.handedness)).toEqual(['unknown', 'unknown'])
    expect(hands[0]?.confidence).toBe(0)
  })

  it('drops a hand with joints outside the picture or an incomplete hand', () => {
    const outside = joints()
    outside[8] = { x: 1.2, y: 0.5, z: 0 }
    const negative = joints()
    negative[0] = { x: 0.5, y: -0.01, z: 0 }
    const result: RawHandResult = {
      landmarks: [outside, negative, joints(0.5, 20), joints(0.4)],
      handedness: [[], [], [], [{ categoryName: 'Right', score: 0.9 }]]
    }
    const hands = toHandObservations(result)
    expect(hands).toHaveLength(1)
    expect(hands[0]?.landmarks[0]?.x).toBe(0.4)
  })

  it('drops non-finite values and clamps a confidence outside 0..1', () => {
    const broken = joints()
    broken[3] = { x: Number.NaN, y: 0.5, z: 0 }
    const result: RawHandResult = {
      landmarks: [broken, joints()],
      handedness: [[], [{ categoryName: 'Right', score: 1.4 }]]
    }
    const hands = toHandObservations(result)
    expect(hands).toHaveLength(1)
    expect(hands[0]?.confidence).toBe(1)
  })

  it('returns nothing when no hand is seen', () => {
    expect(toHandObservations({ landmarks: [], handedness: [] })).toEqual([])
  })
})
