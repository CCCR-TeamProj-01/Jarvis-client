import { DEFAULT_VAD_POLICY } from '../../../inference/vad/vad-policy'
import type { VadPolicy } from '../../../inference/vad/vad-policy'
import type { ClientError, Generation, Result, Unsubscribe } from '../../../shared/contracts/common'
import { sameGeneration } from '../../../shared/contracts/common'
import type { CompletedUtterance, SpeechSnapshot } from '../../../shared/contracts/speech'
import type { AudioPlaybackPort } from '../../../shared/ports/audio-playback'
import type { ActivationSource } from '../../interaction/ports'
import type { LocalExecutionOptions, MonotonicClock } from '../../ports'
import type { SensorGate } from '../../sensors/hardware'
import type { AssistantReply, ConversationPort } from '../../conversation/ports'
import type { RemoteSpeechPort } from '../remote-speech/ports'
import type { ListenOutcome, VoiceInput, WakeContinuation } from '../voice-input'
import type { SpeechNotice, SpeechSessionPort } from './ports'

/**
 * Waits and limits for a conversation. The numbers are provisional until reference devices and a
 * measurement method are agreed (docs/delivery/validation.md), so callers can override them.
 */
export interface SessionPolicy {
  /** How long to wait for the first thing the user says after the conversation starts. */
  initialWaitMs: number
  /** How long to wait for a follow-up before the conversation ends. */
  followupWaitMs: number
  /** Upper bound for each server step (recognition, response). */
  remoteTimeoutMs: number
  /** Failed or empty turns in a row before giving up. */
  maxConsecutiveFailures: number
  /** Safety net in case a playback never reports an end. */
  playbackTimeoutMs: number
  vad: VadPolicy
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  initialWaitMs: 6_000,
  followupWaitMs: 8_000,
  remoteTimeoutMs: 20_000,
  maxConsecutiveFailures: 2,
  playbackTimeoutMs: 60_000,
  vad: DEFAULT_VAD_POLICY
}

interface SpeechSessionOptions {
  gate: SensorGate
  voice: Pick<VoiceInput, 'listen'>
  /** Speech recognition only; the answer comes from the conversation. */
  remote: RemoteSpeechPort
  conversation: Pick<ConversationPort, 'start' | 'submit' | 'hold' | 'isActive'>
  playback: Pick<AudioPlaybackPort, 'play' | 'stop' | 'subscribe'>
  clock: MonotonicClock
  createId(): string
  /** Returns a cancel function. Injected so waits can be tested without real timers. */
  schedule(callback: () => void, delayMs: number): () => void
  policy?: Partial<SessionPolicy>
  /** Read before each reply. Disabling output never suppresses the conversation's text. */
  speechOutputEnabled?: () => boolean
}

type Phase = SpeechSnapshot['phase']

/** One voice session. A new activation after it ended gets a new identity. */
interface Session {
  id: string
  /** Advances with every state change, so anything older is recognisably stale. */
  version: number
  abort: AbortController
  playback: { id: string; generation: Generation } | null
  conversationId: string
  /** Keeps the conversation from timing out while this session is using it. */
  releaseConversation: () => void
  continuation?: WakeContinuation
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Owns the voice side of a conversation: when to listen, what is being waited for, and when to
 * stop. Everything after the user finishes speaking happens off the microphone, so nothing a reply
 * says can be heard as the next question. Cancelling is local and immediate; whatever a slow server
 * answers later is ignored because the session it belonged to is gone.
 */
export class SpeechSessionController implements SpeechSessionPort {
  private readonly policy: SessionPolicy
  private session: Session | null = null
  private snapshot: SpeechSnapshot = { phase: 'idle', generation: null }
  private readonly listeners = new Set<(snapshot: SpeechSnapshot) => void>()
  private readonly noticeListeners = new Set<(notice: SpeechNotice) => void>()

  constructor(private readonly options: SpeechSessionOptions) {
    this.policy = { ...DEFAULT_SESSION_POLICY, ...options.policy }
  }

  getSnapshot(): SpeechSnapshot {
    return structuredClone(this.snapshot)
  }

