import type { ClientError, Generation, Result, Unsubscribe } from '../../../shared/contracts/common'
import type { SpeechSnapshot } from '../../../shared/contracts/speech'
import type { ActivationSource } from '../../interaction/ports'

/** Something about listening or speaking that the user should know. */
export interface SpeechNotice {
  type: 'problem'
  error: ClientError
}

/**
 * The voice side of a conversation: listening, recognising speech and speaking the reply. It
 * attaches to a conversation (starting one if needed) and hands what was said to it; what to
 * answer is the conversation's job.
 */
export interface SpeechSessionPort {
  /** Start listening. Already running is not an error: the current session is returned. */
  activate(source: ActivationSource): Promise<Result<Generation>>
  /** Stop listening and speaking now, locally. The conversation itself is not ended. */
  stop(): Promise<Result<void>>
  getSnapshot(): SpeechSnapshot
  subscribe(listener: (snapshot: SpeechSnapshot) => void): Unsubscribe
  subscribeNotices(listener: (notice: SpeechNotice) => void): Unsubscribe
}
