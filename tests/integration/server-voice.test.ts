import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../src/main/conversation/conversation-manager'
import type { ConversationNotice } from '../../src/main/conversation/ports'
import { ServerAssistant } from '../../src/main/conversation/server-assistant'
import { ServerSpeech } from '../../src/main/speech/remote-speech/server-speech'
import { ServerSynthesizer } from '../../src/main/speech/remote-speech/server-synthesis'
import { SpeechSessionController } from '../../src/main/speech/session/speech-session'
import type { SpeechNotice } from '../../src/main/speech/session/ports'
import type { ListenOutcome, VoiceInput } from '../../src/main/speech/voice-input'
import type { Result } from '../../src/shared/contracts/common'
import type { CompletedUtterance, PlaybackEvent } from '../../src/shared/contracts/speech'
import type { AudioPlaybackPort } from '../../src/shared/ports/audio-playback'
import { stopAllFakeServers } from '../fixtures/fake-jarvis-server'
import { signedInApp } from '../fixtures/signed-in-app'
import { waitUntil } from '../helpers/wait'

afterEach(stopAllFakeServers)

const format = { encoding: 'pcm_s16le', sampleRateHz: 16_000, channels: 1 } as const
const utterance = (seconds = 1): CompletedUtterance => ({
  utteranceId: 'u1',
  generation: { sessionId: 'cap', revision: 0 },
  startSample: 0,
  sampleCount: 16_000 * seconds,
  format,
  audio: new Uint8Array(16_000 * seconds * 2).fill(3)
})

/** The voice path in miniature: the real session, conversation and server adapters over HTTP. */
async function voiceApp(
  options: { speechOutput?: boolean; utterances?: CompletedUtterance[] } = {}
) {
  const app = await signedInApp()
  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(ms, 15))
      signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })
  const assistant = new ServerAssistant({
    client: app.api,
    wait,
    synthesizer: new ServerSynthesizer(app.api),
    speechEnabled: () => options.speechOutput ?? true
  })
  let ids = 0
  const schedule = (callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  }
  const conversation = new ConversationManager({
    gate: { check: () => ({ ok: true, value: undefined }) },
    assistant,
    clock: { now: () => performance.now() },
    createId: () => `local-${++ids}`,
    schedule
  })
  const queue = [...(options.utterances ?? [utterance()])]
  const voice = {
    listen: vi.fn<VoiceInput['listen']>(async (): Promise<Result<ListenOutcome>> => {
      const next = queue.shift()
      return next
        ? { ok: true, value: { kind: 'utterance', utterance: next, reason: 'silence' } }
        : { ok: true, value: { kind: 'empty', reason: 'timeout' } }
    })
  }
  const listeners = new Set<(event: PlaybackEvent) => void>()
  const played: { mimeType: string; audio: Uint8Array }[] = []
  const playback: Pick<AudioPlaybackPort, 'play' | 'stop' | 'subscribe'> = {
    play: vi.fn<AudioPlaybackPort['play']>(async (request) => {
      played.push({ mimeType: request.mimeType, audio: request.audio })
      queueMicrotask(() =>
        listeners.forEach((listener) =>
          listener({
            type: 'playback.ended',
            playbackId: request.playbackId,
            generation: request.generation
          } as PlaybackEvent)
        )
      )
      return { ok: true, value: undefined }
    }),
    stop: vi.fn<AudioPlaybackPort['stop']>(async () => ({ ok: true, value: undefined })),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const session = new SpeechSessionController({
    gate: { check: () => ({ ok: true, value: undefined }) },
    voice,
    remote: new ServerSpeech(assistant),
    conversation,
    playback,
    clock: { now: () => performance.now() },
    createId: () => `id-${++ids}`,
    schedule,
    speechOutputEnabled: () => options.speechOutput ?? true
  })
  const conversationNotices: ConversationNotice[] = []
  conversation.subscribeNotices((notice) => conversationNotices.push(notice))
  const speechNotices: SpeechNotice[] = []
  session.subscribeNotices((notice) => speechNotices.push(notice))
  const finished = () => session.getSnapshot().phase === 'idle'
  return { ...app, session, played, conversationNotices, speechNotices, finished, voice }
}

