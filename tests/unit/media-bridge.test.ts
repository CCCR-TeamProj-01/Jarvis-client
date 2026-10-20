import { describe, expect, it, vi } from 'vitest'
import { MediaBridge, MediaSensorHardware } from '../../src/main/sensors/media-bridge'
import type { SensorHardwareEvent } from '../../src/main/sensors/hardware'
import { createMediaBridge } from '../../src/preload/media-bridge'
import type { MediaCommandEnvelope, MediaEvent } from '../../src/shared/ipc/media-api'
import { MEDIA_CHANNELS } from '../../src/shared/ipc/channels'

function setup(deliver = true) {
  const sent: MediaCommandEnvelope[] = []
  const timers: { callback: () => void; cancelled: boolean }[] = []
  let id = 0
  const bridge = new MediaBridge({
    send: async (envelope) => {
      sent.push(envelope)
      return deliver
    },
    createId: () => `c-${++id}`,
    schedule: (callback) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
  return {
    bridge,
    sent,
    expire: () => timers.filter((timer) => !timer.cancelled).forEach((timer) => timer.callback()),
    activeTimers: () => timers.filter((timer) => !timer.cancelled).length
  }
}
const ok = (commandId: string): MediaEvent => ({
  type: 'media.command_result',
  commandId,
  result: { ok: true, value: null }
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('MediaBridge', () => {
  it('resolves a command with the event that carries its id and stops its timer', async () => {
    const { bridge, sent, activeTimers } = setup()
    const pending = bridge.command(
      { type: 'camera.stop', generation: { sessionId: 's', revision: 0 } },
      100
    )
    await tick()
    expect(sent).toHaveLength(1)
    expect(activeTimers()).toBe(1)
    bridge.handleEvent(ok(sent[0].commandId))
    expect(await pending).toEqual({ ok: true, value: undefined })
    expect(activeTimers()).toBe(0)
  })

  it('ignores answers for unknown or already answered commands', async () => {
    const { bridge, sent } = setup()
    bridge.handleEvent(ok('never-sent'))
    const pending = bridge.command(
      { type: 'camera.stop', generation: { sessionId: 's', revision: 0 } },
      100
    )
    await tick()
    bridge.handleEvent(ok(sent[0].commandId))
    bridge.handleEvent({
      type: 'media.command_result',
      commandId: sent[0].commandId,
      result: { ok: false, error: { code: 'internal', message: '늦은 응답' } }
    })
    expect(await pending).toEqual({ ok: true, value: undefined })
  })

  it('surfaces a failed result', async () => {
    const { bridge, sent } = setup()
    const pending = bridge.command(
      { type: 'camera.stop', generation: { sessionId: 's', revision: 0 } },
      100
    )
    await tick()
    bridge.handleEvent({
      type: 'media.command_result',
      commandId: sent[0].commandId,
      result: { ok: false, error: { code: 'permission_denied', message: '거부' } }
    })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  })

  it('times out when no answer arrives', async () => {
    const { bridge, expire } = setup()
    const pending = bridge.command(
      { type: 'camera.stop', generation: { sessionId: 's', revision: 0 } },
      100
    )
    await tick()
    expire()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('fails immediately when the window cannot be reached', async () => {
    const { bridge, activeTimers } = setup(false)
    expect(
      await bridge.command(
        { type: 'camera.stop', generation: { sessionId: 's', revision: 0 } },
        100
      )
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(activeTimers()).toBe(0)
  })

  it('honours an abort signal and does not send an already aborted request', async () => {
    const { bridge, sent } = setup()
    const controller = new AbortController()
    const pending = bridge.listDevices('camera', { signal: controller.signal })
    await tick()
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const aborted = new AbortController()
    aborted.abort()
    expect(await bridge.listDevices('camera', { signal: aborted.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(sent).toHaveLength(1)
  })

  it('returns the device list from the matching event', async () => {
    const { bridge, sent } = setup()
    const pending = bridge.listDevices('microphone')
    await tick()
    bridge.handleEvent({
      type: 'media.devices',
      commandId: sent[0].commandId,
      result: { ok: true, value: [{ kind: 'microphone', deviceId: 'mic-0' }] }
    })
    expect(await pending).toEqual({ ok: true, value: [{ kind: 'microphone', deviceId: 'mic-0' }] })
  })

  it('fails pending commands when the renderer is lost or the bridge is disposed', async () => {
    const lost = setup()
    const pending = lost.bridge.listDevices('camera')
    await tick()
    lost.bridge.rendererLost()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })

    const disposed = setup()
    const other = disposed.bridge.listDevices('camera')
    await tick()
    disposed.bridge.dispose()
    expect(await other).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(await disposed.bridge.listDevices('camera')).toMatchObject({ ok: false })
  })

  it('forwards lifecycle events to subscribers and survives a throwing observer', () => {
    const { bridge } = setup()
    const seen = vi.fn<(event: MediaEvent) => void>()
    bridge.subscribe(() => {
      throw new Error('observer bug')
    })
    bridge.subscribe(seen)
    const event: MediaEvent = {
      type: 'media.devices_changed',
      kind: 'camera',
      devices: []
    }
    bridge.handleEvent(event)
    expect(seen).toHaveBeenCalledWith(event)
  })
})

describe('MediaSensorHardware', () => {
  it('maps a failed stream state to stream_ended with the stream id', () => {
    const { bridge } = setup()
    const hardware = new MediaSensorHardware(bridge)
    const seen = vi.fn<(event: SensorHardwareEvent) => void>()
    hardware.subscribe(seen)
    bridge.handleEvent({
      type: 'audio.capture.state',
      generation: { sessionId: 'stream-9', revision: 0 },
      state: 'failed',
      error: { code: 'device_unavailable', message: '분리' }
    })
    expect(seen).toHaveBeenCalledWith({
      type: 'stream_ended',
      kind: 'microphone',
      streamId: 'stream-9',
      error: { code: 'device_unavailable', message: '분리' }
    })
    // Normal started/stopped transitions are not endings.
    bridge.handleEvent({
      type: 'camera.state',
      generation: { sessionId: 's', revision: 0 },
      state: 'stopped'
    })
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('reports exactly the open streams as ended when the renderer is lost', async () => {
    const { bridge, sent } = setup()
    const hardware = new MediaSensorHardware(bridge)
    const seen = vi.fn<(event: SensorHardwareEvent) => void>()
    hardware.subscribe(seen)
    const opening = hardware.open('camera', { streamId: 'cam-stream', deviceId: 'cam-0' })
    await tick()
    bridge.handleEvent(ok(sent[0].commandId))
    await opening
    hardware.rendererLost()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stream_ended', streamId: 'cam-stream', kind: 'camera' })
    )
    hardware.rendererLost()
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('opens a stream with an explicit device and the stream id as its identity', async () => {
    const { bridge, sent } = setup()
    const hardware = new MediaSensorHardware(bridge)
    void hardware.open('microphone', { streamId: 'mic-stream', deviceId: 'mic-0' })
    await tick()
    expect(sent[0].command).toMatchObject({
      type: 'audio.capture.start',
      request: {
        generation: { sessionId: 'mic-stream' },
        leaseId: 'mic-stream',
        deviceId: 'mic-0'
      }
    })
  })
})

describe('preload media bridge', () => {
  function transport() {
    const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>()
    const send = vi.fn<(channel: string, ...args: unknown[]) => void>()
    return {
      send,
      emit: (channel: string, value: unknown) =>
        listeners.get(channel)?.forEach((listener) => listener({ native: true }, value)),
      count: (channel: string) => listeners.get(channel)?.size ?? 0,
      ipc: {
        on: (channel: string, listener: (event: unknown, value: unknown) => void) => {
          if (!listeners.has(channel)) listeners.set(channel, new Set())
          listeners.get(channel)!.add(listener)
        },
        removeListener: (channel: string, listener: (event: unknown, value: unknown) => void) => {
          listeners.get(channel)?.delete(listener)
        },
        send
      }
    }
  }

  it('passes only valid commands to the renderer and never an Electron event object', () => {
    const t = transport()
    const api = createMediaBridge(t.ipc, 'darwin')
    const received = vi.fn<(command: MediaCommandEnvelope) => void>()
    api.subscribeCommands(received)
    const valid = {
      commandId: 'c-1',
      command: { type: 'camera.stop', generation: { sessionId: 's', revision: 0 } }
    }
    t.emit(MEDIA_CHANNELS.command, valid)
    t.emit(MEDIA_CHANNELS.command, { commandId: 'c-2', command: { type: 'rm -rf' } })
    t.emit(MEDIA_CHANNELS.command, 'garbage')
    expect(received.mock.calls).toEqual([[valid]])
  })

  it('publishes only valid events and unsubscribes only its own listener', () => {
    const t = transport()
    const api = createMediaBridge(t.ipc, 'darwin')
    api.publish({
      type: 'camera.state',
      generation: { sessionId: 's', revision: 0 },
      state: 'stopped'
    })
    api.publish({ type: 'camera.state', state: 'failed' } as never)
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.send.mock.calls[0][0]).toBe(MEDIA_CHANNELS.event)

    const unsubscribe = api.subscribeCommands(() => undefined)
    const other = api.subscribeCommands(() => undefined)
    expect(t.count(MEDIA_CHANNELS.command)).toBe(2)
    unsubscribe()
    unsubscribe()
    expect(t.count(MEDIA_CHANNELS.command)).toBe(1)
    other()
    expect(Object.keys(api).sort()).toEqual(['platform', 'publish', 'subscribeCommands'])
  })
})
