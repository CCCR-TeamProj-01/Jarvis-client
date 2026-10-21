import { describe, expect, it, vi } from 'vitest'
import type { WakeWordDetectorPort } from '../../src/inference/ports'
import { WakeWordController } from '../../src/main/speech/wake-word'
import type { WakeContinuation } from '../../src/main/speech/voice-input'
import type { SensorPort } from '../../src/main/sensors/ports'
import type { ClientError, Result } from '../../src/shared/contracts/common'
import type { PcmChunk, WakeWordEvent } from '../../src/shared/contracts/speech'
import type { SensorEvent, SensorLease } from '../../src/shared/contracts/sensors'
import type { WakeWordSnapshot } from '../../src/shared/contracts/wake-word'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const generation = { sessionId: 'capture', revision: 0 }
const lease: SensorLease = {
  kind: 'microphone',
  owner: 'voice_wake',
  leaseId: 'wake-lease',
  deviceId: 'mic',
  generation
}
const chunk: PcmChunk = {
  generation,
  sequence: 0,
  startSample: 1600,
  format: { encoding: 'pcm_s16le', channels: 1, sampleRateHz: 16_000 },
  audio: new Uint8Array(3200)
}
const event: WakeWordEvent = {
  generation,
  keyword: '자비스',
  keywordStartSample: 1600,
  keywordEndSample: 2400,
  detectedAtSample: 3200
}
function setup() {
  let pcm: (chunk: PcmChunk) => void = () => undefined
  let detected: (event: WakeWordEvent) => void = () => undefined
  let sensorEvent: (event: SensorEvent) => void = () => undefined
  let problem: (error: ClientError) => void = () => undefined
  let timer: () => void = () => undefined
  const detector: WakeWordDetectorPort = {
    start: vi.fn<WakeWordDetectorPort['start']>(async () => ({ ok: true, value: undefined })),
    push: vi.fn<WakeWordDetectorPort['push']>(() => ({ ok: true, value: undefined })),
    stop: vi.fn<() => Promise<void>>(async () => undefined),
    reset: vi.fn<() => void>(),
    subscribe: (fn) => {
      detected = fn
      return () => undefined
    },
    subscribeErrors: (fn) => {
      problem = fn
      return () => undefined
    }
  }
  const sensors = {
    acquire: vi.fn<SensorPort['acquire']>(async () => ({ ok: true, value: lease })),
    release: vi.fn<SensorPort['release']>(async () => ({
      ok: true,
      value: { status: 'released' }
    })),
    subscribe: (fn: (event: SensorEvent) => void) => {
      sensorEvent = fn
      return () => undefined
    }
  }
  const states: WakeWordSnapshot[] = []
  const onWake = vi.fn<
    (_event: WakeWordEvent, continuation: WakeContinuation) => Promise<Result<unknown>>
  >(async () => ({ ok: true, value: undefined }))
  const router = {
    clearBuffer: vi.fn<() => Promise<Result<void>>>(async () => ({
      ok: true as const,
      value: undefined
    })),
    subscribePcm: (fn: (c: PcmChunk) => void) => {
      pcm = fn
      return () => undefined
    },
    subscribeProblems: () => () => undefined
  }
  let id = 0
  const wake = new WakeWordController({
    detector,
    sensors,
    router,
    createId: () => `standby-${id++}`,
    schedule: (fn) => {
      timer = fn
      return () => undefined
    },
    onState: (s) => states.push(s),
    onWake
  })
  return {
    wake,
    detector,
    sensors,
    states,
    onWake,
    router,
    pcm: () => pcm(chunk),
    detected: (e = event) => detected(e),
    error: () => problem({ code: 'unavailable', message: 'failed' }),
    revoke: () =>
      sensorEvent({
        type: 'sensor.lease_revoked',
        lease,
        error: { code: 'permission_denied', message: 'revoked' }
      }),
    cancel: () =>
      sensorEvent({
        type: 'sensor.lease_revoked',
        lease,
        error: { code: 'cancelled', message: 'paused' }
      }),
    timer: () => timer()
  }
}
describe('wake standby ownership', () => {
  it('treats policy revocation before the pause observer as suspension and can resume', async () => {
    const t = setup()
    t.wake.setEnabled(true)
    t.wake.setAllowed(true)
    await flush()
    t.cancel()
    expect(t.states.at(-1)?.phase).toBe('suspended')
    t.wake.setAllowed(false)
    t.wake.setAllowed(true)
    await flush()
    expect(t.sensors.acquire).toHaveBeenCalledTimes(2)
    t.wake.dispose()
  })
  it('requires opt-in and permission to run, and warms the model before opening the mic', async () => {
    const t = setup()
    t.wake.setAllowed(true)
    await flush()
    expect(t.sensors.acquire).not.toHaveBeenCalled()
    t.wake.setEnabled(true)
    await flush()
    expect(t.detector.start).toHaveBeenCalledTimes(1)
    expect(t.sensors.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'voice_wake' }),
      expect.anything()
    )
    t.pcm()
    await flush()
    expect(t.states.at(-1)?.phase).toBe('listening')
    expect(t.detector.push).toHaveBeenCalledWith(chunk)
    t.wake.dispose()
  })
  it('suspends during processing/TTS and resumes only when allowed', async () => {
    const t = setup()
    t.wake.setEnabled(true)
    t.wake.setAllowed(true)
    await flush()
    t.pcm()
    await flush()
    t.wake.setAllowed(false)
    expect(t.sensors.release).toHaveBeenCalledWith('wake-lease')
    t.detected()
    expect(t.onWake).not.toHaveBeenCalled()
    expect(t.states.at(-1)?.phase).toBe('suspended')
    t.wake.setAllowed(true)
    await flush()
    expect(t.sensors.acquire).toHaveBeenCalledTimes(2)
    t.wake.dispose()
  })
  it('hands off the live lease once, retaining it until speech has acquired its lease', async () => {
    const t = setup()
    t.wake.setEnabled(true)
    t.wake.setAllowed(true)
    await flush()
    t.pcm()
    await flush()
    t.detected()
    t.detected()
    expect(t.onWake).toHaveBeenCalledTimes(1)
    expect(t.sensors.release).not.toHaveBeenCalled()
    t.wake.setAllowed(false)
    expect(t.sensors.release).not.toHaveBeenCalled()
    const continuation = t.onWake.mock.calls[0][1]
    expect(continuation).toMatchObject({ generation, startSample: 2400 })
    continuation.release()
    continuation.release()
    expect(t.sensors.release).toHaveBeenCalledTimes(1)
    t.wake.dispose()
  })
  it('ignores old capture detections', async () => {
    const t = setup()
    t.wake.setEnabled(true)
    t.wake.setAllowed(true)
    await flush()
    t.pcm()
    await flush()
    t.detected({ ...event, generation: { ...generation, revision: 10 } })
    expect(t.onWake).not.toHaveBeenCalled()
    t.wake.dispose()
  })
  it.each(['error', 'revoke', 'timer'] as const)(
    'stops on %s without a restart loop',
    async (kind) => {
      const t = setup()
      t.wake.setEnabled(true)
      t.wake.setAllowed(true)
      await flush()
      t[kind]()
      expect(t.states.at(-1)?.phase).toBe('error')
      t.wake.setAllowed(false)
      t.wake.setAllowed(true)
      await flush()
      expect(t.sensors.acquire).toHaveBeenCalledTimes(1)
      t.wake.dispose()
    }
  )
  it('returns a late-acquired lease after disabling during permission prompt', async () => {
    const t = setup()
    let resolve!: (value: Result<SensorLease>) => void
    t.sensors.acquire.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    t.wake.setEnabled(true)
    t.wake.setAllowed(true)
    await flush()
    t.wake.setEnabled(false)
    resolve({ ok: true, value: lease })
    await flush()
    expect(t.sensors.release).toHaveBeenCalledWith('wake-lease')
    expect(t.detector.push).not.toHaveBeenCalled()
    t.wake.dispose()
  })
  it('releases handoff if voice activation is rejected', async () => {
    const t = setup()
    t.onWake.mockResolvedValue({
      ok: false,
      error: { code: 'authentication_required', message: 'signed out' }
    })
    t.wake.setEnabled(true)
    t.wake.setAllowed(true)
    await flush()
    t.pcm()
    await flush()
    t.detected()
    await flush()
    expect(t.sensors.release).toHaveBeenCalledWith('wake-lease')
    expect(t.states.at(-1)?.phase).toBe('error')
    t.wake.dispose()
  })
})
