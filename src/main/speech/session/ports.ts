import type { ClientError, Generation, Result, Unsubscribe } from '../../../shared/contracts/common'
import type { SpeechSnapshot } from '../../../shared/contracts/speech'
import type { ActivationSource } from '../../interaction/ports'

/** What the user should be told. Audio never appears here. */
export type SpeechNotice =
  | { type: 'transcript'; requestId: string; text: string }
  | { type: 'response'; requestId: string; text: string; spoken: boolean }
  | { type: 'problem'; error: ClientError }

export interface SpeechSessionPort {
  /** Start a conversation. Already running is not an error: the current session is returned. */
  activate(source: ActivationSource): Promise<Result<Generation>>
  /** Invalidate results, cancel work and clean up locally without waiting for the server. */
  stop(): Promise<Result<void>>
  getSnapshot(): SpeechSnapshot
  /** `requestId` is set while a turn is being recognised or worked on. */
  subscribe(listener: (snapshot: SpeechSnapshot, requestId: string | null) => void): Unsubscribe
  subscribeNotices(listener: (notice: SpeechNotice) => void): Unsubscribe
}
