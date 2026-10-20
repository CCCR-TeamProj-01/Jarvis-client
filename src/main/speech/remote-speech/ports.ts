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

/**
 * The server's speech recognition as the client sees it. Only a finished utterance is ever sent,
 * and audio is neither stored nor retried by callers. What to answer is the conversation's
 * business (see `AssistantPort`), whether the words came from here or from the keyboard.
 */
export interface RemoteSpeechPort {
  transcribe(
    turn: SpeechTurn,
    utterance: CompletedUtterance,
    options?: LocalExecutionOptions
  ): Promise<Result<Transcription>>
}
