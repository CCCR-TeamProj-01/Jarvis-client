import { VAD_SAMPLE_RATE_HZ, VadWorkerMessageSchema } from '../../inference/vad/protocol'
import type { VadWorkerRequest } from '../../inference/vad/protocol'
import type { VoiceActivityDetectorPort, VoiceActivityDetectorStart } from '../../inference/ports'
import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type { PcmChunk, PcmFormat, VadEvent } from '../../shared/contracts/speech'

/** The parts of a child process this adapter uses (Electron's utilityProcess, or a fake). */
export interface VadProcess {
  postMessage(message: VadWorkerRequest): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number | null) => void): void
  kill(): void
}

interface UtilityProcessVadOptions {
  spawn(): VadProcess
  /** Resolved when the process is started, not at construction. */
  modelPath(): string
  /** False when the model file is missing, so the failure can say what to do. */
  modelAvailable?(): boolean
  readyTimeoutMs?: number
  /** Returns a cancel function. Injected so the start timeout can be tested. */
  schedule(callback: () => void, delayMs: number): () => void
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Runs Silero VAD in a separate process so inference cannot stall Main and a crash only costs the
 * current utterance. The process is started on demand and reused; if it dies, the next `start`
 * brings up a fresh one and listeners are told.
 */
export class UtilityProcessVad implements VoiceActivityDetectorPort {
  private process: VadProcess | null = null
  private ready: Promise<Result<void>> | null = null
  private generation: Generation | null = null
  private readonly events = new Set<(event: VadEvent) => void>()
  private readonly errors = new Set<(error: ClientError) => void>()

  constructor(private readonly options: UtilityProcessVadOptions) {}

  async start(
    generation: Generation,
    format: PcmFormat,
    { policy, firstSample }: VoiceActivityDetectorStart
  ): Promise<Result<void>> {
    if (format.sampleRateHz !== VAD_SAMPLE_RATE_HZ)
      return failure('invalid_input', '지원하지 않는 샘플레이트입니다.')
    if (this.options.modelAvailable && !this.options.modelAvailable())
      return failure(
        'unavailable',
        '음성 모델 파일이 없습니다. `pnpm models:fetch`로 내려받아 주세요.'
      )
    const ready = await this.ensureProcess()
    if (!ready.ok) return ready
    this.generation = generation
    this.process?.postMessage({ type: 'start', generation, firstSample, policy })
    return { ok: true, value: undefined }
  }

  push(chunk: PcmChunk): Result<void> {
    if (!this.process || !this.generation || !sameGeneration(this.generation, chunk.generation))
      return failure('conflict', '음성 구간 감지가 시작되지 않았습니다.')
    if (chunk.format.sampleRateHz !== VAD_SAMPLE_RATE_HZ)
      return failure('invalid_input', '지원하지 않는 샘플레이트입니다.')
    this.process.postMessage({ type: 'pcm', startSample: chunk.startSample, audio: chunk.audio })
    return { ok: true, value: undefined }
  }

  reset(generation: Generation): void {
    if (this.generation && sameGeneration(this.generation, generation)) void this.stop()
  }

  async stop(): Promise<void> {
    this.generation = null
    this.process?.postMessage({ type: 'stop' })
  }

  subscribe(listener: (event: VadEvent) => void): Unsubscribe {
    this.events.add(listener)
    return () => {
      this.events.delete(listener)
    }
  }

  subscribeErrors(listener: (error: ClientError) => void): Unsubscribe {
    this.errors.add(listener)
    return () => {
      this.errors.delete(listener)
    }
  }

  dispose(): void {
    const process = this.process
    this.process = null
    this.ready = null
    this.generation = null
    process?.kill()
    this.events.clear()
    this.errors.clear()
  }

  // --- process management ----------------------------------------------------------------------

  private ensureProcess(): Promise<Result<void>> {
    if (this.process && this.ready) return this.ready
    const child = this.options.spawn()
    this.process = child
    this.ready = new Promise<Result<void>>((resolve) => {
      const cancel = this.options.schedule(() => {
        // Never became ready: drop it so the next attempt starts clean.
        this.drop(child)
        child.kill()
        resolve(failure('unavailable', '음성 구간 감지 프로세스를 시작하지 못했습니다.'))
      }, this.options.readyTimeoutMs ?? 10_000)

      child.onMessage((message) => {
        if (this.process !== child) return
        const parsed = VadWorkerMessageSchema.safeParse(message)
        if (!parsed.success) return
        const value = parsed.data
        if (value.type === 'ready') {
          cancel()
          resolve({ ok: true, value: undefined })
        } else if (value.type === 'event') this.deliver(value.event)
        else this.reportError(value.error)
      })
      child.onExit(() => {
        cancel()
        if (this.process !== child) return
        const hadSession = this.generation !== null
        this.drop(child)
        resolve(failure('unavailable', '음성 구간 감지 프로세스가 종료되었습니다.'))
        if (hadSession)
          this.reportError({
            code: 'unavailable',
            message: '음성 구간 감지 프로세스가 종료되었습니다.'
          })
      })
      child.postMessage({ type: 'init', modelPath: this.options.modelPath() })
    })
    return this.ready
  }

  private drop(child: VadProcess): void {
    if (this.process !== child) return
    this.process = null
    this.ready = null
    this.generation = null
  }

  private deliver(event: VadEvent): void {
    // A late event from an utterance that was already stopped or replaced is ignored.
    const generation = event.type === 'speech.completed' ? event.range.generation : event.generation
    if (!this.generation || !sameGeneration(this.generation, generation)) return
    for (const listener of [...this.events]) {
      try {
        listener(event)
      } catch {
        /* One observer cannot affect others. */
      }
    }
  }

  private reportError(error: ClientError): void {
    for (const listener of [...this.errors]) {
      try {
        listener(error)
      } catch {
        /* One observer cannot affect others. */
      }
    }
  }
}
