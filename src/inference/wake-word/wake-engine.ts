import { z } from 'zod'
import type { Generation } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import { isContiguousPcm } from '../../shared/contracts/speech'
import type { PcmChunk, WakeWordEvent } from '../../shared/contracts/speech'
import type { WakeRecognizer } from './vosk-native'
import { WAKE_KEYWORD, WAKE_SAMPLE_RATE } from './protocol'

const WordSchema = z.object({
  word: z.string(),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  conf: z.number().min(0).max(1)
})
const RecognitionSchema = z.object({
  result: z.array(WordSchema).optional(),
  partial_result: z.array(WordSchema).optional()
})

/** One detection per start. Exact dictionary word and timed boundary, never fuzzy substring matching. */
export class WakeEngine {
  private generation: Generation | null = null
  private firstSample: number | null = null
  private previous: PcmChunk | null = null

  constructor(
    private readonly recognizer: WakeRecognizer,
    private readonly confidence = 0.85
  ) {}

  start(generation: Generation): void {
    this.stop()
    this.generation = generation
  }

  stop(): void {
    this.generation = null
    this.firstSample = null
    this.previous = null
    this.recognizer.reset()
  }

  push(chunk: PcmChunk): WakeWordEvent | null {
    if (!this.generation || !sameGeneration(this.generation, chunk.generation)) return null
    if (
      chunk.format.sampleRateHz !== WAKE_SAMPLE_RATE ||
      (this.previous && !isContiguousPcm(this.previous, chunk))
    ) {
      this.stop()
      throw new Error('discontinuous wake audio')
    }
    this.firstSample ??= chunk.startSample
    this.previous = chunk
    const parsed = RecognitionSchema.safeParse(this.recognizer.accept(chunk.audio))
    if (!parsed.success) throw new Error('invalid recognition result')
    const words = parsed.data.result ?? parsed.data.partial_result ?? []
    const match = words.find(
      (word) => word.word === WAKE_KEYWORD && word.conf >= this.confidence && word.end > word.start
    )
    if (!match) return null
    const start = this.firstSample + Math.floor(match.start * WAKE_SAMPLE_RATE)
    const end = this.firstSample + Math.ceil(match.end * WAKE_SAMPLE_RATE)
    const detected = chunk.startSample + chunk.audio.byteLength / 2
    if (end > detected || start >= end) return null
    const event = {
      generation: this.generation,
      keyword: WAKE_KEYWORD,
      keywordStartSample: start,
      keywordEndSample: end,
      detectedAtSample: detected
    }
    this.stop()
    return event
  }
}
