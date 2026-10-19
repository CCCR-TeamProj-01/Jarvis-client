import type { ClientError, Generation, Result, Unsubscribe } from '../shared/contracts/common'
import type { PcmChunk, PcmFormat, VadEvent, WakeWordEvent } from '../shared/contracts/speech'

export interface WakeWordDetectorPort {
  start(generation: Generation, format: PcmFormat): Promise<Result<void>>
  push(chunk: PcmChunk): Result<void>
  reset(generation: Generation): void
  stop(): Promise<void>
  subscribe(listener: (event: WakeWordEvent) => void): Unsubscribe
  subscribeErrors(listener: (error: ClientError) => void): Unsubscribe
}

export interface VoiceActivityDetectorPort {
  start(generation: Generation, format: PcmFormat): Promise<Result<void>>
  push(chunk: PcmChunk): Result<void>
  reset(generation: Generation): void
  stop(): Promise<void>
  subscribe(listener: (event: VadEvent) => void): Unsubscribe
  subscribeErrors(listener: (error: ClientError) => void): Unsubscribe
}
