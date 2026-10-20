import { describe, expect, it } from 'vitest'
import { floatToPcm16, PcmFramer } from '../../src/renderer/media/audio-capture/pcm-framer'
import { PcmRingBuffer } from '../../src/renderer/media/audio-capture/pcm-ring-buffer'

const ramp = (from: number, count: number) => Int16Array.from({ length: count }, (_, i) => from + i)

describe('PcmRingBuffer', () => {
  it('addresses samples by absolute index and returns exact copies', () => {
    const buffer = new PcmRingBuffer(100)
    expect(buffer.append(ramp(0, 30))).toBe(0)
    expect(buffer.append(ramp(30, 20))).toBe(30)
    expect(buffer.read(25, 10)).toEqual(ramp(25, 10))
    expect(buffer.endSample).toBe(50)
    const copy = buffer.read(0, 5)!
    copy[0] = 999
    expect(buffer.read(0, 1)).toEqual(Int16Array.of(0))
  })

  it('drops the oldest samples past capacity and refuses what was dropped', () => {
    const buffer = new PcmRingBuffer(50)
    buffer.append(ramp(0, 40))
    buffer.append(ramp(40, 30))
    expect(buffer.startSample).toBe(20)
    expect(buffer.read(0, 10)).toBeNull()
    expect(buffer.read(19, 5)).toBeNull()
    expect(buffer.read(20, 50)).toEqual(ramp(20, 50))
  })

  it('wraps around the end of its storage correctly', () => {
    const buffer = new PcmRingBuffer(8)
    for (let i = 0; i < 5; i++) buffer.append(ramp(i * 3, 3))
    expect(buffer.read(7, 8)).toEqual(ramp(7, 8))
  })

  it('keeps only the newest samples when one append exceeds capacity, still counting all', () => {
    const buffer = new PcmRingBuffer(10)
    expect(buffer.append(ramp(0, 25))).toBe(0)
    expect(buffer.endSample).toBe(25)
    expect(buffer.read(15, 10)).toEqual(ramp(15, 10))
    expect(buffer.read(14, 2)).toBeNull()
  })

  it('refuses ranges that are not captured yet or are malformed', () => {
    const buffer = new PcmRingBuffer(20)
    buffer.append(ramp(0, 10))
    expect(buffer.read(5, 10)).toBeNull()
    expect(buffer.read(-1, 3)).toBeNull()
    expect(buffer.read(0, 0)).toBeNull()
    expect(buffer.read(0.5, 2)).toBeNull()
  })

  it('forgets everything on clear but keeps counting, so old ranges never come back', () => {
    const buffer = new PcmRingBuffer(20)
    buffer.append(ramp(0, 10))
    buffer.clear()
    expect(buffer.read(0, 10)).toBeNull()
    expect(buffer.append(ramp(100, 5))).toBe(10)
    expect(buffer.read(10, 5)).toEqual(ramp(100, 5))
    expect(buffer.read(5, 10)).toBeNull()
  })

  it('rejects a nonsensical capacity', () => {
    expect(() => new PcmRingBuffer(0)).toThrow(RangeError)
    expect(() => new PcmRingBuffer(1.5)).toThrow(RangeError)
  })
})

describe('PcmFramer and floatToPcm16', () => {
  it('regroups irregular blocks into fixed chunks without losing or reordering samples', () => {
    const framer = new PcmFramer(4)
    expect(framer.push(ramp(0, 3))).toEqual([])
    expect(framer.pendingSamples).toBe(3)
    const chunks = framer.push(ramp(3, 6))
    expect(chunks).toEqual([ramp(0, 4), ramp(4, 4)])
    expect(framer.pendingSamples).toBe(1)
    expect(framer.push(ramp(9, 3))).toEqual([ramp(8, 4)])
    framer.reset()
    expect(framer.pendingSamples).toBe(0)
  })

  it('converts and clamps float samples', () => {
    expect(floatToPcm16(Float32Array.of(0, 1, -1, 2, -2, 0.5))).toEqual(
      Int16Array.of(0, 32767, -32768, 32767, -32768, 16384)
    )
  })
})