describe('speaking to the server', () => {
  it('sends the utterance, shows the words, shows the answer and reads it aloud', async () => {
    const t = await voiceApp()
    t.fake.transcripts = ['크롬 열어줘']
    await t.session.activate('voice')
    await waitUntil(() => t.played.length === 1)
    await waitUntil(t.finished)

    // One upload, in the format the server takes, and no second submission of the words.
    expect(t.fake.voiceUploads).toHaveLength(1)
    expect(t.fake.voiceUploads[0]).toMatchObject({ filename: 'utterance.wav', bytes: 44 + 32_000 })
    expect(t.fake.processed).toHaveLength(1)
    expect(t.fake.processed[0]?.content).toBe('크롬 열어줘')
    expect(t.fake.count('/conversations')).toBe(1)

    expect(t.conversationNotices).toContainEqual(
      expect.objectContaining({ type: 'user', text: '크롬 열어줘', modality: 'speech' })
    )
    expect(t.conversationNotices).toContainEqual(
      expect.objectContaining({ type: 'assistant', text: expect.stringContaining('크롬 열어줘') })
    )
    // The sentence that was shown is the sentence that was asked to be spoken and then played.
    expect(t.fake.ttsTexts).toHaveLength(1)
    expect(t.played[0]?.mimeType).toBe('audio/mpeg')
    expect(t.played[0]?.audio.byteLength).toBeGreaterThan(0)
  })

  it('does not ask the server for speech when the device is set not to speak', async () => {
    const t = await voiceApp({ speechOutput: false })
    await t.session.activate('voice')
    await waitUntil(() => t.conversationNotices.some((notice) => notice.type === 'assistant'))
    await waitUntil(t.finished)
    expect(t.fake.ttsTexts).toHaveLength(0)
    expect(t.played).toHaveLength(0)
  })

  it('shows the answer as text when the server cannot make the audio', async () => {
    const t = await voiceApp()
    t.fake.ttsFaults = [502]
    await t.session.activate('voice')
    await waitUntil(() => t.conversationNotices.some((notice) => notice.type === 'assistant'))
    await waitUntil(t.finished)
    expect(t.played).toHaveLength(0)
    expect(t.speechNotices.filter((notice) => notice.type === 'problem')).toHaveLength(0)
  })

  it('asks to try again when the server hears nothing, without running anything', async () => {
    const t = await voiceApp({ utterances: [utterance(), utterance()] })
    t.fake.sttModes = ['empty', 'ok']
    await t.session.activate('voice')
    await waitUntil(() => t.fake.voiceUploads.length === 2)
    await waitUntil(() => t.conversationNotices.some((notice) => notice.type === 'assistant'))
    await waitUntil(t.finished)
    expect(t.speechNotices).toContainEqual(
      expect.objectContaining({
        type: 'problem',
        error: expect.objectContaining({ message: expect.stringContaining('다시') })
      })
    )
    // Only the second utterance became a request the server answered.
    expect(t.fake.processed).toHaveLength(2)
    expect(t.conversationNotices.filter((notice) => notice.type === 'assistant')).toHaveLength(1)
  })

  it("reports a recognition failure without the server's wording and stops after two in a row", async () => {
    const t = await voiceApp({ utterances: [utterance(), utterance(), utterance()] })
    t.fake.sttModes = ['error', 'error', 'error']
    await t.session.activate('voice')
    await waitUntil(t.finished)
    expect(t.fake.voiceUploads).toHaveLength(2)
    expect(t.conversationNotices.filter((notice) => notice.type === 'assistant')).toHaveLength(0)
    expect(JSON.stringify(t.speechNotices)).not.toMatch(/STT_FAILED/)
  })

  it('never uploads an utterance the server would refuse', async () => {
    const t = await voiceApp({ utterances: [utterance(25), utterance(25)] })
    await t.session.activate('voice')
    await waitUntil(t.finished)
    expect(t.fake.voiceUploads).toHaveLength(0)
    expect(t.fake.processed).toHaveLength(0)
  })

  it('handles a second spoken turn in the same conversation', async () => {
    const t = await voiceApp({ utterances: [utterance(), utterance()] })
    t.fake.transcripts = ['첫 번째', '두 번째']
    await t.session.activate('voice')
    await waitUntil(() => t.played.length === 2)
    await waitUntil(t.finished)
    expect(t.fake.processed.map((entry) => entry.content)).toEqual(['첫 번째', '두 번째'])
    expect(t.fake.count('/conversations')).toBe(1)
    expect(new Set(t.fake.voiceUploads.map((upload) => upload.requestId)).size).toBe(2)
  })
})
