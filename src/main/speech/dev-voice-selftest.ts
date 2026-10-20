import type { AuthPort } from '../auth/auth-manager'
import type { VoiceInput } from './voice-input'

const generation = { sessionId: 'voice-selftest', revision: 0 }

/**
 * Development only (unpackaged app with JARVIS_VOICE_SELFTEST=<number of utterances>): once signed
 * in, listen for that many utterances in a row and print what was found, without the audio. With
 * Chromium's fake microphone reading a WAV file this exercises the real capture, VAD and
 * extraction path with no consumer feature.
 */
export function startVoiceSelfTest(
  count: number,
  auth: Pick<AuthPort, 'subscribe'>,
  voice: VoiceInput,
  log: (line: string) => void = console.log
): () => void {
  const print = (label: string, value: unknown) =>
    log(`VOICE_SELFTEST ${label} ${JSON.stringify(value)}`)
  const run = async () => {
    for (let index = 0; index < count; index++) {
      const result = await voice.listen({ generation: { ...generation, revision: index } })
      if (!result.ok) return print('error', result.error)
      if (result.value.kind === 'empty') {
        print('empty', { index, reason: result.value.reason })
        continue
      }
      const { utterance, reason } = result.value
      const samples = new DataView(
        utterance.audio.buffer,
        utterance.audio.byteOffset,
        utterance.audio.byteLength
      )
      let peak = 0
      for (let i = 0; i < utterance.sampleCount; i++)
        peak = Math.max(peak, Math.abs(samples.getInt16(i * 2, true)))
      print('utterance', {
        index,
        reason,
        startSample: utterance.startSample,
        sampleCount: utterance.sampleCount,
        bytes: utterance.audio.byteLength,
        seconds: utterance.sampleCount / utterance.format.sampleRateHz,
        peak
      })
    }
    print('done', count)
  }
  return auth.subscribe((event) => {
    if (event.type === 'auth.state_changed' && event.snapshot.phase === 'signed_in')
      void run().catch((error: unknown) => print('error', String(error)))
  })
}
