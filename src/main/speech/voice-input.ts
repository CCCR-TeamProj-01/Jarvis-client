import type { VoiceActivityDetectorPort } from '../../inference/ports'
import { DEFAULT_VAD_POLICY } from '../../inference/vad/vad-policy'
import type { VadPolicy } from '../../inference/vad/vad-policy'
import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type { CompletedUtterance, PcmChunk, VadEvent } from '../../shared/contracts/speech'
import type { SensorLease } from '../../shared/contracts/sensors'
import type { LocalExecutionOptions, MonotonicClock } from '../ports'
import type { SensorPort } from '../sensors/ports'
import type { AudioInputRouter } from './audio-input'

/** About 15 s of 100 ms chunks: far more than starting the detector should ever take. */
const MAX_WAITING_CHUNKS = 150

/** Main-only transfer of a live microphone lease, never sent through IPC. */
export interface WakeContinuation {
  generation: Generation
  startSample: number
  /** Idempotent: keep wake capture alive until speech has acquired its own lease. */
  release(): void
}

export type ListenOutcome =
  | { kind: 'utterance'; utterance: CompletedUtterance; reason: 'silence' | 'max_duration' }
  | { kind: 'empty'; reason: 'timeout' | 'silence' }

interface VoiceInputOptions {
  sensors: Pick<SensorPort, 'acquire' | 'release' | 'subscribe'>
  router: Pick<
    AudioInputRouter,
    'subscribePcm' | 'subscribeProblems' | 'extractUtterance' | 'clearBuffer'
  >
  vad: VoiceActivityDetectorPort
  clock: MonotonicClock
  /** How long to wait for the first audio after the microphone is opened. */
  firstAudioTimeoutMs?: number
  /** Returns a cancel function. Injected so waits can be tested without real timers. */
  schedule(callback: () => void, delayMs: number): () => void
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Listens for one spoken utterance: open the microphone through a lease, run VAD on the live
 * audio, and when it finishes pull exactly that stretch out of the capture buffer. Everything is
 * released afterwards, including the buffer, whatever the outcome. Deciding *when* to listen is
 * the speech session's job; this is the mechanism it will use.
 */
export class VoiceInput {
  private busy = false

  constructor(private readonly options: VoiceInputOptions) {}

