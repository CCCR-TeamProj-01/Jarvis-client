import type { Result } from '../../../shared/contracts/common'
import type { CompletedUtterance } from '../../../shared/contracts/speech'
import type { LocalExecutionOptions } from '../../ports'
import type { RemoteSpeechPort, SpeechTurn, Transcription } from './ports'
import { encodeWav } from './wav'

/** What speech recognition needs from the server side: the turn's audio goes up under its request. */
export interface VoiceUpload {
  transcribe(
    turn: { conversationId: string; requestId: string },
    wav: Uint8Array,
    signal?: AbortSignal
  ): Promise<Result<Transcription>>
}

/**
 * The server recognising what was said. One finished utterance is wrapped as a WAV file and sent
 * once; the audio is not kept and not sent again by this class. The server answers the same
 * request, so the words recognised here are not submitted a second time (see `ServerAssistant`).
 */
export class ServerSpeech implements RemoteSpeechPort {
  constructor(private readonly upload: VoiceUpload) {}

  async transcribe(
    turn: SpeechTurn,
    utterance: CompletedUtterance,
    options?: LocalExecutionOptions
  ): Promise<Result<Transcription>> {
    const wav = encodeWav(utterance.audio, utterance.format)
    // Too short, too long or in a format the server does not take: nothing worth sending.
    if (!wav) return { ok: true, value: { status: 'empty' } }
    return this.upload.transcribe(
      { conversationId: turn.conversationId, requestId: turn.requestId },
      wav,
      options?.signal
    )
  }
}
