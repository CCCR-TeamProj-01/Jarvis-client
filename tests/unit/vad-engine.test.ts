import { describe, expect, it } from 'vitest'
import { VadEngine } from '../../src/inference/vad/vad-engine'
import type { DetectedSegment, Segmenter } from '../../src/inference/vad/vad-engine'
import { DEFAULT_VAD_POLICY } from '../../src/inference/vad/vad-policy'
import type { VadPolicy } from '../../src/inference/vad/vad-policy'

const RATE = 16_000
const generation = { sessionId: 'g', revision: 1 }
const seconds = (s: number) => Math.round(s * RATE)

/** A segmenter driven by the test: speech between two sample positions. */
class ScriptedSegmenter implements Segmenter {
  fed = 0
  resets = 0
  constructor(private readonly speech: { start: number; end: number }[]) {}
  private reported = 0
  accept(samples: Float32Array) {
    this.fed += samples.length
  }
  isSpeaking() {
    return this.speech.some((s) => this.fed > s.start && this.fed <= s.end)
  }
  takeSegments(): DetectedSegment[] {
    const done = this.speech
      .map((s, index) => ({ s, index }))
      .filter(({ s, index }) => index >= this.reported && this.fed >= s.end + seconds(0.7))
    this.reported += done.length
    return done.map(({ s }) => ({ start: s.start, length: s.end - s.start }))
  }
  reset() {
    this.resets++
  }
}

function engineWith(
  speech: { start: number; end: number }[],
  policy: Partial<VadPolicy> = {},
  firstSample = 0
) {
  let id = 0
  const segmenter = new ScriptedSegmenter(speech)
  const engine = new VadEngine({
    segmenter,
    policy: { ...DEFAULT_VAD_POLICY, ...policy },
    sampleRateHz: RATE,
    createId: () => `utt-${++id}`
  })
  engine.start(generation, firstSample)
  return { engine, segmenter }
}

/** Feeds `total` samples in blocks, returning every event produced. */
function feed(engine: VadEngine, firstSample: number, total: number, block = seconds(0.1)) {
  const events = []
  for (let at = 0; at < total; at += block)
    events.push(...engine.push(firstSample + at, new Float32Array(Math.min(block, total - at))))
  return events
}

describe('VadEngine', () => {
  it('announces the start, then completes with the speech range and pre-roll', () => {
    const { engine } = engineWith([{ start: seconds(1), end: seconds(2) }])
    const events = feed(engine, 0, seconds(3))
    expect(events.map((e) => e.type)).toEqual(['speech.started', 'speech.completed'])
    expect(events[1]).toMatchObject({
      type: 'speech.completed',
      reason: 'silence',
      range: {
        utteranceId: 'utt-1',
        generation,
        // 300 ms of pre-roll before the segment start.
        startSample: seconds(1) - seconds(0.3),
        sampleCount: seconds(1) + seconds(0.3)
      }
    })
    expect(engine.active).toBe(false)
  })

  it('uses absolute positions when the first sample is not zero', () => {
    const base = seconds(50)
    const { engine } = engineWith([{ start: seconds(1), end: seconds(2) }], {}, base)
    const events = feed(engine, base, seconds(3))
    const completed = events.find((e) => e.type === 'speech.completed')
    expect(completed).toMatchObject({
      range: { startSample: base + seconds(0.7), sampleCount: seconds(1.3) }
    })
  })

  it('never reaches before the first sample it was given', () => {
    const { engine } = engineWith([{ start: seconds(0.1), end: seconds(1) }])
    const completed = feed(engine, 0, seconds(2)).find((e) => e.type === 'speech.completed')
    expect(completed).toMatchObject({ range: { startSample: 0, sampleCount: seconds(1) } })
  })

  it('reports an empty result when nothing is said within the start wait', () => {
    const { engine } = engineWith([], { startWaitMs: 2_000 })
    const events = feed(engine, 0, seconds(3))
    expect(events).toEqual([{ type: 'speech.empty', generation, reason: 'timeout' }])
    expect(engine.active).toBe(false)
  })

  it('does not time out once speech has begun', () => {
    const { engine } = engineWith([{ start: seconds(0.5), end: seconds(1.5) }], {
      startWaitMs: 1_000
    })
    const events = feed(engine, 0, seconds(3))
    expect(events.map((e) => e.type)).toEqual(['speech.started', 'speech.completed'])
  })

  it('ignores speech shorter than the minimum', () => {
    const { engine } = engineWith([{ start: seconds(1), end: seconds(1.05) }], {
      startWaitMs: 5_000,
      minSpeechMs: 150
    })
    const events = feed(engine, 0, seconds(3))
    expect(events.some((e) => e.type === 'speech.completed')).toBe(false)
    expect(engine.active).toBe(true)
  })

  it('marks an utterance cut at the maximum length', () => {
    const { engine } = engineWith([{ start: seconds(0.5), end: seconds(2.5) }], {
      maxUtteranceMs: 2_000
    })
    const completed = feed(engine, 0, seconds(4)).find((e) => e.type === 'speech.completed')
    expect(completed).toMatchObject({ reason: 'max_duration' })
  })

  it('finishes after one utterance and ignores audio until started again', () => {
    const { engine } = engineWith([
      { start: seconds(0.5), end: seconds(1) },
      { start: seconds(3), end: seconds(3.5) }
    ])
    const first = feed(engine, 0, seconds(2))
    expect(first.filter((e) => e.type === 'speech.completed')).toHaveLength(1)
    expect(engine.push(seconds(2), new Float32Array(1600))).toEqual([])
  })

  it('ends the collection if samples are missing instead of joining unrelated audio', () => {
    const { engine } = engineWith([{ start: seconds(1), end: seconds(2) }])
    feed(engine, 0, seconds(0.5))
    expect(engine.push(seconds(0.5) + 1600, new Float32Array(1600))).toEqual([])
    expect(engine.active).toBe(false)
    expect(engine.push(seconds(0.5) + 3200, new Float32Array(1600))).toEqual([])
  })

  it('can be restarted for the next utterance with a clean detector', () => {
    const { engine, segmenter } = engineWith([{ start: seconds(0.5), end: seconds(1) }])
    feed(engine, 0, seconds(2))
    engine.start({ sessionId: 'g', revision: 2 }, seconds(2))
    expect(engine.active).toBe(true)
    expect(segmenter.resets).toBe(2)
  })

  it('stops cleanly and ignores late audio', () => {
    const { engine } = engineWith([{ start: seconds(1), end: seconds(2) }])
    feed(engine, 0, seconds(0.5))
    engine.stop()
    expect(engine.active).toBe(false)
    expect(engine.push(seconds(0.5), new Float32Array(1600))).toEqual([])
  })
})
