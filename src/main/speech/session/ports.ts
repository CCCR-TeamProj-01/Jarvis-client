import type { Generation, Result, Unsubscribe } from '../../../shared/contracts/common'
import type {
  CompletedUtterance,
  PlaybackEvent,
  PlaybackRequest,
  SpeechSnapshot,
  VadEvent,
  WakeWordEvent
} from '../../../shared/contracts/speech'

export interface SpeechSessionPort {
  activate(): Promise<Result<Generation>>
  /** Invalidate callbacks and clean up locally without awaiting a remote cancellation. */
  stop(): Promise<Result<void>>
  acceptWakeWord(event: WakeWordEvent): void
  acceptVad(event: VadEvent): void
  acceptPlayback(event: PlaybackEvent): void
  playResponse(request: PlaybackRequest): Promise<Result<void>>
  getSnapshot(): SpeechSnapshot
  subscribe(listener: (snapshot: SpeechSnapshot) => void): Unsubscribe
  /** A later remote adapter consumes local utterances through this boundary. */
  subscribeUtterances(listener: (utterance: CompletedUtterance) => void): Unsubscribe
}
