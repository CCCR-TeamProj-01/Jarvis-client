import { describe, expect, it, vi } from 'vitest'
import { ServerSpeech } from '../../src/main/speech/remote-speech/server-speech'
import type { VoiceUpload } from '../../src/main/speech/remote-speech/server-speech'
import type { CompletedUtterance } from '../../src/shared/contracts/speech'

function utterance(samples: number, rate = 16_000): CompletedUtterance {
  return {
    utteranceId: 'u1',
    generation: { sessionId: 's', revision: 1 },
    startSample: 0,
    sampleCount: samples,
    format: { encoding: 'pcm_s16le', sampleRateHz: rate, channels: 1 },
    audio: new Uint8Array(samples * 2).fill(7)
  }
}
const turn = {
  conversationId: 'local-1',
  requestId: 'turn-1',
  session: { sessionId: 's', revision: 1 }
}

function upload(result: Awaited<ReturnType<VoiceUpload['transcribe']>>) {
  return { transcribe: vi.fn<VoiceUpload['transcribe']>(async () => result) }
}

describe('ServerSpeech', () => {
  it('sends the utterance as a WAV file under the turn and returns what was heard', async () => {
    const heard = { ok: true, value: { status: 'transcribed', text: '크롬 열어줘' } } as const
    const sender = upload(heard)
    const result = await new ServerSpeech(sender).transcribe(turn, utterance(16_000))
    expect(result).toEqual(heard)
    const [sentTurn, wav] = sender.transcribe.mock.calls[0]!
    expect(sentTurn).toEqual({ conversationId: 'local-1', requestId: 'turn-1' })
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF')
    expect(wav.byteLength).toBe(44 + 32_000)
  })

  it('hands the cancel signal on', async () => {
    const sender = upload({ ok: true, value: { status: 'empty' } })
    const abort = new AbortController()
    await new ServerSpeech(sender).transcribe(turn, utterance(16_000), { signal: abort.signal })
    expect(sender.transcribe.mock.calls[0]![2]).toBe(abort.signal)
  })

  it.each([
    ['too short', utterance(800)],
    ['too long', utterance(16_000 * 21)],
    ['at another sample rate', utterance(44_100, 44_100)]
  ])(
    'does not upload an utterance that is %s, and says nothing was heard',
    async (_name, value) => {
      const sender = upload({ ok: true, value: { status: 'transcribed', text: 'x' } })
      expect(await new ServerSpeech(sender).transcribe(turn, value)).toEqual({
        ok: true,
        value: { status: 'empty' }
      })
      expect(sender.transcribe).not.toHaveBeenCalled()
    }
  )

  it('passes a failure on', async () => {
    const error = { code: 'unavailable', message: '서버가 요청을 처리하지 못했어요.' } as const
    const sender = upload({ ok: false, error })
    expect(await new ServerSpeech(sender).transcribe(turn, utterance(16_000))).toEqual({
      ok: false,
      error
    })
  })
})
