import { describe, expect, it, vi } from 'vitest'
import { MediaAudioPlayback } from '../../src/main/speech/playback'
import { DevRemoteSpeech } from '../../src/main/speech/remote-speech/dev-remote-speech'
import { createRemoteSpeech } from '../../src/main/speech/remote-speech/create-remote-speech'
import { createToneWav } from '../../src/main/speech/remote-speech/tone'
import { unavailableRemoteSpeech } from '../../src/main/speech/remote-speech/unavailable-remote-speech'
import { ElementAudioPlayback } from '../../src/renderer/media/audio-playback/element-playback'
import type { AudioLike } from '../../src/renderer/media/audio-playback/element-playback'
import type { Result } from '../../src/shared/contracts/common'
import type { CompletedUtterance, PlaybackEvent } from '../../src/shared/contracts/speech'
import type { MediaCommand, MediaEvent } from '../../src/shared/ipc/media-api'

const generation = { sessionId: 's', revision: 1 }
const request = (playbackId = 'p1', gen = generation) => ({
  playbackId,
  generation: gen,
  mimeType: 'audio/wav',
  audio: new Uint8Array([1, 2, 3])
})

class FakeAudio implements AudioLike {
  src = ''
  paused = false
  playResult: Promise<void> = Promise.resolve()
  private listeners = new Map<string, Set<() => void>>()
  play() {
    return this.playResult
  }
  pause() {
    this.paused = true
  }
  addEventListener(type: 'playing' | 'ended' | 'error', listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: 'playing' | 'ended' | 'error', listener: () => void) {
    this.listeners.get(type)?.delete(listener)
  }
  fire(type: 'playing' | 'ended' | 'error') {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0
  }
}

