import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { DeviceManagementApiPort } from '../../src/main/devices/device-management-api'
import { DeviceManagementService } from '../../src/main/devices/device-management-service'
import { registerDevicesIpc } from '../../src/main/ipc/devices-ipc'
import { createUiBridge } from '../../src/preload/ui-bridge'
import type { DeviceManagementEvent } from '../../src/shared/contracts/devices'
import { DEVICE_CHANNELS } from '../../src/shared/ipc/channels'

function setup() {
  const entryUrl = 'file:///jarvis/ui/index.html'
  type Listener = (event: unknown, value: unknown) => void
  const listeners = new Map<string, Set<Listener>>()
  const send = vi.fn<(channel: string, value: unknown) => void>((channel, value) => {
    for (const listener of listeners.get(channel) ?? [])
      listener({ native: true }, structuredClone(value))
  })
  const contents = {
    mainFrame: { url: entryUrl },
    isDestroyed: () => false,
    send
  } as unknown as WebContents
  const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc = {
    handle: vi.fn<IpcMain['handle']>((channel, handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn<IpcMain['removeHandler']>((channel) => {
      handlers.delete(channel)
    })
  }
  const api: DeviceManagementApiPort = {
    devices: async () => ({
      ok: true,
      value: [
        {
          id: '12',
          name: '내 맥북',
          platform: 'macos',
          clientVersion: '0.1.0',
          lastSeenAtMs: Date.now(),
          current: true
        }
      ]
    }),
    rename: async (_id, name) => ({ kind: 'done', value: { name } }),
    signOutDevice: vi.fn<DeviceManagementApiPort['signOutDevice']>(async () => ({
      kind: 'done',
      value: undefined
    })),
    signOutAll: vi.fn<DeviceManagementApiPort['signOutAll']>(async () => ({
      kind: 'done',
      value: undefined
    })),
    apps: async () => ({ ok: true, value: { items: [], next: null, more: false } }),
    setAppAllowed: async (_id, allowed) => ({ kind: 'done', value: { allowed } })
  }
  const service = new DeviceManagementService({
    api,
    now: Date.now,
    clock: { serverTimeAt: (local) => local },
    endLocalSession: async () => undefined
  })
  service.start('u1')
  const dispose = registerDevicesIpc({
    ipc,
    getContents: () => contents,
    entryUrl,
    devices: service
  })
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(
    async (channel, ...args) => structuredClone(await handlers.get(channel)!(event, ...args))
  )
  const bridge = createUiBridge(
    {
      invoke,
      on: (channel, listener) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(listener)
      },
      removeListener: (channel, listener) => {
        listeners.get(channel)?.delete(listener)
      }
    },
    'darwin'
  )
  return {
    api: bridge.devices,
    bridge,
    service,
    handlers,
    ipc,
    contents,
    send,
    event,
    entryUrl,
    dispose,
    invoke,
    listeners,
    backend: api
  }
}

describe('devices IPC and preload boundary', () => {
  it('round-trips actions and snapshots, and exposes only validated state events', async () => {
    const t = setup()
    const listener = vi.fn<(event: DeviceManagementEvent) => void>()
    t.api.subscribe(listener)
    expect(await t.api.getSnapshot()).toMatchObject({
      ok: true,
      value: { devices: { read: 'idle' } }
    })
    expect(await t.api.command({ action: 'refresh' })).toMatchObject({
      ok: true,
      value: { devices: { read: 'ready', items: [{ id: '12', current: true }] } }
    })
    expect(listener.mock.calls.at(-1)).toEqual([
      { type: 'devices.state_changed', snapshot: t.service.getSnapshot() }
    ])
    expect(Object.keys(t.api).sort()).toEqual(['command', 'getSnapshot', 'subscribe'])
    await t.service.stop()
    t.dispose()
  })

  it('carries each kind of action to the service with exactly the fields it needs', async () => {
    const t = setup()
    await t.api.command({ action: 'refresh' })
    expect(
      await t.api.command({ action: 'rename_device', deviceId: '12', name: '  새 이름 ' })
    ).toMatchObject({ ok: true, value: { outcome: { kind: 'renamed' } } })
    expect(
      await t.api.command({ action: 'set_app_allowed', appId: '1', allowed: true })
    ).toMatchObject({ ok: true })
    expect(await t.api.command({ action: 'sign_out_all' })).toMatchObject({ ok: true })
    expect(t.backend.signOutAll).toHaveBeenCalledTimes(1)
    await t.service.stop()
    t.dispose()
  })

  it('rejects forged requests in preload before invoking Main, and again in Main', async () => {
    const t = setup()
    const handle = t.handlers.get(DEVICE_CHANNELS.command)!
    for (const request of [
      null,
      {},
      { action: 'delete_everything' },
      { action: 'refresh', deviceId: '12' },
      { action: 'sign_out_all', confirm: true },
      { action: 'rename_device', deviceId: '12' },
      { action: 'rename_device', deviceId: '12', name: '   ' },
      { action: 'rename_device', deviceId: '12', name: 'x'.repeat(101) },
      { action: 'rename_device', deviceId: '12', name: 5 },
      { action: 'rename_device', deviceId: '../auth', name: 'x' },
      { action: 'sign_out_device', deviceId: '12/sessions?x=1' },
      { action: 'sign_out_device', deviceId: 12 },
      { action: 'sign_out_device', deviceId: '' },
      { action: 'set_app_allowed', appId: '1', allowed: 'yes' },
      { action: 'set_app_allowed', appId: '1' },
      { action: 1 }
    ]) {
      expect(await t.api.command(request as never)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
      expect(t.invoke).not.toHaveBeenCalled()
      expect(await handle(t.event, request)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    }
    for (const args of [[], [{ action: 'refresh' }, 'extra']])
      expect(await handle(t.event, ...args)).toMatchObject({ ok: false })
    expect(await t.handlers.get(DEVICE_CHANNELS.snapshot)!(t.event, 'extra')).toMatchObject({
      ok: false
    })
    expect(t.backend.signOutAll).not.toHaveBeenCalled()
    expect(t.service.getSnapshot().devices.read).toBe('idle')
    await t.service.stop()
    t.dispose()
  })

  it('refuses foreign windows, subframes, missing frames and other documents on both channels', async () => {
    const t = setup()
    for (const channel of [DEVICE_CHANNELS.command, DEVICE_CHANNELS.snapshot]) {
      const handle = t.handlers.get(channel)!
      const args = channel === DEVICE_CHANNELS.command ? [{ action: 'sign_out_all' }] : []
      for (const event of [
        { ...t.event, sender: {} },
        { ...t.event, senderFrame: { url: t.entryUrl } },
        { ...t.event, senderFrame: null }
      ])
        expect(await handle(event as IpcMainInvokeEvent, ...args)).toMatchObject({
          ok: false,
          error: { code: 'permission_denied' }
        })
      Object.assign(t.contents.mainFrame, { url: 'file:///foreign.html' })
      expect(await handle(t.event, ...args)).toMatchObject({
        ok: false,
        error: { code: 'permission_denied' }
      })
      Object.assign(t.contents.mainFrame, { url: t.entryUrl })
    }
    // Nobody but the main window could end the sessions.
    expect(t.backend.signOutAll).not.toHaveBeenCalled()
    await t.service.stop()
    t.dispose()
  })

  it('turns exceptions and invalid answers into fixed errors without exposing internals', async () => {
    const t = setup()
    vi.spyOn(t.service, 'command').mockRejectedValueOnce(new Error('secret'))
    const failed = await t.api.command({ action: 'refresh' })
    expect(failed).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(failed)).not.toContain('secret')
    vi.spyOn(t.service, 'command').mockResolvedValueOnce({
      ok: true,
      value: { secret: 1 }
    } as never)
    expect(await t.api.command({ action: 'refresh' })).toMatchObject({ ok: false })
    t.invoke.mockResolvedValueOnce({ ok: true, value: { devices: 'maybe' } })
    expect(await t.api.getSnapshot()).toMatchObject({ ok: false })
    await t.service.stop()
    t.dispose()
  })

  it('discards invalid events, unsubscribes once, and stops pushing to a different document', async () => {
    const t = setup()
    const listener = vi.fn<(event: DeviceManagementEvent) => void>()
    const unsubscribe = t.api.subscribe(listener)
    const receive = [...t.listeners.get(DEVICE_CHANNELS.event)!][0]!
    receive({}, { type: 'devices.state_changed', snapshot: { secret: 'secret' } })
    receive({}, { type: 'other' })
    expect(listener).not.toHaveBeenCalled()
    t.send.mockClear()
    Object.assign(t.contents.mainFrame, { url: 'file:///foreign.html' })
    await t.service.command({ action: 'refresh' })
    expect(t.send).not.toHaveBeenCalled()
    Object.assign(t.contents.mainFrame, { url: t.entryUrl })
    unsubscribe()
    unsubscribe()
    await t.service.command({ action: 'refresh' })
    expect(listener).not.toHaveBeenCalled()
    expect(t.listeners.get(DEVICE_CHANNELS.event)?.size).toBe(0)
    await t.service.stop()
    t.dispose()
  })

  it('removes its handlers when disposed', async () => {
    const t = setup()
    expect([...t.handlers.keys()].sort()).toEqual([
      DEVICE_CHANNELS.command,
      DEVICE_CHANNELS.snapshot
    ])
    t.dispose()
    t.dispose()
    expect(t.handlers.size).toBe(0)
    await t.service.stop()
  })
})
