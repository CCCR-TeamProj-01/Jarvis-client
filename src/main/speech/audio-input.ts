import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import { CompletedUtteranceSchema, isContiguousPcm } from '../../shared/contracts/speech'
import type { CompletedUtterance, PcmChunk, UtteranceRange } from '../../shared/contracts/speech'
import type { MediaBridge } from '../sensors/media-bridge'
import type { LocalExecutionOptions } from '../ports'

interface AudioInputRouterOptions {
  bridge: Pick<MediaBridge, 'subscribe' | 'command'>
  /** Returns a cancel function. Injected so extraction timeouts can be tested. */
  schedule(callback: () => void, delayMs: number): () => void
  extractTimeoutMs?: number
}

interface Waiter {
  generation: Generation
  resolve(result: Result<CompletedUtterance>): void
  cancel(): void
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Main's view of the microphone stream. PCM is passed on only while someone listens, only in
 * unbroken order, and never stored here; the capture buffer lives in the Media Renderer and
 * finished utterances are pulled from it by sample range.
 */
export class AudioInputRouter {
  private readonly pcmListeners = new Set<(chunk: PcmChunk) => void>()
  private readonly problemListeners = new Set<(error: ClientError) => void>()
  private readonly waiters = new Map<string, Waiter>()
  private current: Generation | null = null
  private last: PcmChunk | null = null
  private readonly unsubscribe: Unsubscribe

  constructor(private readonly options: AudioInputRouterOptions) {
    this.unsubscribe = options.bridge.subscribe((event) => {
      switch (event.type) {
        case 'audio.pcm':
          return this.onPcm(event.chunk)
        case 'audio.utterance':
          return this.onUtterance(event.utterance)
        case 'audio.capture.state':
          if (event.state !== 'started') this.onCaptureEnded(event.generation, event.error)
          return
        default:
          return
      }
    })
  }

  /** Generation of the capture currently streaming, if any. */
  captureGeneration(): Generation | null {
    return this.current
  }

  subscribePcm(listener: (chunk: PcmChunk) => void): Unsubscribe {
    this.pcmListeners.add(listener)
    return () => {
      this.pcmListeners.delete(listener)
    }
  }

  /** A gap in the audio, or the capture ending. Whoever is listening must stop and discard. */
  subscribeProblems(listener: (error: ClientError) => void): Unsubscribe {
    this.problemListeners.add(listener)
    return () => {
      this.problemListeners.delete(listener)
    }
  }

  async clearBuffer(generation: Generation): Promise<Result<void>> {
    return this.options.bridge.command({ type: 'audio.buffer.clear', generation }, 5_000)
  }

  async extractUtterance(
    range: UtteranceRange,
    options?: LocalExecutionOptions
  ): Promise<Result<CompletedUtterance>> {
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    if (this.waiters.has(range.utteranceId))
      return failure('conflict', '같은 발화를 이미 추출하고 있습니다.')
    const answer = new Promise<Result<CompletedUtterance>>((resolve) => {
      const cancel = this.options.schedule(() => {
        this.waiters.delete(range.utteranceId)
        resolve(failure('unavailable', '발화 추출 응답을 받지 못했습니다.'))
      }, this.options.extractTimeoutMs ?? 5_000)
      this.waiters.set(range.utteranceId, { generation: range.generation, resolve, cancel })
      options?.signal?.addEventListener(
        'abort',
        () => this.settle(range.utteranceId, failure('cancelled', '요청이 취소되었습니다.')),
        { once: true }
      )
    })
    // Register the waiter first: the utterance event may arrive before the command's own result.
    const sent = await this.options.bridge.command(
      { type: 'audio.utterance.extract', range },
      this.options.extractTimeoutMs ?? 5_000,
      options
    )
    if (!sent.ok) this.settle(range.utteranceId, sent)
    return answer
  }

  dispose(): void {
    this.unsubscribe()
    for (const id of [...this.waiters.keys()])
      this.settle(id, failure('cancelled', '오디오 입력을 종료했습니다.'))
    this.pcmListeners.clear()
    this.problemListeners.clear()
  }

  // --- events ----------------------------------------------------------------------------------

  private onPcm(chunk: PcmChunk): void {
    if (this.current && !sameGeneration(this.current, chunk.generation)) {
      // A different capture started: nothing continues across it.
      this.last = null
    }
    this.current = chunk.generation
    if (this.last && !isContiguousPcm(this.last, chunk)) {
      this.last = null
      this.problem({ code: 'unavailable', message: '오디오 입력에 끊김이 있어 수집을 중단합니다.' })
      return
    }
    this.last = chunk
    if (this.pcmListeners.size === 0) return
    for (const listener of [...this.pcmListeners]) {
      try {
        listener(chunk)
      } catch {
        /* One observer cannot affect others. */
      }
    }
  }

  private onUtterance(utterance: CompletedUtterance): void {
    const waiter = this.waiters.get(utterance.utteranceId)
    if (!waiter) return
    const parsed = CompletedUtteranceSchema.safeParse(utterance)
    this.settle(
      utterance.utteranceId,
      parsed.success && sameGeneration(waiter.generation, utterance.generation)
        ? { ok: true, value: parsed.data }
        : failure('internal', '추출한 발화가 요청과 일치하지 않습니다.')
    )
  }

  private onCaptureEnded(generation: Generation, error?: ClientError): void {
    if (!this.current || !sameGeneration(this.current, generation)) return
    this.current = null
    this.last = null
    for (const [id, waiter] of [...this.waiters])
      if (sameGeneration(waiter.generation, generation))
        this.settle(id, failure('cancelled', '오디오 수집이 종료되었습니다.'))
    this.problem(error ?? { code: 'cancelled', message: '오디오 수집이 종료되었습니다.' })
  }

  private settle(id: string, result: Result<CompletedUtterance>): void {
    const waiter = this.waiters.get(id)
    if (!waiter) return
    this.waiters.delete(id)
    waiter.cancel()
    waiter.resolve(result)
  }

  private problem(error: ClientError): void {
    for (const listener of [...this.problemListeners]) {
      try {
        listener(error)
      } catch {
        /* One observer cannot affect others. */
      }
    }
  }
}
