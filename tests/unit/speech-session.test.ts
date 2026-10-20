import { describe, expect, it, vi } from 'vitest'
import type {
  AssistantReply,
  ConversationPort,
  TurnResult
} from '../../src/main/conversation/ports'
import type { SpeechNotice } from '../../src/main/speech/session/ports'
import { SpeechSessionController } from '../../src/main/speech/session/speech-session'
import type { SessionPolicy } from '../../src/main/speech/session/speech-session'
import type { RemoteSpeechPort } from '../../src/main/speech/remote-speech/ports'
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
const reply = (over: Partial<AssistantReply> = {}): AssistantReply => ({
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
  const transcribe = vi.fn<RemoteSpeechPort['transcribe']>(async () => ({
    ok: true,
    value: { status: 'transcribed', text: '크롬 열어 줘' }
  }))
  // A conversation that answers every submission with the same reply.
  let active = true
  const holds = { taken: 0, released: 0 }
  const submit = vi.fn<ConversationPort['submit']>(async (): Promise<Result<TurnResult>> => ({
    ok: true,
    value: { requestId: 'req-1', reply: reply() }
  }))
  const conversation: Pick<ConversationPort, 'start' | 'submit' | 'hold' | 'isActive'> = {
    start: vi.fn<ConversationPort['start']>(() => ({
      ok: true,
      value: { conversationId: 'conv-1' }
    })),
    submit,
    hold: () => {
      holds.taken += 1
      return () => {
        holds.released += 1
      }
    },
    isActive: () => active
  }
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
    remote: { transcribe },
    conversation,
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
  controller.subscribe((snapshot) => phases.push(snapshot.phase))
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
    submit,
    conversation,
    holds,
    endConversation: () => {
      active = false
    },
    playback,
    played,
    stopped,
    emitPlayback,
    phases,
    notices,
    timers,
    closeGate: (error: ClientError) => {
      gateError = error
    },
    fire: (ms: number) =>
      timers.filter((t) => !t.cancelled && t.ms === ms).forEach((t) => t.callback())
  }
}