  subscribe(listener: (snapshot: SpeechSnapshot) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeNotices(listener: (notice: SpeechNotice) => void): Unsubscribe {
    this.noticeListeners.add(listener)
    return () => {
      this.noticeListeners.delete(listener)
    }
  }

  async activate(
    _source: ActivationSource,
    continuation?: WakeContinuation
  ): Promise<Result<Generation>> {
    if (this.session) continuation?.release()
    if (this.session) return { ok: true, value: this.generation(this.session) }
    const gate = this.options.gate.check()
    if (!gate.ok) {
      continuation?.release()
      return gate
    }
    // Listening belongs to a conversation; start one if there is none.
    const conversation = this.options.conversation.start()
    if (!conversation.ok) {
      continuation?.release()
      return conversation
    }
    const session: Session = {
      id: this.options.createId(),
      version: 0,
      abort: new AbortController(),
      playback: null,
      conversationId: conversation.value.conversationId,
      releaseConversation: this.options.conversation.hold(),
      continuation
    }
    this.session = session
    if (continuation) this.enter(session, 'wake_detected')
    // `run` enters its first state before its first await, so the caller already sees it.
    void this.run(session)
    return { ok: true, value: this.generation(session) }
  }

  async stop(): Promise<Result<void>> {
    if (this.session) this.finish(this.session)
    return { ok: true, value: undefined }
  }

  // --- the conversation ------------------------------------------------------------------------

  private async run(session: Session): Promise<void> {
    const { voice, remote, conversation, policy } = { ...this.options, policy: this.policy }
    let failures = 0
    let first = true
    try {
      while (this.alive(session) && conversation.isActive()) {
        this.enter(session, first ? 'awaiting_speech' : 'awaiting_followup')
        let heard: Result<ListenOutcome> | null = await voice.listen(
          {
            generation: this.generation(session),
            ...(session.continuation ? { continuation: session.continuation } : {}),
            policy: {
              ...policy.vad,
              startWaitMs: first ? policy.initialWaitMs : policy.followupWaitMs
            },
            onSpeechStarted: () => {
              if (this.alive(session)) this.enter(session, 'listening')
            }
          },
          { signal: session.abort.signal }
        )
        session.continuation?.release()
        session.continuation = undefined
        if (!this.alive(session)) return
        if (!heard.ok) return this.problem(heard.error)
        // Nothing said in time: the voice session is simply over.
        if (heard.value.kind === 'empty') return
        first = false

        let utterance: CompletedUtterance | null = heard.value.utterance
        heard = null
        // Each server step carries the version of the state it was sent from.
        this.enter(session, 'transcribing')
        const turn = {
          conversationId: session.conversationId,
          requestId: this.options.createId(),
          session: this.generation(session)
        }
        const transcription = await this.withLimit(session, (execution) =>
          remote.transcribe(turn, utterance!, execution)
        )
        // The audio has done its job; keep nothing of it.
        utterance = null
        if (!this.alive(session)) return
        // A failed recognition and an empty one are both "try again" for the user.
        const transcript = transcription.ok ? transcription.value : null
        if (!transcript || transcript.status !== 'transcribed') {
          failures += 1
          this.problem(
            !transcription.ok
              ? transcription.error
              : { code: 'invalid_input', message: '잘 듣지 못했어요. 다시 말씀해 주세요.' }
          )
          if (failures >= policy.maxConsecutiveFailures) return
          continue
        }

        // What was said goes to the conversation, which answers it (and tells the user).
        this.enter(session, 'processing')
        const answered = await conversation.submit(
          { text: transcript.text, modality: 'speech', requestId: turn.requestId },
          { signal: session.abort.signal }
        )
        if (!this.alive(session)) return
        if (!answered.ok) {
          // The conversation has already told the user why.
          if (!conversation.isActive()) return
          failures += 1
          if (failures >= policy.maxConsecutiveFailures) return
          continue
        }
        failures = 0
        const { reply } = answered.value
        if (reply.audio && (this.options.speechOutputEnabled?.() ?? true))
          await this.speak(session, reply)
        if (!this.alive(session)) return
        // The assistant ended the conversation: nothing more to wait for.
        if (reply.endConversation || !conversation.isActive()) return
      }
    } finally {
      this.finish(session)
    }
  }

  /** Play the spoken reply and wait for it to really finish. Returns whether it was heard. */
  private async speak(session: Session, reply: AssistantReply): Promise<boolean> {
    if (!reply.audio) return false
    const { playback, schedule } = this.options
    this.enter(session, 'speaking')
    const playbackId = this.options.createId()
    const generation = this.generation(session)
    session.playback = { id: playbackId, generation }
    const outcome = await new Promise<'ended' | 'stopped' | 'failed'>((resolve) => {
      let settled = false
      const cleanups: (() => void)[] = []
      const done = (value: 'ended' | 'stopped' | 'failed') => {
        if (settled) return
        settled = true
        for (const cleanup of cleanups) cleanup()
        resolve(value)
      }
      cleanups.push(
        playback.subscribe((event) => {
          if (event.playbackId !== playbackId || !sameGeneration(event.generation, generation))
            return
          if (event.type === 'playback.ended') done('ended')
          else if (event.type === 'playback.stopped') done('stopped')
          else if (event.type === 'playback.failed') done('failed')
        })
      )
      const onAbort = () => done('stopped')
      session.abort.signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => session.abort.signal.removeEventListener('abort', onAbort))
      cleanups.push(
        schedule(() => {
          void playback.stop(playbackId, generation)
          done('failed')
        }, this.policy.playbackTimeoutMs)
      )
      if (session.abort.signal.aborted) return done('stopped')
      void playback
        .play({
          playbackId,
          generation,
          mimeType: reply.audio!.mimeType,
          audio: reply.audio!.bytes
        })
        .then((accepted) => {
          if (!accepted.ok) done('failed')
        })
    })
    session.playback = null
    if (outcome === 'failed' && this.alive(session))
      this.problem({
        code: 'unavailable',
        message: '응답 음성을 재생하지 못해 글로 보여 드려요.'
      })
    return outcome === 'ended'
  }

