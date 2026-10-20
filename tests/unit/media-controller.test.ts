import { describe, expect, it, vi } from 'vitest'
import { describeMediaError, MediaController } from '../../src/renderer/media/media-controller'
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
})
