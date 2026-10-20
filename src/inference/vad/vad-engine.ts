import type { Generation } from '../../shared/contracts/common'
import type { VadEvent } from '../../shared/contracts/speech'
import type { VadPolicy } from './vad-policy'

/** One finished stretch of speech found by the model, in samples since the detector was reset. */
export interface DetectedSegment {
  start: number
  length: number
}

/** The acoustic model, behind an interface so the timing logic can be tested without it. */
export interface Segmenter {
  /** Feed samples in stream order. */
  accept(samples: Float32Array): void
  /** True while speech is currently being heard (before its segment is complete). */
  isSpeaking(): boolean
  /** Completed segments, oldest first; each is returned once. */
  takeSegments(): DetectedSegment[]
  reset(): void
}

interface VadEngineOptions {
  segmenter: Segmenter
  policy: VadPolicy
  sampleRateHz: number
  createId(): string
}

/**
 * Turns segments into the events the speech session uses. It tracks absolute sample positions
 * (so ranges can be extracted from the capture buffer later), applies the start-wait timeout and
 * pre-roll, and finishes after one utterance: the next one needs a new `start`.
 */
export class VadEngine {
  private generation: Generation | null = null
  /** Absolute index of the first sample fed since `start`. */
  private base = 0
  private fed = 0
  private announcedStart = false
  private finished = true

  constructor(private readonly options: VadEngineOptions) {}

  get active(): boolean {
    return !this.finished
  }

  start(generation: Generation, firstSample: number): void {
    this.options.segmenter.reset()
    this.generation = generation
    this.base = firstSample
    this.fed = 0
    this.announcedStart = false
    this.finished = false
  }

  stop(): void {
    this.finished = true
    this.generation = null
    this.options.segmenter.reset()
  }

  /**
   * `startSample` is the absolute index of `samples[0]`. A jump in it means audio was lost, so the
   * collection ends rather than joining unrelated stretches.
   */
  push(startSample: number, samples: Float32Array): VadEvent[] {
    if (this.finished || !this.generation) return []
    if (startSample !== this.base + this.fed) {
      this.stop()
      return []
    }
    const { segmenter, policy, sampleRateHz } = this.options
    const generation = this.generation
    segmenter.accept(samples)
    this.fed += samples.length
    const events: VadEvent[] = []

    const speaking = segmenter.isSpeaking()
    if (speaking && !this.announcedStart) {
      this.announcedStart = true
      events.push({ type: 'speech.started', generation, startSample: this.base + this.fed })
    }

    const msToSamples = (ms: number) => Math.round((ms / 1000) * sampleRateHz)
    for (const segment of segmenter.takeSegments()) {
      if (segment.length < msToSamples(policy.minSpeechMs)) continue
      const preRoll = msToSamples(policy.preRollMs)
      const start = Math.max(this.base, this.base + segment.start - preRoll)
      const end = this.base + segment.start + segment.length
      const maxSamples = msToSamples(policy.maxUtteranceMs)
      const reason = end - (this.base + segment.start) >= maxSamples ? 'max_duration' : 'silence'
      events.push({
        type: 'speech.completed',
        range: {
          utteranceId: this.options.createId(),
          generation,
          startSample: start,
          sampleCount: end - start
        },
        reason
      })
      this.finished = true
      return events
    }

    if (!this.announcedStart && this.fed >= msToSamples(policy.startWaitMs)) {
      events.push({ type: 'speech.empty', generation, reason: 'timeout' })
      this.finished = true
    }
    return events
  }
}
