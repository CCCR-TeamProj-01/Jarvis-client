import { describe, expect, it, vi } from 'vitest'
import { AudioInputRouter } from '../../src/main/speech/audio-input'
import type { ClientError, Result } from '../../src/shared/contracts/common'
import type { CompletedUtterance, PcmChunk } from '../../src/shared/contracts/speech'
import type { MediaCommand, MediaEvent } from '../../src/shared/ipc/media-api'

const format = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 } as const
const generation = { sessionId: 'cap-1', revision: 0 }

const chunk = (sequence: number, startSample: number, gen = generation): PcmChunk => ({
  generation: gen,
  sequence,
  startSample,
  format,
  audio: new Uint8Array(3200)
})
const utterance = (id: string, gen = generation): CompletedUtterance => ({
  utteranceId: id,
  generation: gen,
  startSample: 0,
  sampleCount: 2,
  format,
  audio: new Uint8Array(4)
})

function setup(commandResult: Result<void> = { ok: true, value: undefined }) {
  let publish: (event: MediaEvent) => void = () => undefined
  const commands: MediaCommand[] = []
  const timers: { callback: () => void; cancelled: boolean }[] = []
  const bridge = {
    subscribe: (listener: (event: MediaEvent) => void) => {
      publish = listener
      return () => undefined
    },
    command: vi.fn<(command: MediaCommand) => Promise<Result<void>>>(async (command) => {
      commands.push(command)
      return commandResult
    })
  }
  const router = new AudioInputRouter({
    bridge,
    schedule: (callback) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
  return {
    router,
    commands,
    bridge,
    emit: (event: MediaEvent) => publish(event),
    expire: () => timers.filter((t) => !t.cancelled).forEach((t) => t.callback())
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('AudioInputRouter PCM routing', () => {
  it('passes chunks in order to listeners and tracks the capture generation', () => {
    const { router, emit } = setup()
    const seen = vi.fn<(chunk: PcmChunk) => void>()
    router.subscribePcm(seen)
    emit({ type: 'audio.pcm', chunk: chunk(0, 0) })
    emit({ type: 'audio.pcm', chunk: chunk(1, 1600) })
    expect(seen).toHaveBeenCalledTimes(2)
    expect(router.captureGeneration()).toEqual(generation)
  })

  it('does not keep or forward audio when nobody is listening', () => {
    const { router, emit } = setup()
    emit({ type: 'audio.pcm', chunk: chunk(0, 0) })
    const late = vi.fn<(chunk: PcmChunk) => void>()
    router.subscribePcm(late)
    expect(late).not.toHaveBeenCalled()
  })

  it('stops delivering and reports a problem when audio has a gap', () => {
    const { router, emit } = setup()
    const seen = vi.fn<(chunk: PcmChunk) => void>()
    const problem = vi.fn<(error: ClientError) => void>()
    router.subscribePcm(seen)
    router.subscribeProblems(problem)
    emit({ type: 'audio.pcm', chunk: chunk(0, 0) })
    emit({ type: 'audio.pcm', chunk: chunk(2, 3200) })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(problem).toHaveBeenCalledOnce()
  })

  it('does not join audio across different captures', () => {
    const { router, emit } = setup()
    const seen = vi.fn<(chunk: PcmChunk) => void>()
    const problem = vi.fn<(error: ClientError) => void>()
    router.subscribePcm(seen)
    router.subscribeProblems(problem)
    emit({ type: 'audio.pcm', chunk: chunk(0, 0) })
    emit({ type: 'audio.pcm', chunk: chunk(0, 0, { sessionId: 'cap-2', revision: 0 }) })
    expect(seen).toHaveBeenCalledTimes(2)
    expect(problem).not.toHaveBeenCalled()
    expect(router.captureGeneration()).toEqual({ sessionId: 'cap-2', revision: 0 })
  })

  it('reports the end of the capture to listeners', () => {
    const { router, emit } = setup()
    const problem = vi.fn<(error: ClientError) => void>()
    router.subscribeProblems(problem)
    emit({ type: 'audio.pcm', chunk: chunk(0, 0) })
    emit({ type: 'audio.capture.state', generation, state: 'stopped' })
    expect(problem).toHaveBeenCalledOnce()
    expect(router.captureGeneration()).toBeNull()
    emit({ type: 'audio.capture.state', generation, state: 'stopped' })
    expect(problem).toHaveBeenCalledOnce()
  })

  it('stops delivering after unsubscribe', () => {
    const { router, emit } = setup()
    const seen = vi.fn<(chunk: PcmChunk) => void>()
    router.subscribePcm(seen)()
    emit({ type: 'audio.pcm', chunk: chunk(0, 0) })
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('AudioInputRouter utterance extraction', () => {
  const range = { utteranceId: 'u1', generation, startSample: 0, sampleCount: 2 }

  it('returns the utterance that the renderer publishes for the range', async () => {
    const { router, emit, commands } = setup()
    const pending = router.extractUtterance(range)
    await flush()
    expect(commands).toEqual([{ type: 'audio.utterance.extract', range }])
    emit({ type: 'audio.utterance', utterance: utterance('u1') })
    expect(await pending).toMatchObject({ ok: true, value: { utteranceId: 'u1', sampleCount: 2 } })
  })

  it('ignores an utterance for another range or another capture', async () => {
    const { router, emit } = setup()
    const pending = router.extractUtterance(range)
    await flush()
    emit({ type: 'audio.utterance', utterance: utterance('other') })
    emit({ type: 'audio.utterance', utterance: utterance('u1', { sessionId: 'x', revision: 0 }) })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('fails when the renderer cannot produce the range', async () => {
    const { router } = setup({ ok: false, error: { code: 'not_found', message: '없음' } })
    expect(await router.extractUtterance(range)).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
  })

  it('times out when nothing comes back', async () => {
    const { router, expire } = setup()
    const pending = router.extractUtterance(range)
    await flush()
    expire()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('honours cancellation and refuses a duplicate request for the same utterance', async () => {
    const { router } = setup()
    const controller = new AbortController()
    const pending = router.extractUtterance(range, { signal: controller.signal })
    await flush()
    expect(await router.extractUtterance(range)).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const aborted = new AbortController()
    aborted.abort()
    expect(
      await router.extractUtterance({ ...range, utteranceId: 'u2' }, { signal: aborted.signal })
    ).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('cancels waiting extractions when their capture ends or the router is disposed', async () => {
    const { router, emit } = setup()
    emit({ type: 'audio.pcm', chunk: chunk(0, 0) })
    const first = router.extractUtterance(range)
    await flush()
    emit({
      type: 'audio.capture.state',
      generation,
      state: 'failed',
      error: { code: 'device_unavailable', message: '분리' }
    })
    expect(await first).toMatchObject({ ok: false, error: { code: 'cancelled' } })

    const second = router.extractUtterance({ ...range, utteranceId: 'u3' })
    await flush()
    router.dispose()
    expect(await second).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('asks the renderer to clear its history', async () => {
    const { router, commands } = setup()
    await router.clearBuffer(generation)
    expect(commands).toEqual([{ type: 'audio.buffer.clear', generation }])
  })
})
