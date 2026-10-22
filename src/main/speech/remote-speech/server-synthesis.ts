import type { Result } from '../../../shared/contracts/common'
import type { ServerClient } from '../../connection/server-client'

/** The server turns at most this many characters into speech. */
export const MAX_SPOKEN_CHARS = 300
/** A spoken sentence is a few hundred KB of MP3 at most; more than this is not speech. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024

export interface SynthesizedAudio {
  mimeType: string
  bytes: Uint8Array
}

export interface Synthesizer {
  synthesize(text: string, signal?: AbortSignal): Promise<Result<SynthesizedAudio>>
}

/**
 * The part of an answer that is spoken. The full text is always shown; speech is capped by the
 * server, so a long answer is read up to the last whole sentence that fits.
 */
export function speakableText(text: string): string {
  const trimmed = text.trim()
  if ([...trimmed].length <= MAX_SPOKEN_CHARS) return trimmed
  const characters = [...trimmed].slice(0, MAX_SPOKEN_CHARS)
  const head = characters.join('')
  const lastStop = Math.max(...['.', '!', '?', '。', '\n'].map((mark) => head.lastIndexOf(mark)))
  // A sentence break that leaves almost nothing is worse than a cut at the limit.
  return (lastStop >= MAX_SPOKEN_CHARS / 3 ? head.slice(0, lastStop + 1) : head).trim()
}

/** `POST /speech/syntheses`: the answer as MP3. Failing to make audio is not failing the answer. */
export class ServerSynthesizer implements Synthesizer {
  constructor(private readonly client: ServerClient) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<Result<SynthesizedAudio>> {
    const spoken = speakableText(text)
    if (spoken === '')
      return { ok: false, error: { code: 'invalid_input', message: '읽어 줄 내용이 없어요.' } }
    const result = await this.client.requestBytes({
      method: 'POST',
      path: '/speech/syntheses',
      body: { text: spoken },
      accept: 'audio/mpeg',
      maxResponseBytes: MAX_AUDIO_BYTES,
      ...(signal ? { signal } : {})
    })
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, value: result.value }
  }
}
