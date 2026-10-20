import { describe, expect, it, vi } from 'vitest'
import { SpeechSessionController } from '../../src/main/speech/session/speech-session'
import type { SessionPolicy } from '../../src/main/speech/session/speech-session'
import type { SpeechNotice } from '../../src/main/speech/session/ports'
import type { RemoteSpeechPort, SpokenResponse } from '../../src/main/speech/remote-speech/ports'
import type { ListenOutcome, VoiceInput } from '../../src/main/speech/voice-input'
import type { AudioPlaybackPort } from '../../src/renderer/media/audio-playback/ports'
import type { ClientError, Result } from '../../src/shared/contracts/common'
import type {
  CompletedUtterance,
  PlaybackEvent,
  SpeechSnapshot
} from '../../src/shared/contracts/speech'

const format = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 } as const
const utterance = (id = 'u'): CompletedUtterance => ({
  utteranceId: id,
  generation: { sessionId: 'cap', revision: 0 },
  startSample: 0,
  sampleCount: 100,
  format,
  audio: new Uint8Array(200)
})
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const heard = (): Result<ListenOutcome> => ({
  ok: true,
  value: { kind: 'utterance', utterance: utterance(), reason: 'silence' }
})
const empty = (): Result<ListenOutcome> => ({
  ok: true,
  value: { kind: 'empty', reason: 'timeout' }
})
const response = (over: Partial<SpokenResponse> = {}): SpokenResponse => ({
  text: '안녕하세요',
  audio: { mimeType: 'audio/wav', bytes: new Uint8Array(10) },
  ...over
})

