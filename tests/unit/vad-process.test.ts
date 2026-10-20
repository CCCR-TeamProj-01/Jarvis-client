import { describe, expect, it, vi } from 'vitest'
import type { VadWorkerRequest } from '../../src/inference/vad/protocol'
import { DEFAULT_VAD_POLICY } from '../../src/inference/vad/vad-policy'
import { UtilityProcessVad } from '../../src/main/speech/vad-process'
import type { VadProcess } from '../../src/main/speech/vad-process'
import type { ClientError } from '../../src/shared/contracts/common'
import type { PcmChunk, VadEvent } from '../../src/shared/contracts/speech'

const format = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 } as const
const generation = { sessionId: 'cap', revision: 0 }
const chunk = (startSample: number, gen = generation, rate = 16000): PcmChunk => ({
  generation: gen,
  sequence: 0,
  startSample,
  format: { ...format, sampleRateHz: rate },
  audio: new Uint8Array(3200)
})

class FakeProcess implements VadProcess {
  sent: VadWorkerRequest[] = []
  killed = false
  private message: (m: unknown) => void = () => undefined
  private exit: (code: number | null) => void = () => undefined
  postMessage(message: VadWorkerRequest) {
    this.sent.push(message)
    if (message.type === 'init' && this.autoReady)
      queueMicrotask(() => this.message({ type: 'ready' }))
  }
  onMessage(listener: (m: unknown) => void) {
    this.message = listener
  }
  onExit(listener: (code: number | null) => void) {
    this.exit = listener
  }
  kill() {
    this.killed = true
    return true
  }
  autoReady = true
  say(message: unknown) {
    this.message(message)
  }
  die(code: number | null = 1) {
    this.exit(code)
  }
}

function setup({ modelAvailable = true, firstAutoReady = true } = {}) {
  const processes: FakeProcess[] = []
  const timers: { callback: () => void; cancelled: boolean }[] = []
  const vad = new UtilityProcessVad({
    spawn: () => {
      const process = new FakeProcess()
      if (processes.length === 0) process.autoReady = firstAutoReady
      processes.push(process)
      return process
    },
    modelPath: () => '/models/silero_vad.onnx',
    modelAvailable: () => modelAvailable,
    schedule: (callback) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
  const events: VadEvent[] = []
  const errors: ClientError[] = []
  vad.subscribe((event) => events.push(event))
  vad.subscribeErrors((error) => errors.push(error))
  return {
    vad,
    processes,
    events,
    errors,
    expire: () => timers.filter((t) => !t.cancelled).forEach((t) => t.callback())
  }
}
const options = { policy: DEFAULT_VAD_POLICY, firstSample: 100 }
const completed = (gen = generation): VadEvent => ({
  type: 'speech.completed',
  reason: 'silence',
  range: { utteranceId: 'u', generation: gen, startSample: 0, sampleCount: 10 }
})

describe('UtilityProcessVad', () => {
  it('starts the worker, gives it the model and policy, and forwards PCM', async () => {
    const { vad, processes } = setup()
    expect(await vad.start(generation, format, options)).toEqual({ ok: true, value: undefined })
    expect(processes[0].sent[0]).toEqual({ type: 'init', modelPath: '/models/silero_vad.onnx' })
    expect(processes[0].sent[1]).toMatchObject({ type: 'start', generation, firstSample: 100 })
    expect(vad.push(chunk(100))).toEqual({ ok: true, value: undefined })
    expect(processes[0].sent[2]).toMatchObject({ type: 'pcm', startSample: 100 })
  })

  it('reuses one worker process across utterances', async () => {
    const { vad, processes } = setup()
    await vad.start(generation, format, options)
    await vad.stop()
    await vad.start({ sessionId: 'cap', revision: 1 }, format, options)
    expect(processes).toHaveLength(1)
    expect(processes[0].sent.map((m) => m.type)).toEqual(['init', 'start', 'stop', 'start'])
  })

  it('delivers events for the current utterance and drops stale ones', async () => {
    const { vad, processes, events } = setup()
    await vad.start(generation, format, options)
    processes[0].say({ type: 'event', event: completed() })
    processes[0].say({ type: 'event', event: completed({ sessionId: 'old', revision: 0 }) })
    expect(events).toHaveLength(1)
    await vad.stop()
    processes[0].say({ type: 'event', event: completed() })
    expect(events).toHaveLength(1)
  })

  it('ignores malformed messages from the worker', async () => {
    const { vad, processes, events, errors } = setup()
    await vad.start(generation, format, options)
    processes[0].say({ type: 'event', event: { type: 'speech.completed' } })
    processes[0].say('nonsense')
    expect(events).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })

  it('forwards worker errors', async () => {
    const { vad, processes, errors } = setup()
    await vad.start(generation, format, options)
    processes[0].say({ type: 'error', error: { code: 'internal', message: '실패' } })
    expect(errors).toEqual([{ code: 'internal', message: '실패' }])
  })

  it('refuses PCM that is not for the running utterance or is the wrong rate', async () => {
    const { vad } = setup()
    expect(vad.push(chunk(0))).toMatchObject({ ok: false, error: { code: 'conflict' } })
    await vad.start(generation, format, options)
    expect(vad.push(chunk(0, { sessionId: 'other', revision: 0 }))).toMatchObject({ ok: false })
    expect(vad.push(chunk(0, generation, 8000))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    expect(await vad.start(generation, { ...format, sampleRateHz: 44100 }, options)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
  })

  it('names the fix when the model file is missing and starts no process', async () => {
    const { vad, processes } = setup({ modelAvailable: false })
    const result = await vad.start(generation, format, options)
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(JSON.stringify(result)).toContain('models:fetch')
    expect(processes).toHaveLength(0)
  })

  it('fails and discards a worker that never becomes ready, then recovers with a new one', async () => {
    const { vad, processes, expire } = setup({ firstAutoReady: false })
    const stuck = vad.start(generation, format, options)
    await Promise.resolve()
    expire()
    expect(await stuck).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(processes[0].killed).toBe(true)
    expect(await vad.start(generation, format, options)).toMatchObject({ ok: true })
    expect(processes).toHaveLength(2)
  })

  it('reports an unexpected exit during an utterance and restarts on the next start', async () => {
    const { vad, processes, errors } = setup()
    await vad.start(generation, format, options)
    processes[0].die(139)
    expect(errors).toMatchObject([{ code: 'unavailable' }])
    expect(vad.push(chunk(100))).toMatchObject({ ok: false })
    expect(await vad.start({ sessionId: 'cap', revision: 1 }, format, options)).toMatchObject({
      ok: true
    })
    expect(processes).toHaveLength(2)
  })

  it('does not report an exit as an error when no utterance was running', async () => {
    const { vad, processes, errors } = setup()
    await vad.start(generation, format, options)
    await vad.stop()
    processes[0].die(0)
    expect(errors).toHaveLength(0)
  })

  it('kills the worker and silences listeners on dispose', async () => {
    const { vad, processes, events } = setup()
    await vad.start(generation, format, options)
    vad.dispose()
    expect(processes[0].killed).toBe(true)
    processes[0].say({ type: 'event', event: completed() })
    expect(events).toHaveLength(0)
  })

  it('resets only the matching generation', async () => {
    const { vad, processes } = setup()
    await vad.start(generation, format, options)
    vad.reset({ sessionId: 'other', revision: 0 })
    expect(processes[0].sent.at(-1)?.type).toBe('start')
    vad.reset(generation)
    await Promise.resolve()
    expect(processes[0].sent.at(-1)?.type).toBe('stop')
    vi.restoreAllMocks()
  })
})
