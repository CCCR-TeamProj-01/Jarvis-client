import { describe, expect, it, vi } from 'vitest'
import type { VoiceActivityDetectorPort } from '../../src/inference/ports'
import type { SensorPort } from '../../src/main/sensors/ports'
import type { AudioInputRouter } from '../../src/main/speech/audio-input'
import { VoiceInput } from '../../src/main/speech/voice-input'
import type { ClientError, Result } from '../../src/shared/contracts/common'
import type { SensorEvent, SensorLease } from '../../src/shared/contracts/sensors'
import type { CompletedUtterance, PcmChunk, VadEvent } from '../../src/shared/contracts/speech'

const format = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 } as const
const feature = { sessionId: 'feature', revision: 1 }
const capture = { sessionId: 'cap', revision: 0 }
const lease: SensorLease = {
  kind: 'microphone',
  owner: 'speech_session',
  generation: feature,
  leaseId: 'lease-1',
  deviceId: 'mic'
}
const chunk = (sequence: number): PcmChunk => ({
  generation: capture,
  sequence,
  startSample: sequence * 1600,
  format,
  audio: new Uint8Array(3200)
})
const completed: VadEvent = {
  type: 'speech.completed',
  reason: 'silence',
  range: { utteranceId: 'u1', generation: capture, startSample: 1000, sampleCount: 5000 }
}
const utterance: CompletedUtterance = {
  utteranceId: 'u1',
  generation: capture,
  startSample: 1000,
  sampleCount: 5000,
  format,
  audio: new Uint8Array(10000)
}