interface Held<T> {
  promise: Promise<T>
  resolve(value: T): void
}
function hold<T>(): Held<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function setup(policy: Partial<SessionPolicy> = {}) {
  let gateError: ClientError | null = null
  const listens: {
    request: Parameters<VoiceInput['listen']>[0]
    signal?: AbortSignal
    done: Held<Result<ListenOutcome>>
  }[] = []
  const queue: (Result<ListenOutcome> | 'hold')[] = []
  const voice = {
    listen: vi.fn<VoiceInput['listen']>((request, execution) => {
      const next = queue.shift() ?? empty()
      const entry = { request, signal: execution?.signal, done: hold<Result<ListenOutcome>>() }
      listens.push(entry)
      if (next !== 'hold') entry.done.resolve(next)
      execution?.signal?.addEventListener(
        'abort',
        () => entry.done.resolve({ ok: false, error: { code: 'cancelled', message: '취소' } }),
        { once: true }
      )
      return entry.done.promise
    })
  }
  const remoteCalls: string[] = []
  const transcribe = vi.fn<RemoteSpeechPort['transcribe']>(async () => {
    remoteCalls.push('transcribe')
    return { ok: true, value: { status: 'transcribed', text: '크롬 열어 줘' } }
  })
  const respond = vi.fn<RemoteSpeechPort['respond']>(async () => {
    remoteCalls.push('respond')
    return { ok: true, value: response() }
  })
  const playbackListeners = new Set<(event: PlaybackEvent) => void>()
  const played: { playbackId: string; generation: { sessionId: string; revision: number } }[] = []
  const stopped: string[] = []
  const playback: Pick<AudioPlaybackPort, 'play' | 'stop' | 'subscribe'> = {
    play: vi.fn<AudioPlaybackPort['play']>(async (request) => {
      played.push({ playbackId: request.playbackId, generation: request.generation })
      return { ok: true, value: undefined }
    }),
    stop: vi.fn<AudioPlaybackPort['stop']>(async (id) => {
      stopped.push(id)
      return { ok: true, value: undefined }
    }),
    subscribe: (listener) => {
      playbackListeners.add(listener)
      return () => playbackListeners.delete(listener)
    }
  }
  const timers: { callback: () => void; cancelled: boolean; ms: number }[] = []
  let ids = 0
  const controller = new SpeechSessionController({
    gate: {
      check: () => (gateError ? { ok: false, error: gateError } : { ok: true, value: undefined })
    },
    voice,
    remote: { transcribe, respond },
    playback,
    clock: { now: () => 1000 },
    createId: () => `id-${++ids}`,
    schedule: (callback, ms) => {
      const timer = { callback, cancelled: false, ms }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    policy
  })
  const phases: SpeechSnapshot['phase'][] = []
  const requestIds: (string | null)[] = []
  controller.subscribe((snapshot, requestId) => {
    phases.push(snapshot.phase)
    requestIds.push(requestId)
  })
  const notices: SpeechNotice[] = []
  controller.subscribeNotices((notice) => notices.push(notice))
  const emitPlayback = (
    type: PlaybackEvent['type'],
    override: { playbackId?: string } = {},
    index = played.length - 1
  ) => {
    const { generation } = played[index]
    const playbackId = override.playbackId ?? played[index].playbackId
    const event =
      type === 'playback.failed'
        ? ({
            type,
            playbackId,
            generation,
            error: { code: 'unavailable', message: '실패' }
          } as const)
        : ({ type, playbackId, generation } as PlaybackEvent)
    for (const listener of [...playbackListeners]) listener(event)
  }
  return {
    controller,
    voice,
    queue,
    listens,
    transcribe,
    respond,
    remoteCalls,
    playback,
    played,
    stopped,
    emitPlayback,
    phases,
    requestIds,
    notices,
    timers,
    closeGate: (error: ClientError) => {
      gateError = error
    },
    fire: (ms: number) =>
      timers.filter((t) => !t.cancelled && t.ms === ms).forEach((t) => t.callback())
  }
}

describe('a normal conversation', () => {
  it('moves through every state in order and plays the reply', async () => {
    const t = setup()
    t.queue.push('hold', empty())
    const activated = await t.controller.activate('hotkey')
    expect(activated.ok).toBe(true)
    expect(t.phases).toEqual(['awaiting_speech'])
    // The first listen reports speech starting, then finishing.
    t.listens[0].request.onSpeechStarted?.()
    expect(t.phases).toEqual(['awaiting_speech', 'listening'])
    t.listens[0].done.resolve(heard())
    await flush()
    expect(t.phases).toEqual([
      'awaiting_speech',
      'listening',
      'transcribing',
      'processing',
      'speaking'
    ])
    expect(t.transcribe).toHaveBeenCalledOnce()
    expect(t.respond).toHaveBeenCalledOnce()
    t.emitPlayback('playback.started')
    t.emitPlayback('playback.ended')
    await flush()
    expect(t.phases.slice(-2)).toEqual(['awaiting_followup', 'idle'])
    expect(t.notices.map((n) => n.type)).toEqual(['transcript', 'response'])
    expect(t.notices[1]).toMatchObject({ spoken: true, text: '안녕하세요' })
  })

  it('waits longer for the first thing said than for nothing at all, and shorter for a follow-up', async () => {
    const t = setup({ initialWaitMs: 1111, followupWaitMs: 2222 })
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    expect(t.listens[0].request.policy?.startWaitMs).toBe(1111)
    await flush()
    t.emitPlayback('playback.ended')
    await flush()
    expect(t.listens[1].request.policy?.startWaitMs).toBe(2222)
  })

  it('attaches a request ID to the working states only', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    await flush()
    const working = t.phases.map((p, i) => [p, t.requestIds[i]] as const)
    expect(working.filter(([, id]) => id !== null).map(([p]) => p)).toEqual([
      'transcribing',
      'processing',
      'speaking'
    ])
    t.emitPlayback('playback.ended')
    await flush()
  })

  it('ends when nothing is said and releases everything', async () => {
    const t = setup()
    t.queue.push(empty())
    await t.controller.activate('ui')
    await flush()
    expect(t.phases).toEqual(['awaiting_speech', 'idle'])
    expect(t.controller.getSnapshot()).toEqual({ phase: 'idle', generation: null })
    expect(t.transcribe).not.toHaveBeenCalled()
  })

  it('ends when the server says the conversation is over', async () => {
    const t = setup()
    t.queue.push(heard())
    t.respond.mockResolvedValueOnce({ ok: true, value: response({ endConversation: true }) })
    await t.controller.activate('ui')
    await flush()
    t.emitPlayback('playback.ended')
    await flush()
    expect(t.phases.at(-1)).toBe('idle')
    expect(t.voice.listen).toHaveBeenCalledTimes(1)
  })

  it('shows the text when the reply has no audio and does not enter the speaking state', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    t.respond.mockResolvedValueOnce({ ok: true, value: response({ audio: undefined }) })
    await t.controller.activate('ui')
    await flush()
    expect(t.phases).not.toContain('speaking')
    expect(t.notices.at(-1)).toMatchObject({ type: 'response', spoken: false })
    expect(t.played).toHaveLength(0)
  })

  it('falls back to text and tells the user when playback fails', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    await flush()
    t.emitPlayback('playback.failed')
    await flush()
    expect(t.notices.find((n) => n.type === 'problem')).toBeDefined()
    expect(t.notices.find((n) => n.type === 'response')).toMatchObject({ spoken: false })
    expect(t.phases).toContain('awaiting_followup')
  })

  it('treats a rejected playback request as a failed playback', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    vi.mocked(t.playback.play).mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: '재생 불가' }
    })
    await t.controller.activate('ui')
    await flush()
    expect(t.notices.find((n) => n.type === 'response')).toMatchObject({ spoken: false })
  })

  it('gives up on a playback that never reports an end', async () => {
    const t = setup({ playbackTimeoutMs: 4242 })
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    await flush()
    t.fire(4242)
    await flush()
    expect(t.stopped).toHaveLength(1)
    expect(t.phases).toContain('awaiting_followup')
  })

  it('ignores playback events that belong to another playback', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    await flush()
    t.emitPlayback('playback.ended', { playbackId: 'another-playback' })
    await flush()
    expect(t.phases.at(-1)).toBe('speaking')
    t.emitPlayback('playback.ended')
    await flush()
    expect(t.phases.at(-1)).not.toBe('speaking')
  })
})