  /** Run a server step with a time limit, cancelled together with the session. */
  private async withLimit<T>(
    session: Session,
    call: (execution: LocalExecutionOptions) => Promise<Result<T>>
  ): Promise<Result<T>> {
    const limit = new AbortController()
    const stop = () => limit.abort()
    session.abort.signal.addEventListener('abort', stop, { once: true })
    let timedOut = false
    const cancelTimer = this.options.schedule(() => {
      timedOut = true
      limit.abort()
    }, this.policy.remoteTimeoutMs)
    try {
      const outcome = await Promise.race([
        call({
          signal: limit.signal,
          deadlineMs: this.options.clock.now() + this.policy.remoteTimeoutMs
        }),
        new Promise<Result<never>>((resolve) =>
          limit.signal.addEventListener(
            'abort',
            () =>
              resolve(
                timedOut
                  ? failure('expired', '서버 응답이 너무 오래 걸려 중단했어요.')
                  : failure('cancelled', '요청이 취소되었습니다.')
              ),
            { once: true }
          )
        )
      ])
      return outcome
    } finally {
      cancelTimer()
      session.abort.signal.removeEventListener('abort', stop)
    }
  }

  // --- state -----------------------------------------------------------------------------------

  private alive(session: Session): boolean {
    return this.session === session && !session.abort.signal.aborted
  }

  private generation(session: Session): Generation {
    return { sessionId: session.id, revision: session.version }
  }

  private enter(session: Session, phase: Phase): void {
    if (this.session !== session) return
    session.version += 1
    this.publish({ phase, generation: this.generation(session) })
  }

  /** End the session now: cancel what is running, stop playback, forget the session. */
  private finish(session: Session): void {
    if (this.session !== session) return
    this.session = null
    session.abort.abort()
    session.continuation?.release()
    session.continuation = undefined
    if (session.playback)
      void this.options.playback.stop(session.playback.id, session.playback.generation)
    session.playback = null
    session.releaseConversation()
    this.publish({ phase: 'idle', generation: null })
  }

  private publish(snapshot: SpeechSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(snapshot))
      } catch {
        /* Observers cannot prevent state transitions or other observers. */
      }
    }
  }

  private problem(error: ClientError): void {
    this.notice({ type: 'problem', error })
  }

  private notice(notice: SpeechNotice): void {
    for (const listener of [...this.noticeListeners]) {
      try {
        listener(notice)
      } catch {
        /* Observers cannot prevent state transitions or other observers. */
      }
    }
  }
}
