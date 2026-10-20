import type { ClientError, Generation, Result, Unsubscribe } from '../shared/contracts/common'
import type { PcmChunk, PcmFormat, VadEvent, WakeWordEvent } from '../shared/contracts/speech'
import type { VadPolicy } from './vad/vad-policy'

export interface WakeWordDetectorPort {
  start(generation: Generation, format: PcmFormat): Promise<Result<void>>
  push(chunk: PcmChunk): Result<void>
  reset(generation: Generation): void
  stop(): Promise<void>
  subscribe(listener: (event: WakeWordEvent) => void): Unsubscribe
  subscribeErrors(listener: (error: ClientError) => void): Unsubscribe
}

export interface VoiceActivityDetectorStart {
  policy: VadPolicy
  /** Absolute index of the first sample that will be pushed. */
  firstSample: number
}

export interface VoiceActivityDetectorPort {
  /** Listens for one utterance. A new `start` is needed for the next one. */
  start(
    generation: Generation,
    format: PcmFormat,
    options: VoiceActivityDetectorStart
  ): Promise<Result<void>>
  push(chunk: PcmChunk): Result<void>
  reset(generation: Generation): void
  stop(): Promise<void>
  subscribe(listener: (event: VadEvent) => void): Unsubscribe
  subscribeErrors(listener: (error: ClientError) => void): Unsubscribe
}