  async listen(
    request: {
      generation: Generation
      policy?: VadPolicy
      onSpeechStarted?: () => void
      continuation?: WakeContinuation
    },
    execution?: LocalExecutionOptions
  ): Promise<Result<ListenOutcome>> {
    if (this.busy) return failure('conflict', '이미 음성 입력을 받고 있습니다.')
    if (execution?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    this.busy = true
    const cleanups: (() => unknown)[] = []
    let capture: Generation | null = null
    try {
      const lease = await this.options.sensors.acquire(
        { kind: 'microphone', owner: 'speech_session', generation: request.generation },
        execution
      )
      if (!lease.ok) return lease
      cleanups.push(() => this.options.sensors.release(lease.value.leaseId))
      request.continuation?.release()
      return await this.run(
        lease.value,
        request.policy ?? DEFAULT_VAD_POLICY,
        request.onSpeechStarted,
        execution,
        cleanups,
        (g) => {
          capture = g
        },
        request.continuation
      )
    } finally {
      request.continuation?.release()
      // Always: stop VAD, throw away what was captured, return the microphone.
      await this.options.vad.stop()
      if (capture) await this.options.router.clearBuffer(capture).catch(() => undefined)
      for (const cleanup of cleanups.reverse())
        await Promise.resolve(cleanup()).catch(() => undefined)
      this.busy = false
    }
  }

  private run(
    lease: SensorLease,
    policy: VadPolicy,
    onSpeechStarted: (() => void) | undefined,
    execution: LocalExecutionOptions | undefined,
    cleanups: (() => unknown)[],
    onCapture: (generation: Generation) => void,
    continuation?: WakeContinuation
  ): Promise<Result<ListenOutcome>> {
    const { sensors, router, vad, clock, schedule } = this.options
    return new Promise((resolve) => {
      let done = false
      let started = false
      const finish = (result: Result<ListenOutcome>) => {
        if (done) return
        done = true
        resolve(result)
      }
      const watch = (release: Unsubscribe) => cleanups.push(release)

      // The microphone being taken away (sign-out, pause, device loss) ends listening at once.
      watch(
        sensors.subscribe((event) => {
          if (event.type === 'sensor.lease_revoked' && event.lease.leaseId === lease.leaseId)
            finish({ ok: false, error: event.error })
        })
      )
      watch(router.subscribeProblems((error) => finish({ ok: false, error })))
      execution?.signal?.addEventListener(
        'abort',
        () => finish(failure('cancelled', '요청이 취소되었습니다.')),
        { once: true }
      )
      if (execution?.deadlineMs !== undefined) {
        const remaining = execution.deadlineMs - clock.now()
        if (remaining <= 0) return finish(failure('expired', '요청 시간이 지났습니다.'))
        watch(schedule(() => finish(failure('expired', '요청 시간이 지났습니다.')), remaining))
      }
      watch(vad.subscribeErrors((error) => finish({ ok: false, error })))
      watch(
        vad.subscribe((event) => {
          void this.onVad(event, execution, finish, onSpeechStarted)
        })
      )

      let capture: Generation | null = null
      let vadReady = false
      // Audio keeps arriving while the VAD process starts; hold it in order and replay it, so the
      // detector sees an unbroken stream from its first sample.
      let waiting: PcmChunk[] = []
      watch(
        router.subscribePcm((chunk: PcmChunk) => {
          if (done) return
          if (capture === null) {
            capture = chunk.generation
            onCapture(chunk.generation)
            started = true
            const firstSample = continuation?.startSample ?? chunk.startSample
            const prepare = async (): Promise<Result<void>> => {
              if (
                continuation &&
                (!sameGeneration(continuation.generation, chunk.generation) ||
                  firstSample > chunk.startSample ||
                  chunk.startSample - firstSample > 80_000)
              )
                return failure('expired', '호출 뒤 음성을 이어받지 못했습니다. 다시 말씀해 주세요.')
              const prefix =
                firstSample < chunk.startSample
                  ? await router.extractUtterance(
                      {
                        utteranceId: `wake-${lease.leaseId}`,
                        generation: chunk.generation,
                        startSample: firstSample,
                        sampleCount: chunk.startSample - firstSample
                      },
                      execution
                    )
                  : null
              if (done) return failure('cancelled', '음성 입력이 중단되었습니다.')
              if (prefix && !prefix.ok) return prefix
              const result = await vad.start(chunk.generation, chunk.format, {
                policy,
                firstSample
              })
              if (!result.ok || done) return result
              if (prefix?.ok) {
                for (let offset = 0; offset < prefix.value.audio.byteLength; offset += 3_200) {
                  if (done) break
                  const pushed = vad.push({
                    ...chunk,
                    startSample: firstSample + offset / 2,
                    audio: prefix.value.audio.slice(offset, offset + 3_200)
                  })
                  if (!pushed.ok) return pushed
                }
              }
              return result
            }
            void prepare()
              .then((result) => {
                if (done) return
                if (!result.ok) return finish(result)
                vadReady = true
                const queued = waiting
                waiting = []
                for (const held of queued) {
                  const pushed = vad.push(held)
                  if (!pushed.ok) return finish(pushed)
                }
              })
              .catch(() => finish(failure('unavailable', '음성 입력을 준비하지 못했습니다.')))
          }
          if (!sameGeneration(capture, chunk.generation)) return
          if (!vadReady) {
            if (waiting.length < MAX_WAITING_CHUNKS) waiting.push(chunk)
            else finish(failure('unavailable', '음성 구간 감지가 제때 시작되지 않았습니다.'))
            return
          }
          const pushed = vad.push(chunk)
          if (!pushed.ok) finish(pushed)
        })
      )
      watch(
        schedule(() => {
          if (!started) finish(failure('unavailable', '마이크에서 오디오가 들어오지 않습니다.'))
        }, this.options.firstAudioTimeoutMs ?? 3_000)
      )
    })
  }

  private async onVad(
    event: VadEvent,
    execution: LocalExecutionOptions | undefined,
    finish: (result: Result<ListenOutcome>) => void,
    onSpeechStarted: (() => void) | undefined
  ): Promise<void> {
    if (event.type === 'speech.started') {
      try {
        onSpeechStarted?.()
      } catch {
        /* A faulty observer must not end the utterance. */
      }
      return
    }
    if (event.type === 'speech.empty')
      return finish({ ok: true, value: { kind: 'empty', reason: event.reason } })
    if (event.type !== 'speech.completed') return
    const extracted = await this.options.router.extractUtterance(event.range, execution)
    finish(
      extracted.ok
        ? {
            ok: true,
            value: { kind: 'utterance', utterance: extracted.value, reason: event.reason }
          }
        : extracted
    )
  }
}
