import { describe, expect, it, vi } from 'vitest'
import { WorkerHandTracker } from '../../src/renderer/media/hand-tracking/tracker-client'
import type { WorkerLike } from '../../src/renderer/media/hand-tracking/tracker-client'
import type {
  WorkerRequest,
  WorkerResponse
} from '../../src/renderer/media/hand-tracking/worker-protocol'

const generation = { sessionId: 'g', revision: 1 }
const idOf = (sent: { message: WorkerRequest } | undefined) =>
  sent?.message.type === 'detect' ? sent.message.id : -1
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const bitmap = () =>
  ({ close: vi.fn<() => void>() }) as unknown as ImageBitmap & { close: () => void }

function setup() {
  const sent: { message: WorkerRequest; transfer?: Transferable[] }[] = []
  const worker: WorkerLike & { reply(message: WorkerResponse): void; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage(message, transfer) {
      sent.push({ message, transfer })
    },
    terminate() {
      this.terminated = true
    },
    reply(message) {
      this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>)
    }
  }
  const tracker = new WorkerHandTracker(worker, new Uint8Array([9]))
  tracker.reset(generation)
  return { worker, tracker, sent }
}
const frame = (sequence = 1) => ({
  generation,
  sequence,
  capturedAtMs: 100 + sequence,
  image: bitmap()
})

describe('WorkerHandTracker', () => {
  it('sends the model once and waits for the engine before analysing', async () => {
    const t = setup()
    expect(t.sent[0]?.message).toMatchObject({ type: 'init' })
    const result = t.tracker.detect(frame())
    await flush()
    expect(t.sent).toHaveLength(1)
    t.worker.reply({ type: 'ready' })
    await flush()
    expect(t.sent[1]?.message).toMatchObject({ type: 'detect', timestampMs: 101 })
    t.worker.reply({ type: 'result', id: idOf(t.sent[1]), hands: [] })
    expect(await result).toEqual({
      ok: true,
      value: { generation, sequence: 1, capturedAtMs: 101, hands: [] }
    })
  })

  it('moves the bitmap to the worker instead of copying it', async () => {
    const t = setup()
    t.worker.reply({ type: 'ready' })
    const f = frame()
    void t.tracker.detect(f)
    await flush()
    expect(t.sent[1]?.transfer).toEqual([f.image])
  })

  it('reports a worker error for that frame only', async () => {
    const t = setup()
    t.worker.reply({ type: 'ready' })
    const result = t.tracker.detect(frame())
    await flush()
    t.worker.reply({ type: 'error', id: idOf(t.sent[1]), message: 'x' })
    expect(await result).toMatchObject({ ok: false, error: { code: 'internal' } })
    const next = t.tracker.detect(frame(2))
    await flush()
    t.worker.reply({ type: 'result', id: idOf(t.sent[2]), hands: [] })
    expect((await next).ok).toBe(true)
  })

  it('closes the picture and reports failure when the engine cannot load', async () => {
    const t = setup()
    t.worker.reply({ type: 'failed', message: 'no wasm' })
    expect(await t.tracker.whenReady()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    const f = frame()
    expect(await t.tracker.detect(f)).toMatchObject({ ok: false })
    expect(f.image.close).toHaveBeenCalled()
  })

  it('settles outstanding frames when the worker crashes', async () => {
    const t = setup()
    t.worker.reply({ type: 'ready' })
    const result = t.tracker.detect(frame())
    await flush()
    t.worker.onerror?.({} as ErrorEvent)
    expect(await result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('terminates the worker on dispose and cancels outstanding work', async () => {
    const t = setup()
    t.worker.reply({ type: 'ready' })
    const result = t.tracker.detect(frame())
    await flush()
    await t.tracker.dispose()
    expect(t.worker.terminated).toBe(true)
    expect(await result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const late = frame(2)
    expect(await t.tracker.detect(late)).toMatchObject({ ok: false })
    expect(late.image.close).toHaveBeenCalled()
  })
})
