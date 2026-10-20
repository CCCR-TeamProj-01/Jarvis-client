import type { ClientError, Generation, Result } from '../../../shared/contracts/common'
import { sameGeneration } from '../../../shared/contracts/common'
import type {
  CompletedUtterance,
  PcmChunk,
  PcmFormat,
  UtteranceRange
} from '../../../shared/contracts/speech'
import { floatToPcm16, PcmFramer } from './pcm-framer'
import { PcmRingBuffer } from './pcm-ring-buffer'

interface CaptureSessionOptions {
  generation: Generation
  format: PcmFormat
  /** How much history can be extracted afterwards. */
  bufferSeconds: number
  /** Size of the chunks sent to Main. */
  chunkMs: number
  emit(chunk: PcmChunk): void
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

function toBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  // Explicitly little endian, whatever the host is.
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true)
  return bytes
}

/**
 * One continuous microphone capture. Samples arrive from the audio callback in small blocks; they
 * are kept in a bounded history and also sent on in steady, gap-free chunks. Both use the same
 * absolute sample numbers, so a range VAD reports can be pulled back out of the history exactly.
 */
export class CaptureSession {
  readonly generation: Generation
  private readonly buffer: PcmRingBuffer
  private readonly framer: PcmFramer
  private readonly chunkSamples: number
  private sequence = 0
  private emitted = 0

  constructor(private readonly options: CaptureSessionOptions) {
    this.generation = options.generation
    const rate = options.format.sampleRateHz
    this.buffer = new PcmRingBuffer(Math.round(options.bufferSeconds * rate))
    this.chunkSamples = Math.max(1, Math.round((options.chunkMs / 1000) * rate))
    this.framer = new PcmFramer(this.chunkSamples)
  }

  ingest(samples: Float32Array): void {
    const pcm = floatToPcm16(samples)
    this.buffer.append(pcm)
    for (const chunk of this.framer.push(pcm)) {
      this.options.emit({
        generation: this.generation,
        sequence: this.sequence++,
        startSample: this.emitted,
        format: this.options.format,
        audio: toBytes(chunk)
      })
      this.emitted += chunk.length
    }
  }

  /** Forget the history; streaming continues and indices keep counting. */
  clear(): void {
    this.buffer.clear()
  }

  extract(range: UtteranceRange): Result<CompletedUtterance> {
    if (!sameGeneration(range.generation, this.generation))
      return failure('conflict', '다른 수집 세대의 발화입니다.')
    const samples = this.buffer.read(range.startSample, range.sampleCount)
    if (!samples) return failure('not_found', '요청한 구간이 버퍼에 남아 있지 않습니다.')
    return {
      ok: true,
      value: {
        utteranceId: range.utteranceId,
        generation: range.generation,
        startSample: range.startSample,
        sampleCount: range.sampleCount,
        format: this.options.format,
        audio: toBytes(samples)
      }
    }
  }

  /** Drop everything; used when the capture ends so no audio outlives it. */
  dispose(): void {
    this.buffer.clear()
    this.framer.reset()
  }
}
