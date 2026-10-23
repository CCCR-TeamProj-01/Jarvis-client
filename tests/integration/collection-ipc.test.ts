import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { CollectionSettingsService } from '../../src/main/collection/collection-settings-service'
import type { CollectionSettingsApiPort } from '../../src/main/commands/collection-consent'
import { registerCollectionIpc } from '../../src/main/ipc/collection-ipc'
import { createUiBridge } from '../../src/preload/ui-bridge'
import type { CollectionEvent } from '../../src/shared/contracts/collection'
import { COLLECTION_CHANNELS } from '../../src/shared/ipc/channels'

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
  const api: CollectionSettingsApiPort = {
    read: vi.fn<CollectionSettingsApiPort['read']>(async () => ({
      ok: true,
      value: { activityEnabled: true, externalEnabled: true, revision: 3 }
    })),
    change: vi.fn<CollectionSettingsApiPort['change']>(async (change) => ({
      kind: 'done',
      value: {
        activityEnabled: change.activity ?? true,
        externalEnabled: change.external ?? true,
        revision: 4
      }
    }))
  }
  const service = new CollectionSettingsService({
    api,
    now: Date.now,
    onChanged: () => undefined
  })
  service.start('u1')
  const dispose = registerCollectionIpc({
    ipc,
    getContents: () => contents,
    entryUrl,
    collection: service
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
    api: bridge.collection,
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

describe('collection settings IPC and preload boundary', () => {
  it('round-trips actions and snapshots, and exposes only validated state events', async () => {
    const t = setup()
    const listener = vi.fn<(event: CollectionEvent) => void>()
    t.api.subscribe(listener)
    expect(await t.api.getSnapshot()).toMatchObject({ ok: true, value: { read: 'idle' } })
    expect(await t.api.command({ action: 'refresh' })).toMatchObject({
      ok: true,
      value: { read: 'ready', settings: { activity: true, external: true } }
    })
    expect(listener.mock.calls.at(-1)).toEqual([
      { type: 'collection.state_changed', snapshot: t.service.getSnapshot() }
    ])
    expect(Object.keys(t.api).sort()).toEqual(['command', 'getSnapshot', 'subscribe'])
    await t.service.stop()
    t.dispose()
  })

  it('carries a switch to the service with exactly the flag asked for', async () => {
    const t = setup()
    await t.api.command({ action: 'refresh' })
    expect(await t.api.command({ action: 'set', flag: 'external', on: false })).toMatchObject({
      ok: true,
      value: { outcome: { kind: 'saved', flag: 'external', on: false } }
    })
    expect(t.backend.change).toHaveBeenCalledWith({ external: false }, expect.anything())
    await t.service.stop()
    t.dispose()
  })

  it('rejects forged requests in preload before invoking Main, and again in Main', async () => {
    const t = setup()
    await t.api.command({ action: 'refresh' })
    t.invoke.mockClear()
    const handle = t.handlers.get(COLLECTION_CHANNELS.command)!
    for (const request of [
      null,
      {},
      { action: 'refresh', flag: 'activity' },
      { action: 'set', flag: 'activity' },
      { action: 'set', on: false },
      { action: 'set', flag: 'timezone', on: false },
      { action: 'set', flag: 'activity', on: 'false' },
      { action: 'set', flag: 'activity', on: false, revision: 9 },
      { action: 'patch', body: { daily_briefing_enabled: true } },
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
    expect(await t.handlers.get(COLLECTION_CHANNELS.snapshot)!(t.event, 'extra')).toMatchObject({
      ok: false
    })
    expect(t.backend.change).not.toHaveBeenCalled()
    await t.service.stop()
    t.dispose()
  })

  it('refuses foreign windows, subframes, missing frames and other documents on both channels', async () => {
    const t = setup()
    await t.api.command({ action: 'refresh' })
    for (const channel of [COLLECTION_CHANNELS.command, COLLECTION_CHANNELS.snapshot]) {
      const handle = t.handlers.get(channel)!
      const args =
        channel === COLLECTION_CHANNELS.command
          ? [{ action: 'set', flag: 'activity', on: false }]
          : []
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
    // Nobody but the main window could change what is collected.
    expect(t.backend.change).not.toHaveBeenCalled()
    expect(t.service.getSnapshot().stopped).toEqual({ activity: false, external: false })
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
    t.invoke.mockResolvedValueOnce({ ok: true, value: { settings: 'maybe' } })
    expect(await t.api.getSnapshot()).toMatchObject({ ok: false })
    await t.service.stop()
    t.dispose()
  })

  it('discards invalid events, unsubscribes once, and stops pushing to a different document', async () => {
    const t = setup()
    const listener = vi.fn<(event: CollectionEvent) => void>()
    const unsubscribe = t.api.subscribe(listener)
    const receive = [...t.listeners.get(COLLECTION_CHANNELS.event)!][0]!
    receive({}, { type: 'collection.state_changed', snapshot: { secret: 'secret' } })
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
    expect(t.listeners.get(COLLECTION_CHANNELS.event)?.size).toBe(0)
    await t.service.stop()
    t.dispose()
  })

  it('removes its handlers when disposed', async () => {
    const t = setup()
    expect([...t.handlers.keys()].sort()).toEqual([
      COLLECTION_CHANNELS.command,
      COLLECTION_CHANNELS.snapshot
    ])
    t.dispose()
    t.dispose()
    expect(t.handlers.size).toBe(0)
    await t.service.stop()
  })
})
