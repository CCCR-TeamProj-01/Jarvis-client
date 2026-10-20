import type { Generation, Result } from '../../../shared/contracts/common'
import type { CompletedUtterance } from '../../../shared/contracts/speech'
import type { LocalExecutionOptions } from '../../ports'

/** Identifies one turn of a conversation so late answers can be told apart and dropped. */
export interface SpeechTurn {
  requestId: string
  /** The speech session and its state version at the time of the request. */
  session: Generation
}

export type Transcription = { status: 'transcribed'; text: string } | { status: 'empty' }

export interface SpokenResponse {
  /** What to show, and the fallback when the audio cannot be produced or played. */
  text: string
  audio?: { mimeType: string; bytes: Uint8Array }
  /** The server decided the conversation is over, so the session should not wait for a follow-up. */
  endConversation?: boolean
}

/**
 * The server's speech service as the client sees it. Only a finished utterance is ever sent. The
 * two steps may be one exchange on the wire; they are separate here so the session can show
 * "recognising" and "working on it" honestly. Audio is neither stored nor retried by callers.
 */
export interface RemoteSpeechPort {
  transcribe(
    turn: SpeechTurn,
    utterance: CompletedUtterance,
    options?: LocalExecutionOptions
  ): Promise<Result<Transcription>>
  respond(
    turn: SpeechTurn,
    text: string,
    options?: LocalExecutionOptions
  ): Promise<Result<SpokenResponse>>
}