function setup(
  options: { acquire?: Result<SensorLease>; extract?: Result<CompletedUtterance> } = {}
) {
  const log: string[] = []
  let sensorListener: (event: SensorEvent) => void = () => undefined
  const sensors: Pick<SensorPort, 'acquire' | 'release' | 'subscribe'> = {
    acquire: vi.fn<SensorPort['acquire']>(async () => {
      log.push('acquire')
      return options.acquire ?? { ok: true, value: lease }
    }),
    release: vi.fn<SensorPort['release']>(async () => {
      log.push('release')
      return { ok: true, value: { status: 'released' } }
    }),
    subscribe: (listener) => {
      sensorListener = listener
      return () => undefined
    }
  }
  let pcm: (chunk: PcmChunk) => void = () => undefined
  let problem: (error: ClientError) => void = () => undefined
  const router = {
    subscribePcm: (listener: (chunk: PcmChunk) => void) => {
      pcm = listener
      return () => undefined
    },
    subscribeProblems: (listener: (error: ClientError) => void) => {
      problem = listener
      return () => undefined
    },
    extractUtterance: vi.fn<AudioInputRouter['extractUtterance']>(async () => {
      log.push('extract')
      return options.extract ?? { ok: true, value: utterance }
    }),
    clearBuffer: vi.fn<AudioInputRouter['clearBuffer']>(async () => {
      log.push('clear')
      return { ok: true, value: undefined }
    })
  }
  let vadEvent: (event: VadEvent) => void = () => undefined
  let vadError: (error: ClientError) => void = () => undefined
  const pushed: PcmChunk[] = []
  let startResolve: (result: Result<void>) => void = () => undefined
  let holdStart = false
  const vad: VoiceActivityDetectorPort = {
    start: vi.fn<VoiceActivityDetectorPort['start']>(() => {
      log.push('vad.start')
      if (holdStart)
        return new Promise<Result<void>>((resolve) => {
          startResolve = resolve
        })
      return Promise.resolve({ ok: true, value: undefined })
    }),
    push: (c) => {
      pushed.push(c)
      return { ok: true, value: undefined }
    },
    reset: () => undefined,
    stop: vi.fn<VoiceActivityDetectorPort['stop']>(async () => {
      log.push('vad.stop')
    }),
    subscribe: (listener) => {
      vadEvent = listener
      return () => undefined
    },
    subscribeErrors: (listener) => {
      vadError = listener
      return () => undefined
    }
  }
  const timers: { callback: () => void; cancelled: boolean; ms: number }[] = []
  let now = 0
  const input = new VoiceInput({
    sensors,
    router,
    vad,
    clock: { now: () => now },
    schedule: (callback, ms) => {
      const timer = { callback, cancelled: false, ms }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
  return {
    input,
    log,
    sensors,
    router,
    vad,
    pushed,
    pcm: (c: PcmChunk) => pcm(c),
    problem: (e: ClientError) => problem(e),
    vadEvent: (e: VadEvent) => vadEvent(e),
    vadError: (e: ClientError) => vadError(e),
    revoke: (error: ClientError, leaseId = lease.leaseId) =>
      sensorListener({ type: 'sensor.lease_revoked', lease: { ...lease, leaseId }, error }),
    holdVadStart: () => {
      holdStart = true
      return (result: Result<void> = { ok: true, value: undefined }) => startResolve(result)
    },
    advance: (ms: number) => {
      now += ms
    },
    fire: (predicate: (ms: number) => boolean) =>
      timers.filter((t) => !t.cancelled && predicate(t.ms)).forEach((t) => t.callback())
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const policyless = { generation: feature }

describe('VoiceInput.listen', () => {
  it('opens the microphone, runs VAD on the audio and returns the extracted utterance', async () => {
    const t = setup()
    const pending = t.input.listen(policyless)
    await flush()
    t.pcm(chunk(0))
    await flush()
    t.pcm(chunk(1))
    expect(t.pushed.map((c) => c.sequence)).toEqual([0, 1])
    expect(t.vad.start).toHaveBeenCalledWith(
      capture,
      format,
      expect.objectContaining({ firstSample: 0 })
    )
    t.vadEvent(completed)
    expect(await pending).toEqual({
      ok: true,
      value: { kind: 'utterance', utterance, reason: 'silence' }
    })
    expect(t.router.extractUtterance).toHaveBeenCalledWith(completed.range, undefined)
  })

  it('returns an empty outcome when nothing is said', async () => {
    const t = setup()
    const pending = t.input.listen(policyless)
    await flush()
    t.pcm(chunk(0))
    await flush()
    t.vadEvent({ type: 'speech.empty', generation: capture, reason: 'timeout' })
    expect(await pending).toEqual({ ok: true, value: { kind: 'empty', reason: 'timeout' } })
  })

  it('always stops VAD, discards the buffer and returns the microphone, in that order', async () => {
    const t = setup()
    const pending = t.input.listen(policyless)
    await flush()
    t.pcm(chunk(0))
    await flush()
    t.vadEvent(completed)
    await pending
    expect(t.log.slice(-4)).toEqual(['extract', 'vad.stop', 'clear', 'release'])
  })

  it('holds audio that arrives while the detector starts and replays it in order', async () => {
    const t = setup()
    const startVad = t.holdVadStart()
    const pending = t.input.listen(policyless)
    await flush()
    t.pcm(chunk(0))
    t.pcm(chunk(1))
    t.pcm(chunk(2))
    expect(t.pushed).toHaveLength(0)
    startVad()
    await flush()
    t.pcm(chunk(3))
    expect(t.pushed.map((c) => c.sequence)).toEqual([0, 1, 2, 3])
    t.vadEvent({ type: 'speech.empty', generation: capture, reason: 'timeout' })
    await pending
  })

  it('fails if the detector cannot start', async () => {
    const t = setup()
    const startVad = t.holdVadStart()
    const pending = t.input.listen(policyless)
    await flush()
    t.pcm(chunk(0))
    startVad({ ok: false, error: { code: 'unavailable', message: '모델 없음' } })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(t.log).toContain('release')
  })

  it('fails when the microphone cannot be acquired, without starting anything else', async () => {
    const t = setup({
      acquire: { ok: false, error: { code: 'permission_denied', message: '권한 필요' } }
    })
    expect(await t.input.listen(policyless)).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' }
    })
    expect(t.vad.start).not.toHaveBeenCalled()
    expect(t.log).not.toContain('release')
  })

  it('fails if no audio ever arrives', async () => {
    const t = setup()
    const pending = t.input.listen(policyless)
    await flush()
    t.fire((ms) => ms === 3000)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(t.log).toContain('release')
  })

  it('ends at once when the microphone lease is revoked, and cleans up', async () => {
    const t = setup()
    const pending = t.input.listen(policyless)
    await flush()
    t.pcm(chunk(0))
    await flush()
    t.revoke({ code: 'authentication_required', message: '로그아웃' })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'authentication_required' } })
    expect(t.log.slice(-3)).toEqual(['vad.stop', 'clear', 'release'])
  })

  it('ignores a revocation of somebody else’s lease', async () => {
    const t = setup()
    const pending = t.input.listen(policyless)
    await flush()
    t.pcm(chunk(0))
    await flush()
    t.revoke({ code: 'authentication_required', message: '다른 사용권' }, 'someone-elses-lease')
    t.vadEvent({ type: 'speech.empty', generation: capture, reason: 'timeout' })
    expect(await pending).toMatchObject({ ok: true })
  })

  it('ends when the audio breaks or the detector fails', async () => {
    const broken = setup()
    const first = broken.input.listen(policyless)
    await flush()
    broken.problem({ code: 'unavailable', message: '끊김' })
    expect(await first).toMatchObject({ ok: false, error: { code: 'unavailable' } })

    const failing = setup()
    const second = failing.input.listen(policyless)
    await flush()
    failing.vadError({ code: 'internal', message: 'VAD 오류' })
    expect(await second).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('reports an extraction failure instead of an utterance', async () => {
    const t = setup({
      extract: { ok: false, error: { code: 'not_found', message: '버퍼에 없음' } }
    })
    const pending = t.input.listen(policyless)
    await flush()
    t.pcm(chunk(0))
    await flush()
    t.vadEvent(completed)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('honours cancellation and deadlines', async () => {
    const controller = new AbortController()
    const t = setup()
    const pending = t.input.listen(policyless, { signal: controller.signal })
    await flush()
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })

    const aborted = new AbortController()
    aborted.abort()
    const t2 = setup()
    expect(await t2.input.listen(policyless, { signal: aborted.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(t2.sensors.acquire).not.toHaveBeenCalled()

    const t3 = setup()
    const late = t3.input.listen(policyless, { deadlineMs: 100 })
    await flush()
    t3.advance(200)
    t3.fire((ms) => ms === 100)
    expect(await late).toMatchObject({ ok: false, error: { code: 'expired' } })
  })

  it('refuses a second concurrent listen and allows another once the first is done', async () => {
    const t = setup()
    const first = t.input.listen(policyless)
    await flush()
    expect(await t.input.listen(policyless)).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    t.pcm(chunk(0))
    await flush()
    t.vadEvent({ type: 'speech.empty', generation: capture, reason: 'timeout' })
    await first
    const second = t.input.listen(policyless)
    await flush()
    t.pcm(chunk(0))
    await flush()
    t.vadEvent({ type: 'speech.empty', generation: capture, reason: 'timeout' })
    expect(await second).toMatchObject({ ok: true })
  })
})
