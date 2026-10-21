import { WakeWorkerMessageSchema, WAKE_SAMPLE_RATE } from '../../inference/wake-word/protocol'
import type { WakeWorkerRequest } from '../../inference/wake-word/protocol'
import type { WakeWordDetectorPort } from '../../inference/ports'
import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type { PcmChunk, PcmFormat, WakeWordEvent } from '../../shared/contracts/speech'

export interface WakeProcess {
  postMessage(message: WakeWorkerRequest): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: () => void): void
  kill(): void
}
interface Options {
  spawn(): WakeProcess
  assets(): { modelPath: string; libraryPath: string } | null
  schedule(callback: () => void, delayMs: number): () => void
}
const error: ClientError = {
  code: 'unavailable',
  message: '호출어 감지를 실행하지 못했습니다. 모델 설치와 실행 환경을 확인해 주세요.'
}
const failure = (): Result<never> => ({ ok: false, error })

/** Bounded IPC, process identity and capture generation are checked before delivering a detection. */
export class UtilityProcessWake implements WakeWordDetectorPort {
  private process: WakeProcess | null = null
  private ready: Promise<Result<void>> | null = null
  private generation: Generation | null = null
  private readonly pending = new Set<number>()
  private readonly events = new Set<(event: WakeWordEvent) => void>()
  private readonly errors = new Set<(error: ClientError) => void>()
  private settleReady: ((value: Result<void>) => void) | null = null
  private cancelReady: (() => void) | null = null

  constructor(private readonly options: Options) {}

  async start(generation: Generation, format: PcmFormat): Promise<Result<void>> {
    if (
      format.sampleRateHz !== WAKE_SAMPLE_RATE ||
      format.channels !== 1 ||
      format.encoding !== 'pcm_s16le'
    )
      return {
        ok: false,
        error: { code: 'invalid_input', message: '호출어 오디오 형식이 올바르지 않습니다.' }
      }
    this.generation = generation
    this.pending.clear()
    const ready = await this.ensureProcess()
    if (!ready.ok) return ready
    if (!this.generation || !sameGeneration(this.generation, generation))
      return { ok: false, error: { code: 'cancelled', message: '호출어 대기가 중단되었습니다.' } }
    try {
      this.process!.postMessage({ type: 'start', generation })
      return { ok: true, value: undefined }
    } catch {
      this.fail()
      return failure()
    }
  }

  push(chunk: PcmChunk): Result<void> {
    if (!this.process || !this.generation || !sameGeneration(this.generation, chunk.generation))
      return failure()
    if (this.pending.size >= 16 || this.pending.has(chunk.sequence)) {
      this.fail()
      return failure()
    }
    this.pending.add(chunk.sequence)
    try {
      this.process.postMessage({ type: 'pcm', chunk })
      return { ok: true, value: undefined }
    } catch {
      this.fail()
      return failure()
    }
  }

  reset(generation: Generation): void {
    if (this.generation && sameGeneration(this.generation, generation)) void this.stop()
  }

  async stop(): Promise<void> {
    this.generation = null
    this.pending.clear()
    try {
      this.process?.postMessage({ type: 'stop' })
    } catch {
      this.disposeProcess()
    }
  }

  subscribe(listener: (event: WakeWordEvent) => void): Unsubscribe {
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
    this.disposeProcess()
    this.events.clear()
    this.errors.clear()
  }

  private ensureProcess(): Promise<Result<void>> {
    if (this.ready) return this.ready
    const assets = this.options.assets()
    if (!assets) return Promise.resolve(failure())
    try {
      const child = this.options.spawn()
      this.process = child
      this.ready = new Promise((resolve) => {
        this.settleReady = resolve
      })
      this.cancelReady = this.options.schedule(() => this.fail(), 15_000)
      child.onMessage((message) => {
        if (this.process !== child) return
        const parsed = WakeWorkerMessageSchema.safeParse(message)
        if (!parsed.success) return this.fail()
        const value = parsed.data
        if (value.type === 'ready') {
          this.cancelReady?.()
          this.cancelReady = null
          this.settleReady?.({ ok: true, value: undefined })
          this.settleReady = null
        } else if (value.type === 'error') this.fail()
        else if (value.type === 'consumed') {
          if (this.generation && sameGeneration(this.generation, value.generation))
            this.pending.delete(value.sequence)
        } else if (this.generation && sameGeneration(this.generation, value.event.generation)) {
          for (const listener of [...this.events]) listener(value.event)
        }
      })
      child.onExit(() => {
        if (this.process === child) this.fail()
      })
      child.postMessage({ type: 'init', ...assets })
      return this.ready ?? Promise.resolve(failure())
    } catch {
      this.disposeProcess()
      return Promise.resolve(failure())
    }
  }

  private disposeProcess(): void {
    const child = this.process
    this.process = null
    this.ready = null
    this.generation = null
    this.pending.clear()
    this.cancelReady?.()
    this.cancelReady = null
    this.settleReady?.(failure())
    this.settleReady = null
    child?.kill()
  }

  private fail(): void {
    this.disposeProcess()
    for (const listener of [...this.errors]) listener(error)
  }
}
