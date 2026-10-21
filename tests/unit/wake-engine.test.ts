import { describe, expect, it, vi } from 'vitest'
import { WakeEngine } from '../../src/inference/wake-word/wake-engine'
import { WakeWorkerRequestSchema } from '../../src/inference/wake-word/protocol'
import type { PcmChunk } from '../../src/shared/contracts/speech'

const generation = { sessionId: 'capture', revision: 1 }
const chunk = (startSample = 16_000, sequence = 0): PcmChunk => ({
  generation,
  sequence,
  startSample,
  format: { encoding: 'pcm_s16le', channels: 1, sampleRateHz: 16_000 },
  audio: new Uint8Array(3_200)
})
const word = (name = '자비스', conf = 0.95) => ({ word: name, start: 0.01, end: 0.08, conf })
const setup = () => {
  const recognizer = { accept: vi.fn<() => unknown>(() => ({})), reset: vi.fn(), dispose: vi.fn() }
  const engine = new WakeEngine(recognizer)
  engine.start(generation)
  return { engine, recognizer }
}

describe('local wake recognition', () => {
  it('maps timed partial words to absolute capture samples and detects once', () => {
    const { engine, recognizer } = setup()
    recognizer.accept.mockReturnValue({ partial_result: [word()] })
    expect(engine.push(chunk())).toEqual({
      generation,
      keyword: '자비스',
      keywordStartSample: 16_160,
      keywordEndSample: 17_280,
      detectedAtSample: 17_600
    })
    expect(engine.push(chunk(17_600, 1))).toBeNull()
    expect(recognizer.accept).toHaveBeenCalledTimes(1)
  })
  it.each(['자비', '자비스야', '<UNK>', '재비스'])('does not trigger on %s', (text) => {
    const { engine, recognizer } = setup()
    recognizer.accept.mockReturnValue({ result: [word(text)] })
    expect(engine.push(chunk())).toBeNull()
  })
  it('requires confidence and a usable boundary rather than a partial text string', () => {
    const { engine, recognizer } = setup()
    recognizer.accept
      .mockReturnValueOnce({ partial: '자비스' })
      .mockReturnValueOnce({ result: [word('자비스', 0.7)] })
      .mockReturnValueOnce({ result: [{ ...word(), end: 50 }] })
    expect(engine.push(chunk())).toBeNull()
    expect(engine.push(chunk(17_600, 1))).toBeNull()
    expect(engine.push(chunk(19_200, 2))).toBeNull()
  })
  it('discards old capture generations without decoding', () => {
    const { engine, recognizer } = setup()
    expect(engine.push({ ...chunk(), generation: { ...generation, revision: 2 } })).toBeNull()
    expect(recognizer.accept).not.toHaveBeenCalled()
  })
  it('fails closed on a gap and stops decoding', () => {
    const { engine, recognizer } = setup()
    engine.push(chunk())
    expect(() => engine.push(chunk(20_000, 1))).toThrow('discontinuous')
    engine.push(chunk(21_600, 2))
    expect(recognizer.accept).toHaveBeenCalledTimes(1)
  })
  it('resets offsets for a new start', () => {
    const { engine, recognizer } = setup()
    recognizer.accept.mockReturnValue({ result: [word()] })
    engine.push(chunk())
    engine.start(generation)
    expect(engine.push(chunk(90_000))).toMatchObject({ keywordStartSample: 90_160 })
  })
  it('bounds the process input and rejects unknown fields', () => {
    expect(WakeWorkerRequestSchema.safeParse({ type: 'pcm', chunk: chunk() }).success).toBe(true)
    expect(
      WakeWorkerRequestSchema.safeParse({
        type: 'pcm',
        chunk: { ...chunk(), audio: new Uint8Array(32_002) }
      }).success
    ).toBe(false)
    expect(WakeWorkerRequestSchema.safeParse({ type: 'stop', execute: 'command' }).success).toBe(
      false
    )
  })
})
