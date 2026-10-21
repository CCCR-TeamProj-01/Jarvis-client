import type { WakeWordDetectorPort } from '../../inference/ports'
import type { ClientError, Generation, Result } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type { PcmChunk, WakeWordEvent } from '../../shared/contracts/speech'
import type { WakeWordSnapshot } from '../../shared/contracts/wake-word'
import type { SensorLease } from '../../shared/contracts/sensors'
import type { SensorPort } from '../sensors/ports'
import type { AudioInputRouter } from './audio-input'
import type { WakeContinuation } from './voice-input'

interface Run {
  identity: Generation
  abort: AbortController
  lease: SensorLease | null
  cleanups: (() => void)[]
  capture: Generation | null
  ready: boolean
  waiting: PcmChunk[]
}
interface Options {
  detector: WakeWordDetectorPort
  sensors: Pick<SensorPort, 'acquire' | 'release' | 'subscribe'>
  router: Pick<AudioInputRouter, 'subscribePcm' | 'subscribeProblems' | 'clearBuffer'>
  createId(): string
  schedule(callback: () => void, delayMs: number): () => void
  onState(snapshot: WakeWordSnapshot): void
  onWake(event: WakeWordEvent, continuation: WakeContinuation): Promise<Result<unknown>>
}

/** Owns standby capture; the speech session owns the lease only during a wake handoff. */
export class WakeWordController {
  private enabled = false
  private allowed = false
  private disposed = false
  private failed = false
  private run: Run | null = null
  private readonly cleanups: (() => void)[]

  constructor(private readonly options: Options) {
    this.cleanups = [
      options.detector.subscribe((event) => this.detected(event)),
      options.detector.subscribeErrors((error) => {
        if (this.run) this.fail(error)
      })
    ]
  }

  setEnabled(enabled: boolean): Result<void> {
    if (this.disposed)
      return { ok: false, error: { code: 'cancelled', message: '호출어 감지가 종료되었습니다.' } }
    this.enabled = enabled
    this.failed = false
    this.stopRun()
    this.reconcile()
    return { ok: true, value: undefined }
  }

  setAllowed(allowed: boolean): void {
    if (this.disposed || this.allowed === allowed) return
    this.allowed = allowed
    if (!allowed) this.stopRun()
    this.reconcile()
  }

  dispose(): void {
    this.disposed = true
    this.enabled = false
    this.stopRun()
    for (const stop of this.cleanups) stop()
  }

  private reconcile(): void {
    if (this.disposed || this.failed) return
    if (!this.enabled) return this.publish('off')
    if (!this.allowed) return this.publish('suspended')
    if (this.run) return
    const run: Run = {
      identity: { sessionId: this.options.createId(), revision: 0 },
      abort: new AbortController(),
      lease: null,
      cleanups: [],
      capture: null,
      ready: false,
      waiting: []
    }
    this.run = run
    this.publish('starting')
    void this.begin(run).catch(() => {
      if (this.run === run)
        this.fail({ code: 'unavailable', message: '호출어 대기를 시작하지 못했습니다.' })
    })
  }

