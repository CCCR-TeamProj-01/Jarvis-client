import type { ClientError, Generation, Result } from '../../../shared/contracts/common'
import type { HandTrackingFrame } from '../../../shared/contracts/gesture'
import type { HandTrackerPort } from './ports'
import type { CameraFrame } from '../../../shared/ports/camera'
import type { WorkerRequest, WorkerResponse } from './worker-protocol'

/** The slice of Worker used here. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

interface Pending {
  frame: CameraFrame
  resolve(result: Result<HandTrackingFrame>): void
}

/**
 * Runs hand detection in a Worker. One frame is in the worker at a time; the bitmap is moved to
 * it, so whatever happens afterwards the caller's copy is gone and nothing leaks.
 */
export class WorkerHandTracker implements HandTrackerPort {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private generation: Generation | null = null
  private disposed = false
  private ready: Promise<Result<void>>

  constructor(
    private readonly worker: WorkerLike,
    model: Uint8Array
  ) {
    this.ready = new Promise((resolve) => {
      this.onReady = resolve
    })
    worker.onmessage = (event) => this.receive(event.data)
    worker.onerror = () => this.broken('손 인식 엔진이 중단되었습니다.')
    worker.postMessage({ type: 'init', model })
  }

  private onReady: (result: Result<void>) => void = () => undefined

  /** Resolves once the engine is loaded, or says why it could not be. */
  whenReady(): Promise<Result<void>> {
    return this.ready
  }

  async detect(frame: CameraFrame): Promise<Result<HandTrackingFrame>> {
    if (this.disposed) {
      frame.image.close()
      return failure('cancelled', '손 인식 엔진이 종료되었습니다.')
    }
    const ready = await this.ready
    if (!ready.ok || this.disposed) {
      frame.image.close()
      return ready.ok ? failure('cancelled', '손 인식 엔진이 종료되었습니다.') : ready
    }
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, { frame, resolve })
      try {
        this.worker.postMessage(
          { type: 'detect', id, image: frame.image, timestampMs: frame.capturedAtMs },
          [frame.image]
        )
      } catch {
        this.pending.delete(id)
        frame.image.close()
        resolve(failure('internal', '프레임을 손 인식 엔진에 전달하지 못했습니다.'))
      }
    })
  }

  reset(generation: Generation): void {
    this.generation = generation
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.terminate()
    this.onReady(failure('cancelled', '손 인식 엔진이 종료되었습니다.'))
    this.settleAll(failure('cancelled', '손 인식 엔진이 종료되었습니다.'))
  }

  private receive(message: WorkerResponse): void {
    switch (message.type) {
      case 'ready':
        this.onReady({ ok: true, value: undefined })
        return
      case 'failed':
        this.onReady(failure('unavailable', '손 인식 엔진을 시작하지 못했습니다.'))
        return
      case 'result': {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        const { frame } = entry
        entry.resolve({
          ok: true,
          value: {
            generation: this.generation ?? frame.generation,
            sequence: frame.sequence,
            capturedAtMs: frame.capturedAtMs,
            hands: message.hands
          }
        })
        return
      }
      case 'error': {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        entry.resolve(failure('internal', '손 인식에 실패했습니다.'))
        return
      }
    }
  }

  private broken(message: string): void {
    this.onReady(failure('unavailable', message))
    this.settleAll(failure('unavailable', message))
  }

  private settleAll(result: Result<never>): void {
    for (const entry of this.pending.values()) entry.resolve(result)
    this.pending.clear()
  }
}
