import { describe, expect, it, vi } from 'vitest'
import { UtilityProcessWake } from '../../src/main/speech/wake-process'
import type { WakeProcess } from '../../src/main/speech/wake-process'
import type { WakeWorkerRequest } from '../../src/inference/wake-word/protocol'

const generation = { sessionId: 'capture', revision: 0 }
const format = { encoding: 'pcm_s16le', channels: 1, sampleRateHz: 16_000 } as const
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function setup(available = true) {
  let receive: (m: unknown) => void = () => undefined
  let exit: () => void = () => undefined
  let timeout: () => void = () => undefined
  const child: WakeProcess = {
    postMessage: vi.fn<(m: WakeWorkerRequest) => void>(),
    kill: vi.fn<() => void>(),
    onMessage: (fn) => {
      receive = fn
    },
    onExit: (fn) => {
      exit = fn
    }
  }
  const detector = new UtilityProcessWake({
    spawn: () => child,
    assets: () => (available ? { modelPath: '/model', libraryPath: '/lib' } : null),
    schedule: (callback) => {
      timeout = callback
      return () => undefined
    }
  })
  const error = vi.fn<(value: unknown) => void>()
  const event = vi.fn<(value: unknown) => void>()
  detector.subscribeErrors(error)
  detector.subscribe(event)
  return {
    detector,
    child,
    error,
    event,
    receive: (m: unknown) => receive(m),
    exit: () => exit(),
    timeout: () => timeout()
  }
}
const event = {
  type: 'event',
  event: {
    generation,
    keyword: '자비스',
    keywordStartSample: 0,
    keywordEndSample: 100,
    detectedAtSample: 1600
  }
}
describe('wake inference process', () => {
  it('reports missing assets before spawning', async () => {
    const t = setup(false)
    expect(await t.detector.start(generation, format)).toMatchObject({ ok: false })
    expect(t.child.postMessage).not.toHaveBeenCalled()
  })
  it('does not start a capture stopped during native initialization', async () => {
    const t = setup()
    const starting = t.detector.start(generation, format)
    await t.detector.stop()
    t.receive({ type: 'ready' })
    expect(await starting).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(t.child.postMessage).not.toHaveBeenCalledWith({ type: 'start', generation })
  })
  it('rejects malformed process events and ignores old captures after stop', async () => {
    const t = setup()
    const starting = t.detector.start(generation, format)
    t.receive({ type: 'ready' })
    await starting
    t.detector.push({
      generation,
      format,
      sequence: 0,
      startSample: 0,
      audio: new Uint8Array(3200)
    })
    t.receive(event)
    expect(t.event).toHaveBeenCalledTimes(1)
    await t.detector.stop()
    t.receive(event)
    expect(t.event).toHaveBeenCalledTimes(1)
    t.receive({ ...event, event: { ...event.event, keywordEndSample: 0 } })
    expect(t.child.kill).toHaveBeenCalledTimes(1)
  })
  it('bounds unacknowledged PCM and kills a stuck decoder', async () => {
    const t = setup()
    const starting = t.detector.start(generation, format)
    t.receive({ type: 'ready' })
    await starting
    const chunk = (sequence: number) => ({
      generation,
      format,
      sequence,
      startSample: sequence * 1600,
      audio: new Uint8Array(3200)
    })
    for (let n = 0; n < 16; n++) expect(t.detector.push(chunk(n)).ok).toBe(true)
    t.receive({ type: 'consumed', generation, sequence: 0 })
    expect(t.detector.push(chunk(16)).ok).toBe(true)
    expect(t.detector.push(chunk(17)).ok).toBe(false)
    expect(t.child.kill).toHaveBeenCalledTimes(1)
    expect(t.error).toHaveBeenCalledTimes(1)
  })
  it.each(['timeout', 'exit'] as const)('settles pending initialization on %s', async (kind) => {
    const t = setup()
    const starting = t.detector.start(generation, format)
    t[kind]()
    expect(await starting).toMatchObject({ ok: false })
    await flush()
    expect(t.child.kill).toHaveBeenCalledTimes(1)
  })
})