  private async begin(run: Run): Promise<void> {
    const { detector, sensors, router } = this.options
    // Warm the native model before acquiring the microphone; no unbounded cold-start PCM queue.
    const prepared = await detector.start(run.identity, {
      encoding: 'pcm_s16le',
      channels: 1,
      sampleRateHz: 16_000
    })
    if (this.run !== run) return
    if (!prepared.ok) return this.fail(prepared.error)
    const lease = await sensors.acquire(
      { kind: 'microphone', owner: 'voice_wake', generation: run.identity },
      { signal: run.abort.signal }
    )
    if (this.run !== run) {
      if (lease.ok) void sensors.release(lease.value.leaseId)
      return
    }
    if (!lease.ok) return this.fail(lease.error)
    run.lease = lease.value
    run.cleanups.push(
      sensors.subscribe((event) => {
        if (
          event.type === 'sensor.lease_revoked' &&
          event.lease.leaseId === run.lease?.leaseId &&
          this.run === run
        ) {
          if (event.error.code === 'cancelled' || event.error.code === 'authentication_required')
            this.setAllowed(false)
          else this.fail(event.error)
        }
      })
    )
    run.cleanups.push(
      router.subscribeProblems((error) => {
        if (this.run === run) this.fail(error)
      })
    )
    run.cleanups.push(
      router.subscribePcm((chunk) => {
        if (this.run !== run) return
        if (!run.capture) {
          run.capture = chunk.generation
          void detector
            .start(chunk.generation, chunk.format)
            .then((started) => {
              if (this.run !== run) return
              if (!started.ok) return this.fail(started.error)
              run.ready = true
              this.publish('listening')
              const held = run.waiting
              run.waiting = []
              for (const pending of held) {
                if (this.run !== run) break
                const result = detector.push(pending)
                if (!result.ok) this.fail(result.error)
              }
            })
            .catch(() => {
              if (this.run === run)
                this.fail({ code: 'unavailable', message: '호출어 감지를 준비하지 못했습니다.' })
            })
        }
        if (!sameGeneration(run.capture, chunk.generation))
          return this.fail({
            code: 'unavailable',
            message: '마이크 수집이 변경되어 호출어 대기를 중단했습니다.'
          })
        if (!run.ready) {
          if (run.waiting.length >= 16)
            return this.fail({
              code: 'unavailable',
              message: '호출어 입력 처리가 지연되어 대기를 중단했습니다.'
            })
          run.waiting.push(chunk)
        } else {
          const result = detector.push(chunk)
          if (!result.ok) this.fail(result.error)
        }
      })
    )
    run.cleanups.push(
      this.options.schedule(() => {
        if (this.run === run && !run.capture)
          this.fail({ code: 'unavailable', message: '마이크에서 오디오가 들어오지 않습니다.' })
      }, 3_000)
    )
  }

  private detected(event: WakeWordEvent): void {
    const run = this.run
    if (!run?.capture || !run.lease || !run.ready || !sameGeneration(run.capture, event.generation))
      return
    this.run = null
    const lease = run.lease
    run.lease = null
    for (const stop of run.cleanups) stop()
    run.waiting = []
    void this.options.detector.stop()
    let released = false
    const continuation: WakeContinuation = {
      generation: event.generation,
      startSample: event.keywordEndSample,
      release: () => {
        if (released) return
        released = true
        void this.options.sensors.release(lease.leaseId)
      }
    }
    // The receiver releases once its speech lease is acquired, or on any rejection/cancellation.
    try {
      void this.options
        .onWake(event, continuation)
        .then((result) => {
          if (!result.ok) {
            continuation.release()
            if (!this.disposed && this.enabled && this.allowed) this.fail(result.error)
          }
        })
        .catch(() => {
          continuation.release()
          if (!this.disposed && this.enabled && this.allowed)
            this.fail({ code: 'unavailable', message: '음성 대화를 시작하지 못했습니다.' })
        })
    } catch {
      continuation.release()
      this.fail({ code: 'unavailable', message: '음성 대화를 시작하지 못했습니다.' })
    }
  }

  private stopRun(): void {
    const run = this.run
    this.run = null
    void this.options.detector.stop()
    if (!run) return
    run.abort.abort()
    for (const stop of run.cleanups) stop()
    run.waiting = []
    if (run.lease) void this.options.sensors.release(run.lease.leaseId)
    if (run.capture) void this.options.router.clearBuffer(run.capture).catch(() => undefined)
  }

  private fail(error: ClientError): void {
    this.failed = true
    this.stopRun()
    this.options.onState({ enabled: this.enabled, phase: 'error', error })
  }

  private publish(phase: WakeWordSnapshot['phase']): void {
    this.options.onState({ enabled: this.enabled, phase })
  }
}