describe('failures', () => {
  it('asks the user to try again after an empty recognition and ends after repeated ones', async () => {
    const t = setup({ maxConsecutiveFailures: 2 })
    t.queue.push(heard(), heard())
    t.transcribe.mockResolvedValue({ ok: true, value: { status: 'empty' } })
    await t.controller.activate('ui')
    await flush()
    await flush()
    expect(t.notices.filter((n) => n.type === 'problem')).toHaveLength(2)
    expect(t.phases.at(-1)).toBe('idle')
    expect(t.respond).not.toHaveBeenCalled()
  })

  it('keeps going after a single failure and forgets it after a good turn', async () => {
    const t = setup({ maxConsecutiveFailures: 2 })
    t.queue.push(heard(), heard(), heard(), empty())
    t.transcribe
      .mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: '서버 오류' } })
      .mockResolvedValueOnce({ ok: true, value: { status: 'transcribed', text: '성공' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: '서버 오류' } })
    await t.controller.activate('ui')
    await flush()
    t.emitPlayback('playback.ended')
    await flush()
    await flush()
    expect(t.voice.listen.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('reports a failed response and continues listening', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    t.respond.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: '응답 실패' }
    })
    await t.controller.activate('ui')
    await flush()
    expect(t.notices.find((n) => n.type === 'problem')).toMatchObject({
      error: { code: 'unavailable' }
    })
    expect(t.phases).toContain('awaiting_followup')
    expect(t.played).toHaveLength(0)
  })

  it('stops with an error when listening itself fails', async () => {
    const t = setup()
    t.queue.push({ ok: false, error: { code: 'permission_denied', message: '마이크 권한 필요' } })
    await t.controller.activate('ui')
    await flush()
    expect(t.notices).toEqual([
      { type: 'problem', error: { code: 'permission_denied', message: '마이크 권한 필요' } }
    ])
    expect(t.phases.at(-1)).toBe('idle')
  })

  it('times out a server step instead of waiting forever', async () => {
    const t = setup({ remoteTimeoutMs: 777 })
    t.queue.push(heard(), empty())
    t.transcribe.mockImplementationOnce(() => new Promise(() => undefined))
    await t.controller.activate('ui')
    await flush()
    expect(t.phases.at(-1)).toBe('transcribing')
    t.fire(777)
    await flush()
    expect(t.notices.find((n) => n.type === 'problem')).toMatchObject({
      error: { code: 'expired' }
    })
  })
})

