import { describe, expect, it, vi } from 'vitest'
import { describeMediaError, MediaController } from '../../src/renderer/media/media-controller'
import type { AudioCapture } from '../../src/renderer/media/audio-capture/web-audio-capture'
import type { Result } from '../../src/shared/contracts/common'
import { FakeDevices } from '../fixtures/media-devices'
import type { MediaApi, MediaCommandEnvelope, MediaEvent } from '../../src/shared/ipc/media-api'

function setup(queryPermission?: () => Promise<'granted' | 'denied' | 'prompt' | 'unknown'>) {
  const devices = new FakeDevices()
  const published: MediaEvent[] = []
  let deliver: (envelope: MediaCommandEnvelope) => void = () => undefined
  const unsubscribe = vi.fn<() => void>()
  const api: MediaApi = {
    platform: 'test',
    subscribeCommands: (listener) => {
      deliver = listener
      return unsubscribe
    },
    publish: (event) => {
      published.push(event)
    }
  }
  const controller = new MediaController(api, devices, queryPermission)
  let id = 0
  const send = (command: MediaCommandEnvelope['command']) => {
    const commandId = `cmd-${++id}`
    deliver({ commandId, command })
    return commandId
  }
  return { controller, devices, published, send, unsubscribe }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const gen = (id: string) => ({ sessionId: id, revision: 0 })
const resultOf = (published: MediaEvent[], commandId: string) =>
  published.find((event) => event.type === 'media.command_result' && event.commandId === commandId)

describe('MediaController', () => {
  it('lists devices of one kind, dropping blank ids and keeping labels when known', async () => {
    const { send, published } = setup()
    const commandId = send({ type: 'devices.list', kind: 'camera' })
    await flush()
    expect(published).toContainEqual({
      type: 'media.devices',
      commandId,
      result: {
        ok: true,
        value: [
          { kind: 'camera', deviceId: 'cam-0', label: 'Built-in' },
          { kind: 'camera', deviceId: 'cam-1' }
        ]
      }
    })
    send({ type: 'devices.list', kind: 'microphone' })
    await flush()
    expect(published.at(-1)).toMatchObject({
      result: { ok: true, value: [{ kind: 'microphone', deviceId: 'mic-0' }] }
    })
  })

  it('opens the requested device exactly and reports started', async () => {
    const { send, devices, published } = setup()
    const commandId = send({
      type: 'camera.start',
      request: { generation: gen('s1'), leaseId: 's1', deviceId: 'cam-1' }
    })
    await flush()
    expect(devices.requests).toEqual([{ video: { deviceId: { exact: 'cam-1' } } }])
    expect(resultOf(published, commandId)).toMatchObject({ result: { ok: true } })
    expect(published).toContainEqual({
      type: 'camera.state',
      generation: gen('s1'),
      state: 'started'
    })
  })

  it('opens a mono microphone stream', async () => {
    const { send, devices } = setup()
    send({
      type: 'audio.capture.start',
      request: {
        generation: gen('s1'),
        leaseId: 's1',
        deviceId: 'mic-0',
        format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }
      }
    })
    await flush()
    expect(devices.requests).toEqual([{ audio: { deviceId: { exact: 'mic-0' }, channelCount: 1 } }])
  })

  it('stops tracks on stop and reports stopped', async () => {
    const { send, devices, published } = setup()
    send({
      type: 'camera.start',
      request: { generation: gen('s1'), leaseId: 's1', deviceId: 'cam-0' }
    })
    await flush()
    send({ type: 'camera.stop', generation: gen('s1') })
    await flush()
    expect(devices.tracks[0].stopped).toBe(true)
    expect(devices.tracks[0].listenerCount).toBe(0)
    expect(published).toContainEqual({
      type: 'camera.state',
      generation: gen('s1'),
      state: 'stopped'
    })
  })

  it('ignores a stop for an older stream so it cannot close the replacement', async () => {
    const { send, devices } = setup()
    send({
      type: 'camera.start',
      request: { generation: gen('old'), leaseId: 'old', deviceId: 'cam-0' }
    })
    send({
      type: 'camera.start',
      request: { generation: gen('new'), leaseId: 'new', deviceId: 'cam-0' }
    })
    await flush()
    expect(devices.tracks[0].stopped).toBe(true)
    send({ type: 'camera.stop', generation: gen('old') })
    await flush()
    expect(devices.tracks[1].stopped).toBe(false)
  })

  it('runs commands for one sensor strictly in order, even while an open is pending', async () => {
    const { send, devices, published } = setup()
    let release: () => void = () => undefined
    devices.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    send({
      type: 'camera.start',
      request: { generation: gen('s1'), leaseId: 's1', deviceId: 'cam-0' }
    })
    send({ type: 'camera.stop', generation: gen('s1') })
    await flush()
    expect(published.filter((event) => event.type === 'camera.state')).toHaveLength(0)
    release()
    await flush()
    expect(devices.tracks[0].stopped).toBe(true)
    expect(
      published.filter((event) => event.type === 'camera.state').map((event) => event.state)
    ).toEqual(['started', 'stopped'])
  })

  it('does not block the microphone while the camera is opening', async () => {
    const { send, devices, published } = setup()
    devices.hold = new Promise<void>(() => undefined)
    send({
      type: 'camera.start',
      request: { generation: gen('c'), leaseId: 'c', deviceId: 'cam-0' }
    })
    devices.hold = null
    const commandId = send({
      type: 'audio.capture.start',
      request: {
        generation: gen('m'),
        leaseId: 'm',
        deviceId: 'mic-0',
        format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }
      }
    })
    await flush()
    expect(resultOf(published, commandId)).toMatchObject({ result: { ok: true } })
  })

  it.each([
    ['NotAllowedError', 'permission_denied'],
    ['NotFoundError', 'device_unavailable'],
    ['OverconstrainedError', 'device_unavailable'],
    ['NotReadableError', 'device_unavailable'],
    ['SomethingElse', 'internal']
  ])('maps %s to %s', async (name, code) => {
    const { send, devices, published } = setup()
    devices.failWith = { name }
    const commandId = send({
      type: 'camera.start',
      request: { generation: gen('s1'), leaseId: 's1', deviceId: 'cam-0' }
    })
    await flush()
    expect(resultOf(published, commandId)).toMatchObject({ result: { ok: false, error: { code } } })
    expect(describeMediaError({ name }).code).toBe(code)
  })

  it('requires an explicit device', async () => {
    const { send, devices, published } = setup()
    const commandId = send({
      type: 'camera.start',
      request: { generation: gen('s1'), leaseId: 's1' }
    })
    await flush()
    expect(resultOf(published, commandId)).toMatchObject({
      result: { ok: false, error: { code: 'invalid_input' } }
    })
    expect(devices.requests).toHaveLength(0)
  })

  it('reports an unexpected track end as a failure and releases the stream', async () => {
    const { send, devices, published } = setup(async () => 'granted')
    send({
      type: 'camera.start',
      request: { generation: gen('s1'), leaseId: 's1', deviceId: 'cam-0' }
    })
    await flush()
    devices.tracks[0].end()
    await flush()
    expect(published.at(-1)).toMatchObject({
      type: 'camera.state',
      generation: gen('s1'),
      state: 'failed',
      error: { code: 'device_unavailable' }
    })
    expect(devices.tracks[0].stopped).toBe(true)
    // A stop after the failure is harmless.
    send({ type: 'camera.stop', generation: gen('s1') })
    await flush()
  })

  it('distinguishes a revoked permission from an unplugged device', async () => {
    const { send, devices, published } = setup(async () => 'denied')
    send({
      type: 'audio.capture.start',
      request: {
        generation: gen('s1'),
        leaseId: 's1',
        deviceId: 'mic-0',
        format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }
      }
    })
    await flush()
    devices.tracks[0].end()
    await flush()
    expect(published.at(-1)).toMatchObject({
      type: 'audio.capture.state',
      state: 'failed',
      error: { code: 'permission_denied' }
    })
  })

  it('publishes a device change only when the list actually changed', async () => {
    const { send, devices, published } = setup()
    send({ type: 'devices.list', kind: 'camera' })
    send({ type: 'devices.list', kind: 'microphone' })
    await flush()
    published.length = 0
    devices.plug()
    await flush()
    expect(published.filter((event) => event.type === 'media.devices_changed')).toHaveLength(0)
    devices.list.push({ kind: 'videoinput', deviceId: 'cam-2', label: 'New' })
    devices.plug()
    await flush()
    expect(published.filter((event) => event.type === 'media.devices_changed')).toMatchObject([
      {
        kind: 'camera',
        devices: [{ deviceId: 'cam-0' }, { deviceId: 'cam-1' }, { deviceId: 'cam-2' }]
      }
    ])
  })

  it('answers unsupported media commands instead of ignoring them', async () => {
    const { send, published } = setup()
    const commandId = send({ type: 'audio.buffer.clear', generation: gen('s1') })
    await flush()
    expect(resultOf(published, commandId)).toMatchObject({
      result: { ok: false, error: { code: 'unsupported' } }
    })
  })

  it('stops everything and detaches on dispose', async () => {
    const { controller, send, devices, unsubscribe } = setup()
    send({
      type: 'camera.start',
      request: { generation: gen('s1'), leaseId: 's1', deviceId: 'cam-0' }
    })
    await flush()
    controller.dispose()
    controller.dispose()
    expect(devices.tracks[0].stopped).toBe(true)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(devices.deviceChangeListeners).toBe(0)
  })

  it('releases a stream that finishes opening after dispose', async () => {
    const { controller, send, devices, published } = setup()
    let release: () => void = () => undefined
    devices.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const commandId = send({
      type: 'camera.start',
      request: { generation: gen('s1'), leaseId: 's1', deviceId: 'cam-0' }
    })
    await flush()
    controller.dispose()
    release()
    await flush()
    expect(devices.tracks[0].stopped).toBe(true)
    expect(resultOf(published, commandId)).toMatchObject({ result: { ok: false } })
  })

  describe('with PCM capture', () => {
    const micStart = (id: string) =>
      ({
        type: 'audio.capture.start',
        request: {
          generation: gen(id),
          leaseId: id,
          deviceId: 'mic-0',
          format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }
        }
      }) as const

    function withAudio(startResult: Result<void> = { ok: true, value: undefined }) {
      const audio = {
        start: vi.fn<AudioCapture['start']>(async () => startResult),
        stop: vi.fn<AudioCapture['stop']>(),
        clear: vi.fn<AudioCapture['clear']>(() => ({ ok: true, value: undefined })),
        extract: vi.fn<AudioCapture['extract']>(),
        dispose: vi.fn<AudioCapture['dispose']>()
      }
      const devices = new FakeDevices()
      const published: MediaEvent[] = []
      let deliver: (envelope: MediaCommandEnvelope) => void = () => undefined
      const api: MediaApi = {
        platform: 'test',
        subscribeCommands: (listener) => {
          deliver = listener
          return () => undefined
        },
        publish: (event) => {
          published.push(event)
        }
      }
      const controller = new MediaController(api, devices, undefined, audio)
      let id = 0
      return {
        audio,
        devices,
        published,
        controller,
        send: (command: MediaCommandEnvelope['command']) => {
          const commandId = `a-${++id}`
          deliver({ commandId, command })
          return commandId
        }
      }
    }

    it('starts PCM capture on the opened microphone stream and not on the camera', async () => {
      const { audio, send } = withAudio()
      send({
        type: 'camera.start',
        request: { generation: gen('c'), leaseId: 'c', deviceId: 'cam-0' }
      })
      await flush()
      expect(audio.start).not.toHaveBeenCalled()
      send(micStart('m'))
      await flush()
      expect(audio.start).toHaveBeenCalledOnce()
      expect(audio.start.mock.calls[0][1]).toMatchObject({
        generation: gen('m'),
        deviceId: 'mic-0'
      })
    })

    it('stops capture and the stream when capture cannot start', async () => {
      const { send, devices, published } = withAudio({
        ok: false,
        error: { code: 'unsupported', message: '샘플레이트' }
      })
      const commandId = send(micStart('m'))
      await flush()
      expect(resultOf(published, commandId)).toMatchObject({ result: { ok: false } })
      expect(devices.tracks[0].stopped).toBe(true)
    })

    it('stops capture before the stream when stopped, and when the track ends', async () => {
      const { send, audio, devices } = withAudio()
      send(micStart('m'))
      await flush()
      send({ type: 'audio.capture.stop', generation: gen('m') })
      await flush()
      expect(audio.stop).toHaveBeenCalledWith(gen('m'))
      expect(devices.tracks[0].stopped).toBe(true)

      const second = withAudio()
      second.send(micStart('n'))
      await flush()
      second.devices.tracks[0].end()
      await flush()
      expect(second.audio.stop).toHaveBeenCalledWith(gen('n'))
    })

    it('clears the history on request and reports a missing capture', async () => {
      const { send, audio, published } = withAudio()
      send(micStart('m'))
      await flush()
      const ok = send({ type: 'audio.buffer.clear', generation: gen('m') })
      await flush()
      expect(audio.clear).toHaveBeenCalledWith(gen('m'))
      expect(resultOf(published, ok)).toMatchObject({ result: { ok: true } })
      audio.clear.mockReturnValueOnce({ ok: false, error: { code: 'not_found', message: '없음' } })
      const missing = send({ type: 'audio.buffer.clear', generation: gen('x') })
      await flush()
      expect(resultOf(published, missing)).toMatchObject({ result: { ok: false } })
    })

    it('publishes an extracted utterance as an event and answers the command', async () => {
      const { send, audio, published } = withAudio()
      const utterance = {
        utteranceId: 'u1',
        generation: gen('m'),
        startSample: 0,
        sampleCount: 1,
        format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
        audio: new Uint8Array(2)
      } as const
      audio.extract.mockReturnValueOnce({ ok: true, value: utterance })
      const commandId = send({
        type: 'audio.utterance.extract',
        range: { utteranceId: 'u1', generation: gen('m'), startSample: 0, sampleCount: 1 }
      })
      await flush()
      expect(published).toContainEqual({ type: 'audio.utterance', utterance })
      expect(resultOf(published, commandId)).toMatchObject({ result: { ok: true } })

      audio.extract.mockReturnValueOnce({
        ok: false,
        error: { code: 'not_found', message: '없음' }
      })
      const failed = send({
        type: 'audio.utterance.extract',
        range: { utteranceId: 'u2', generation: gen('m'), startSample: 0, sampleCount: 1 }
      })
      await flush()
      expect(published.filter((event) => event.type === 'audio.utterance')).toHaveLength(1)
      expect(resultOf(published, failed)).toMatchObject({ result: { ok: false } })
    })

    it('disposes the audio side with the controller', async () => {
      const { controller, audio } = withAudio()
      controller.dispose()
      expect(audio.dispose).toHaveBeenCalledOnce()
    })
  })
})
