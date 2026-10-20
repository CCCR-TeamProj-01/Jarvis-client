import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainEvent, WebContents } from 'electron'
import { registerMediaIpc } from '../../src/main/ipc/media-ipc'
import { MediaBridge, MediaSensorHardware } from '../../src/main/sensors/media-bridge'
import { fakeMediaPermissions } from '../../src/main/sensors/media-permissions'
import { createSensorGate } from '../../src/main/sensors/sensor-gate'
import { SensorManager } from '../../src/main/sensors/sensor-manager'
import { createMediaBridge } from '../../src/preload/media-bridge'
import { MediaController } from '../../src/renderer/media/media-controller'
import type { AuthSnapshot } from '../../src/shared/contracts/auth'
import type { SensorEvent } from '../../src/shared/contracts/sensors'
import { MEDIA_CHANNELS } from '../../src/shared/ipc/channels'
import { FakeDevices } from '../fixtures/media-devices'

const entryUrl = 'file:///jarvis/media/index.html'
const generation = { sessionId: 'feature', revision: 1 }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Real Main-side bridge, IPC handler, SensorManager and Media Renderer controller, joined by an
 * in-memory stand-in for Electron's IPC. Only the browser devices and Electron itself are fake.
 */
function setup(options: { signedIn?: boolean; paused?: boolean } = {}) {
  const devices = new FakeDevices()
  const commandListeners = new Set<(event: unknown, value: unknown) => void>()
  const mediaContents = {
    mainFrame: { url: entryUrl },
    isDestroyed: () => false
  } as unknown as WebContents
  // Main -> renderer: structured clone, like a real IPC message.
  let reachable = true
  const bridge = new MediaBridge({
    send: async (envelope) => {
      if (!reachable) return false
      queueMicrotask(() => {
        for (const listener of [...commandListeners]) listener({}, structuredClone(envelope))
      })
      return true
    },
    createId: (() => {
      let id = 0
      return () => `cmd-${++id}`
    })(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
    timeoutMs: { list: 200, open: 200, close: 200 }
  })
  const handlers = new Set<(event: IpcMainEvent, ...args: unknown[]) => void>()
  const ipc = {
    on: vi.fn<Pick<IpcMain, 'on'>['on']>((_channel, handler) => {
      handlers.add(handler as never)
      return undefined as never
    }),
    removeListener: vi.fn<Pick<IpcMain, 'removeListener'>['removeListener']>(
      (_channel, handler) => {
        handlers.delete(handler as never)
        return undefined as never
      }
    )
  }
  const disposeIpc = registerMediaIpc({
    ipc,
    getContents: () => mediaContents,
    entryUrl,
    bridge
  })
  // Renderer -> Main.
  const rendererApi = createMediaBridge(
    {
      on: (_channel, listener) => {
        commandListeners.add(listener)
      },
      removeListener: (_channel, listener) => {
        commandListeners.delete(listener)
      },
      send: (channel, ...args) => {
        expect(channel).toBe(MEDIA_CHANNELS.event)
        const event = {
          sender: mediaContents,
          senderFrame: mediaContents.mainFrame
        } as IpcMainEvent
        for (const handler of [...handlers]) handler(event, ...structuredClone(args))
      }
    },
    'test'
  )
  const controller = new MediaController(rendererApi, devices, async () => 'granted')
  const hardware = new MediaSensorHardware(bridge, { list: 200, open: 200, close: 200 })

  let auth: AuthSnapshot =
    options.signedIn === false
      ? { phase: 'signed_out', generation: { sessionId: 'a', revision: 1 }, user: null }
      : {
          phase: 'signed_in',
          generation: { sessionId: 'a', revision: 1 },
          user: { userId: 'u1', loginId: 'tester' }
        }
  let paused = options.paused ?? false
  let id = 0
  const sensors = new SensorManager({
    hardware,
    permissions: fakeMediaPermissions,
    gate: createSensorGate({ getSnapshot: () => auth }, () => paused),
    clock: { now: () => performance.now() },
    createId: () => `id-${++id}`
  })
  const events: SensorEvent[] = []
  sensors.subscribe((event) => events.push(event))
  return {
    sensors,
    devices,
    events,
    bridge,
    hardware,
    controller,
    ipc,
    handlers,
    mediaContents,
    disposeIpc,
    setAuth: (next: AuthSnapshot) => {
      auth = next
    },
    setPaused: (next: boolean) => {
      paused = next
    },
    setReachable: (next: boolean) => {
      reachable = next
    }
  }
}

describe('sensor pipeline over the media IPC', () => {
  it('acquires camera and microphone end to end and releases them', async () => {
    const { sensors, devices } = setup()
    const camera = await sensors.acquire({ kind: 'camera', owner: 'gesture_control', generation })
    const microphone = await sensors.acquire({
      kind: 'microphone',
      owner: 'voice_wake',
      generation
    })
    expect(camera).toMatchObject({ ok: true, value: { deviceId: 'cam-0' } })
    expect(microphone).toMatchObject({ ok: true, value: { deviceId: 'mic-0' } })
    expect(devices.requests).toEqual([
      { video: { deviceId: { exact: 'cam-0' } } },
      { audio: { deviceId: { exact: 'mic-0' }, channelCount: 1 } }
    ])
    expect(devices.tracks.every((track) => !track.stopped)).toBe(true)
    if (!camera.ok || !microphone.ok) return
    await sensors.release(camera.value.leaseId)
    await sensors.release(microphone.value.leaseId)
    expect(devices.tracks.every((track) => track.stopped)).toBe(true)
    expect(sensors.getSnapshot('camera')).toMatchObject({ state: 'idle', leaseCount: 0 })
  })

  it('shares one device between two consumers and closes it after the last', async () => {
    const { sensors, devices } = setup()
    const first = await sensors.acquire({ kind: 'microphone', owner: 'voice_wake', generation })
    const second = await sensors.acquire({
      kind: 'microphone',
      owner: 'speech_session',
      generation
    })
    expect(devices.requests).toHaveLength(1)
    if (!first.ok || !second.ok) throw new Error('acquire failed')
    await sensors.release(first.value.leaseId)
    expect(devices.tracks[0].stopped).toBe(false)
    await sensors.release(second.value.leaseId)
    expect(devices.tracks[0].stopped).toBe(true)
  })

  it('does not start any sensor before sign-in or while paused', async () => {
    const signedOut = setup({ signedIn: false })
    expect(
      await signedOut.sensors.acquire({ kind: 'camera', owner: 'gesture_call', generation })
    ).toMatchObject({ ok: false, error: { code: 'authentication_required' } })
    expect(signedOut.devices.requests).toHaveLength(0)
    expect(signedOut.devices.list.length).toBeGreaterThan(0)

    const paused = setup({ paused: true })
    expect(
      await paused.sensors.acquire({ kind: 'microphone', owner: 'voice_wake', generation })
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(paused.devices.requests).toHaveLength(0)
  })

  it('releases the real streams when the manager revokes everything', async () => {
    const { sensors, devices, events } = setup()
    await sensors.acquire({ kind: 'camera', owner: 'gesture_control', generation })
    await sensors.acquire({ kind: 'microphone', owner: 'voice_wake', generation })
    await sensors.revokeAll({ code: 'authentication_required', message: '로그아웃' })
    await flush()
    expect(devices.tracks.every((track) => track.stopped)).toBe(true)
    expect(events.filter((event) => event.type === 'sensor.lease_revoked')).toHaveLength(2)
  })

  it('revokes the lease when the device is unplugged', async () => {
    const { sensors, devices, events } = setup()
    const lease = await sensors.acquire({ kind: 'camera', owner: 'gesture_control', generation })
    expect(lease.ok).toBe(true)
    devices.tracks[0].end()
    await flush()
    await flush()
    expect(events.find((event) => event.type === 'sensor.lease_revoked')).toMatchObject({
      error: { code: 'device_unavailable' }
    })
    expect(sensors.getSnapshot('camera')).toMatchObject({ state: 'unavailable', leaseCount: 0 })
  })

  it('treats a vanished active device in a device-change notification as removal', async () => {
    const { sensors, devices, events } = setup()
    await sensors.acquire({
      kind: 'camera',
      owner: 'gesture_control',
      generation,
      deviceId: 'cam-1'
    })
    devices.list = devices.list.filter((device) => device.deviceId !== 'cam-1')
    devices.plug()
    await flush()
    await flush()
    expect(events.some((event) => event.type === 'sensor.lease_revoked')).toBe(true)
  })

  it('reports an open failure from the browser without leaving anything open', async () => {
    const { sensors, devices } = setup()
    devices.failWith = { name: 'NotReadableError' }
    expect(
      await sensors.acquire({ kind: 'camera', owner: 'gesture_control', generation })
    ).toMatchObject({ ok: false, error: { code: 'device_unavailable' } })
    expect(sensors.getSnapshot('camera')).toMatchObject({ state: 'unavailable', leaseCount: 0 })
  })

  it('fails instead of hanging when the media window cannot be reached', async () => {
    const { sensors, setReachable } = setup()
    setReachable(false)
    expect(
      await sensors.acquire({ kind: 'camera', owner: 'gesture_control', generation })
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(sensors.getSnapshot('camera').state).toBe('error')
  })

  it('times out a renderer that never answers', async () => {
    const { sensors, devices } = setup()
    devices.hold = new Promise<void>(() => undefined)
    const result = await sensors.acquire({ kind: 'camera', owner: 'gesture_control', generation })
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('revokes leases when the renderer process is lost', async () => {
    const { sensors, hardware, bridge, events } = setup()
    await sensors.acquire({ kind: 'camera', owner: 'gesture_control', generation })
    bridge.rendererLost()
    hardware.rendererLost()
    await flush()
    expect(events.find((event) => event.type === 'sensor.lease_revoked')).toMatchObject({
      error: { code: 'device_unavailable' }
    })
  })
})

describe('media IPC trust', () => {
  const event = (
    overrides: Partial<{ sender: unknown; senderFrame: unknown }>,
    contents: WebContents
  ) =>
    ({
      sender: contents,
      senderFrame: contents.mainFrame,
      ...overrides
    }) as unknown as IpcMainEvent

  it('accepts events only from the media window top frame at its entry URL', async () => {
    const { handlers, bridge, mediaContents } = setup()
    const handleEvent = vi.spyOn(bridge, 'handleEvent')
    const [handler] = [...handlers]
    const valid = {
      type: 'camera.state',
      generation: { sessionId: 's', revision: 0 },
      state: 'stopped'
    }
    handler(event({}, mediaContents), valid)
    expect(handleEvent).toHaveBeenCalledTimes(1)

    handler(event({ sender: {} }, mediaContents), valid)
    handler(event({ senderFrame: { url: entryUrl } }, mediaContents), valid)
    handler(
      event(
        { senderFrame: { ...mediaContents.mainFrame, url: 'https://evil.test/' } },
        mediaContents
      ),
      valid
    )
    handler(event({}, mediaContents), valid, 'extra')
    handler(event({}, mediaContents), { type: 'camera.state', state: 'failed' })
    handler(event({}, mediaContents), { type: 'unknown' })
    expect(handleEvent).toHaveBeenCalledTimes(1)
  })

  it('stops listening on dispose', () => {
    const { handlers, disposeIpc, ipc } = setup()
    disposeIpc()
    disposeIpc()
    expect(handlers.size).toBe(0)
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
  })
})