describe('starting', () => {
  it('refuses to start when signed out or paused', async () => {
    const t = setup()
    t.closeGate({ code: 'authentication_required', message: '로그인이 필요합니다.' })
    expect(await t.controller.activate('hotkey')).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(t.voice.listen).not.toHaveBeenCalled()
    expect(t.phases).toEqual([])
  })

  it('returns the running session instead of starting a second one', async () => {
    const t = setup()
    t.queue.push('hold')
    const first = await t.controller.activate('hotkey')
    const second = await t.controller.activate('tray')
    expect(second.ok && first.ok && second.value.sessionId === first.value.sessionId).toBe(true)
    expect(t.voice.listen).toHaveBeenCalledOnce()
  })

  it('gives each conversation its own identity and moves the version forward', async () => {
    const t = setup()
    t.queue.push(empty(), 'hold')
    const first = await t.controller.activate('ui')
    await flush()
    const second = await t.controller.activate('ui')
    expect(first.ok && second.ok && first.value.sessionId !== second.value.sessionId).toBe(true)
  })
})

describe('stopping and stale results', () => {
  it('cancels listening immediately and leaves nothing running', async () => {
    const t = setup()
    t.queue.push('hold')
    await t.controller.activate('ui')
    expect(await t.controller.stop()).toEqual({ ok: true, value: undefined })
    expect(t.listens[0].signal?.aborted).toBe(true)
    expect(t.phases.at(-1)).toBe('idle')
    await flush()
    expect(t.transcribe).not.toHaveBeenCalled()
  })

  it('ignores a server answer that arrives after the conversation was stopped', async () => {
    const t = setup()
    t.queue.push(heard())
    const answer = hold<Result<{ status: 'transcribed'; text: string }>>()
    t.transcribe.mockReturnValueOnce(answer.promise)
    await t.controller.activate('ui')
    await flush()
    expect(t.phases.at(-1)).toBe('transcribing')
    await t.controller.stop()
    answer.resolve({ ok: true, value: { status: 'transcribed', text: '늦은 응답' } })
    await flush()
    expect(t.respond).not.toHaveBeenCalled()
    expect(t.notices).toEqual([])
    expect(t.phases.at(-1)).toBe('idle')
  })

  it('does not let an old conversation touch a new one', async () => {
    const t = setup()
    t.queue.push(heard(), 'hold')
    const answer = hold<Result<{ status: 'transcribed'; text: string }>>()
    t.transcribe.mockReturnValueOnce(answer.promise)
    await t.controller.activate('ui')
    await flush()
    await t.controller.stop()
    await t.controller.activate('ui')
    const phasesBefore = t.phases.length
    answer.resolve({ ok: true, value: { status: 'transcribed', text: '옛 대화' } })
    await flush()
    expect(t.respond).not.toHaveBeenCalled()
    expect(t.phases.length).toBe(phasesBefore)
    expect(t.controller.getSnapshot().phase).toBe('awaiting_speech')
  })

  it('stops playback when stopped while speaking', async () => {
    const t = setup()
    t.queue.push(heard())
    await t.controller.activate('ui')
    await flush()
    expect(t.phases.at(-1)).toBe('speaking')
    await t.controller.stop()
    expect(t.stopped).toEqual([t.played[0].playbackId])
    expect(t.phases.at(-1)).toBe('idle')
  })

  it('is safe to stop when nothing is running, repeatedly', async () => {
    const t = setup()
    expect(await t.controller.stop()).toEqual({ ok: true, value: undefined })
    expect(await t.controller.stop()).toEqual({ ok: true, value: undefined })
    expect(t.phases).toEqual([])
  })

  it('passes the session generation to each step so late results can be recognised', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    await flush()
    const turn = t.transcribe.mock.calls[0][0]
    expect(turn.session.sessionId).toBe(t.listens[0].request.generation.sessionId)
    expect(turn.session.revision).toBeGreaterThan(t.listens[0].request.generation.revision)
    t.emitPlayback('playback.ended')
    await flush()
  })
})