describe('a normal voice session', () => {
  it('moves through every state in order, hands the words to the conversation and plays the reply', async () => {
    const t = setup()
    t.queue.push('hold', empty())
    const activated = await t.controller.activate('hotkey')
    expect(activated.ok).toBe(true)
    expect(t.phases).toEqual(['awaiting_speech'])
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
    expect(t.submit).toHaveBeenCalledWith(
      { text: '크롬 열어 줘', modality: 'speech' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    t.emitPlayback('playback.started')
    t.emitPlayback('playback.ended')
    await flush()
    expect(t.phases.slice(-2)).toEqual(['awaiting_followup', 'idle'])
  })

  it('does not itself tell the user what was said or answered; the conversation does', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    await flush()
    t.emitPlayback('playback.ended')
    await flush()
    expect(t.notices).toEqual([])
  })

  it('starts a conversation and keeps it open for as long as it listens', async () => {
    const t = setup()
    t.queue.push(empty())
    await t.controller.activate('ui')
    await flush()
    expect(t.conversation.start).toHaveBeenCalledOnce()
    expect(t.holds).toEqual({ taken: 1, released: 1 })
  })

  it('waits longer for the first thing said than a follow-up needs', async () => {
    const t = setup({ initialWaitMs: 1111, followupWaitMs: 2222 })
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    expect(t.listens[0].request.policy?.startWaitMs).toBe(1111)
    await flush()
    t.emitPlayback('playback.ended')
    await flush()
    expect(t.listens[1].request.policy?.startWaitMs).toBe(2222)
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

  it('ends when the assistant ends the conversation, after the final reply was spoken', async () => {
    const t = setup()
    t.queue.push(heard())
    t.submit.mockResolvedValueOnce({
      ok: true,
      value: { requestId: 'r', reply: reply({ endConversation: true }) }
    })
    await t.controller.activate('ui')
    await flush()
    expect(t.phases.at(-1)).toBe('speaking')
    t.emitPlayback('playback.ended')
    await flush()
    expect(t.phases.at(-1)).toBe('idle')
    expect(t.voice.listen).toHaveBeenCalledTimes(1)
  })

  it('stops listening once the conversation is over', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    await flush()
    t.endConversation()
    t.emitPlayback('playback.ended')
    await flush()
    expect(t.phases.at(-1)).toBe('idle')
    expect(t.voice.listen).toHaveBeenCalledTimes(1)
  })

  it('does not enter the speaking state when the reply has no audio', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    t.submit.mockResolvedValueOnce({
      ok: true,
      value: { requestId: 'r', reply: reply({ audio: undefined }) }
    })
    await t.controller.activate('ui')
    await flush()
    expect(t.phases).not.toContain('speaking')
    expect(t.played).toHaveLength(0)
  })

  it('tells the user when playback fails', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    await t.controller.activate('ui')
    await flush()
    t.emitPlayback('playback.failed')
    await flush()
    expect(t.notices).toMatchObject([{ type: 'problem', error: { code: 'unavailable' } }])
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
    expect(t.notices.some((n) => n.type === 'problem')).toBe(true)
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
    expect(t.submit).not.toHaveBeenCalled()
  })

  it('reports a recognition error and continues after a single failure', async () => {
    const t = setup({ maxConsecutiveFailures: 2 })
    t.queue.push(heard(), heard(), empty())
    t.transcribe
      .mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: '서버 오류' } })
      .mockResolvedValueOnce({ ok: true, value: { status: 'transcribed', text: '성공' } })
    await t.controller.activate('ui')
    await flush()
    await flush()
    expect(t.notices[0]).toMatchObject({ error: { code: 'unavailable' } })
    expect(t.submit).toHaveBeenCalledOnce()
  })

  it('leaves telling the user about a failed answer to the conversation, and goes on listening', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    t.submit.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: '응답 실패' }
    })
    await t.controller.activate('ui')
    await flush()
    expect(t.notices).toEqual([])
    expect(t.phases).toContain('awaiting_followup')
    expect(t.played).toHaveLength(0)
  })

  it('stops after repeated failed answers', async () => {
    const t = setup({ maxConsecutiveFailures: 2 })
    t.queue.push(heard(), heard(), heard())
    t.submit.mockResolvedValue({ ok: false, error: { code: 'unavailable', message: '응답 실패' } })
    await t.controller.activate('ui')
    await flush()
    await flush()
    expect(t.voice.listen).toHaveBeenCalledTimes(2)
    expect(t.phases.at(-1)).toBe('idle')
  })

  it('ends quietly when its conversation was ended during the answer', async () => {
    const t = setup()
    t.queue.push(heard(), empty())
    t.submit.mockImplementationOnce(async () => {
      t.endConversation()
      return { ok: false, error: { code: 'cancelled', message: '대화가 종료되었습니다.' } }
    })
    await t.controller.activate('ui')
    await flush()
    expect(t.phases.at(-1)).toBe('idle')
    expect(t.voice.listen).toHaveBeenCalledTimes(1)
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

  it('times out recognition instead of waiting forever', async () => {
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

  it('does not start when the conversation cannot be started', async () => {
    const t = setup()
    vi.mocked(t.conversation.start).mockReturnValueOnce({
      ok: false,
      error: { code: 'unavailable', message: '인식이 일시 중지되어 있습니다.' }
    })
    expect(await t.controller.activate('hotkey')).toMatchObject({ ok: false })
    expect(t.voice.listen).not.toHaveBeenCalled()
    expect(t.holds.taken).toBe(0)
  })

  it('returns the running session instead of starting a second one', async () => {
    const t = setup()
    t.queue.push('hold')
    const first = await t.controller.activate('hotkey')
    const second = await t.controller.activate('tray')
    expect(second.ok && first.ok && second.value.sessionId === first.value.sessionId).toBe(true)
    expect(t.voice.listen).toHaveBeenCalledOnce()
    expect(t.holds.taken).toBe(1)
  })

  it('gives each voice session its own identity', async () => {
    const t = setup()
    t.queue.push(empty(), 'hold')
    const first = await t.controller.activate('ui')
    await flush()
    const second = await t.controller.activate('ui')
    expect(first.ok && second.ok && first.value.sessionId !== second.value.sessionId).toBe(true)
  })
})

describe('stopping and stale results', () => {
  it('cancels listening immediately, leaves the conversation alone and lets go of it', async () => {
    const t = setup()
    t.queue.push('hold')
    await t.controller.activate('ui')
    expect(await t.controller.stop()).toEqual({ ok: true, value: undefined })
    expect(t.listens[0].signal?.aborted).toBe(true)
    expect(t.phases.at(-1)).toBe('idle')
    expect(t.holds).toEqual({ taken: 1, released: 1 })
    await flush()
    expect(t.transcribe).not.toHaveBeenCalled()
  })

  it('ignores a recognition result that arrives after the session was stopped', async () => {
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
    expect(t.submit).not.toHaveBeenCalled()
    expect(t.phases.at(-1)).toBe('idle')
  })

  it('does not let an old session touch a new one', async () => {
    const t = setup()
    t.queue.push(heard(), 'hold')
    const answer = hold<Result<{ status: 'transcribed'; text: string }>>()
    t.transcribe.mockReturnValueOnce(answer.promise)
    await t.controller.activate('ui')
    await flush()
    await t.controller.stop()
    await t.controller.activate('ui')
    const phasesBefore = t.phases.length
    answer.resolve({ ok: true, value: { status: 'transcribed', text: '옛 세션' } })
    await flush()
    expect(t.submit).not.toHaveBeenCalled()
    expect(t.phases.length).toBe(phasesBefore)
    expect(t.controller.getSnapshot().phase).toBe('awaiting_speech')
  })

  it('cancels the answer it is waiting for when stopped', async () => {
    const t = setup()
    t.queue.push(heard())
    let seen: AbortSignal | undefined
    t.submit.mockImplementationOnce(
      (_input, options) =>
        new Promise<Result<TurnResult>>(() => {
          seen = options?.signal
        })
    )
    await t.controller.activate('ui')
    await flush()
    expect(t.phases.at(-1)).toBe('processing')
    await t.controller.stop()
    expect(seen?.aborted).toBe(true)
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

  it('passes the session identity and state version to recognition', async () => {
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