function setupElement(createAudio?: () => AudioLike) {
  const audios: FakeAudio[] = []
  const urls = new Set<string>()
  let counter = 0
  const playback = new ElementAudioPlayback({
    createAudio:
      createAudio ??
      (() => {
        const audio = new FakeAudio()
        audios.push(audio)
        return audio
      }),
    createUrl: () => {
      const url = `blob:${++counter}`
      urls.add(url)
      return url
    },
    revokeUrl: (url) => urls.delete(url)
  })
  const events: PlaybackEvent[] = []
  playback.subscribe((event) => events.push(event))
  return { playback, audios, urls, events }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('ElementAudioPlayback', () => {
  it('accepts a request, then reports the real start and end', async () => {
    const { playback, audios, events, urls } = setupElement()
    expect(await playback.play(request())).toEqual({ ok: true, value: undefined })
    expect(events).toEqual([])
    audios[0].fire('playing')
    audios[0].fire('playing')
    audios[0].fire('ended')
    expect(events.map((e) => e.type)).toEqual(['playback.started', 'playback.ended'])
    expect(events[0]).toMatchObject({ playbackId: 'p1', generation })
    expect(urls.size).toBe(0)
    expect(audios[0].count('ended')).toBe(0)
  })

  it('stops a playback on request and reports it exactly once', async () => {
    const { playback, audios, events } = setupElement()
    await playback.play(request())
    audios[0].fire('playing')
    expect(await playback.stop('p1', generation)).toEqual({ ok: true, value: undefined })
    audios[0].fire('ended')
    expect(events.map((e) => e.type)).toEqual(['playback.started', 'playback.stopped'])
    expect(audios[0].paused).toBe(true)
  })

  it('stops only the playback it was asked about', async () => {
    const { playback, events } = setupElement()
    await playback.play(request('p1'))
    await playback.stop('other', generation)
    await playback.stop('p1', { sessionId: 'someone-else', revision: 0 })
    expect(events).toEqual([])
    await playback.stop('p1', generation)
    expect(events.map((e) => e.type)).toEqual(['playback.stopped'])
    await playback.stop('p1', generation)
    expect(events).toHaveLength(1)
  })

  it('replaces the previous playback with a new one', async () => {
    const { playback, audios, events, urls } = setupElement()
    await playback.play(request('first'))
    await playback.play(request('second'))
    expect(events).toMatchObject([{ type: 'playback.stopped', playbackId: 'first' }])
    expect(audios[0].paused).toBe(true)
    audios[1].fire('ended')
    expect(events.at(-1)).toMatchObject({ type: 'playback.ended', playbackId: 'second' })
    expect(urls.size).toBe(0)
  })

  it('reports a decoding error as a failure', async () => {
    const { playback, audios, events } = setupElement()
    await playback.play(request())
    audios[0].fire('error')
    expect(events).toMatchObject([{ type: 'playback.failed', error: { code: 'unsupported' } }])
  })

  it('reports a blocked play() as a failure', async () => {
    const { playback, audios, events } = setupElement(() => {
      const audio = new FakeAudio()
      audio.playResult = Promise.reject(new Error('NotAllowedError'))
      audios.push(audio)
      return audio
    })
    await playback.play(request())
    await flush()
    expect(events).toMatchObject([{ type: 'playback.failed', error: { code: 'unavailable' } }])
  })

  it('refuses a request it cannot prepare', async () => {
    const { playback } = setupElement(() => {
      throw new Error('no audio')
    })
    expect(await playback.play(request())).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('stops and silences everything on dispose', async () => {
    const { playback, events, urls } = setupElement()
    await playback.play(request())
    playback.dispose()
    expect(events.map((e) => e.type)).toEqual(['playback.stopped'])
    expect(urls.size).toBe(0)
  })
})

describe('MediaAudioPlayback', () => {
  function setup(result: Result<void> = { ok: true, value: undefined }) {
    let publish: (event: MediaEvent) => void = () => undefined
    const commands: MediaCommand[] = []
    const bridge = {
      subscribe: (listener: (event: MediaEvent) => void) => {
        publish = listener
        return () => undefined
      },
      command: vi.fn<(command: MediaCommand, timeoutMs: number) => Promise<Result<void>>>(
        async (command) => {
          commands.push(command)
          return result
        }
      )
    }
    const playback = new MediaAudioPlayback(bridge)
    const events: PlaybackEvent[] = []
    playback.subscribe((event) => events.push(event))
    return { playback, commands, publish: (event: MediaEvent) => publish(event), events }
  }

  it('sends start and stop commands and returns whether they were accepted', async () => {
    const { playback, commands } = setup()
    const req = request()
    expect(await playback.play(req)).toEqual({ ok: true, value: undefined })
    expect(await playback.stop('p1', generation)).toEqual({ ok: true, value: undefined })
    expect(commands).toEqual([
      { type: 'audio.playback.start', request: req },
      { type: 'audio.playback.stop', playbackId: 'p1', generation }
    ])
  })

  it('relays playback events and ignores other media events', () => {
    const { publish, events } = setup()
    const event: PlaybackEvent = { type: 'playback.ended', playbackId: 'p1', generation }
    publish({ type: 'audio.playback', event })
    publish({ type: 'camera.state', generation, state: 'stopped' })
    expect(events).toEqual([event])
  })

  it('reports a refusal from the renderer', async () => {
    const { playback } = setup({ ok: false, error: { code: 'unsupported', message: '지원 안 함' } })
    expect(await playback.play(request())).toMatchObject({
      ok: false,
      error: { code: 'unsupported' }
    })
  })
})

describe('server stand-in', () => {
  const utterance: CompletedUtterance = {
    utteranceId: 'u',
    generation,
    startSample: 0,
    sampleCount: 32000,
    format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
    audio: new Uint8Array(64000)
  }
  const turn = { requestId: 'r', session: generation }

  it('answers with fixed text and a short WAV tone, and ends after the configured turns', async () => {
    const server = new DevRemoteSpeech({ endAfterTurns: 2 })
    expect(await server.transcribe(turn, utterance)).toEqual({
      ok: true,
      value: { status: 'transcribed', text: '(개발용 인식) 2.0초 길이의 발화' }
    })
    const first = await server.respond(turn, '안녕')
    expect(first).toMatchObject({ ok: true, value: { audio: { mimeType: 'audio/wav' } } })
    expect(first).not.toHaveProperty('value.endConversation')
    expect(await server.respond(turn, '안녕')).toMatchObject({
      ok: true,
      value: { endConversation: true }
    })
  })

  it('only measures the audio it receives', async () => {
    const server = new DevRemoteSpeech()
    await server.transcribe(turn, utterance)
    expect(server.calls).toEqual([{ step: 'transcribe', turn, bytes: 64000 }])
  })

  it('can fail, return nothing, reply without audio or be held, from tests', async () => {
    const server = new DevRemoteSpeech({
      failNext: { respond: { code: 'unavailable', message: '실패' } },
      emptyNext: true,
      withoutAudio: true
    })
    expect(await server.transcribe(turn, utterance)).toEqual({
      ok: true,
      value: { status: 'empty' }
    })
    expect(await server.respond(turn, 'x')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    const reply = await server.respond(turn, 'x')
    expect(reply).toMatchObject({ ok: true, value: { text: expect.any(String) } })
    expect(reply).not.toHaveProperty('value.audio')
  })

  it('honours cancellation', async () => {
    const server = new DevRemoteSpeech()
    const controller = new AbortController()
    controller.abort()
    expect(await server.transcribe(turn, utterance, { signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
  })

  it('is chosen only for an unpackaged app that asks for it', async () => {
    expect(
      createRemoteSpeech({ isPackaged: false, env: { JARVIS_DEV_SPEECH: '1' } })
    ).toBeInstanceOf(DevRemoteSpeech)
    expect(createRemoteSpeech({ isPackaged: false, env: {} })).toBe(unavailableRemoteSpeech)
    expect(createRemoteSpeech({ isPackaged: true, env: { JARVIS_DEV_SPEECH: '1' } })).toBe(
      unavailableRemoteSpeech
    )
    expect(await unavailableRemoteSpeech.transcribe(turn, utterance)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
  })

  it('produces a well-formed WAV file', () => {
    const wav = createToneWav({ durationMs: 100, sampleRateHz: 8000 })
    const view = new DataView(wav.buffer)
    const text = (offset: number) => String.fromCharCode(...wav.slice(offset, offset + 4))
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect(view.getUint32(24, true)).toBe(8000)
    expect(view.getUint32(40, true)).toBe(800 * 2)
    expect(wav.byteLength).toBe(44 + 800 * 2)
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8)
  })
})
