import type { Generation, Result, Unsubscribe } from '../../../shared/contracts/common'
import type {
  AudioCaptureStart,
  CompletedUtterance,
  PcmChunk,
  UtteranceRange
} from '../../../shared/contracts/speech'

export interface AudioCapturePort {
  start(request: AudioCaptureStart): Promise<Result<void>>
  stop(generation: Generation): Promise<Result<void>>
  clearBuffer(generation: Generation): void
  extractUtterance(range: UtteranceRange): Promise<Result<CompletedUtterance>>
  /** Preserve sample continuity; a gap aborts collection instead of stitching unrelated audio. */
  subscribePcm(listener: (chunk: PcmChunk) => void): Unsubscribe
}
