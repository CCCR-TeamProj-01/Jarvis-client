import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { GoogleConnectionApiPort } from '../../src/main/google-connection/google-connection-api'
import { GoogleConnectionService } from '../../src/main/google-connection/google-connection-service'
import { registerGoogleIpc } from '../../src/main/ipc/google-ipc'
import { createUiBridge } from '../../src/preload/ui-bridge'
import type { GoogleConnectionEvent } from '../../src/shared/contracts/google-connection'
import { GOOGLE_CHANNELS } from '../../src/shared/ipc/channels'

function setup() {
  const entryUrl = 'file:///jarvis/ui/index.html'
  type Listener = (event: unknown, value: unknown) => void
  const listeners = new Map<string, Set<Listener>>()
  const contents = {
    mainFrame: { url: entryUrl },
    isDestroyed: () => false,
    send: vi.fn<(channel: string, value: unknown) => void>((channel, value) => {
      for (const listener of listeners.get(channel) ?? [])
        listener({ native: true }, structuredClone(value))
    })
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
  const opened: string[] = []
  const api: GoogleConnectionApiPort = {
    connection: async () => ({ ok: true, value: null }),
    authorize: async () => ({
      ok: true,
      value: {
        url: 'https://accounts.google.com/o/oauth2/v2/auth?s=1',
        expiresAtServerMs: Date.now() + 600_000
      }
    }),
    sync: async () => ({ kind: 'queued' }),
    disconnect: async () => ({ kind: 'done' })
  }
  const service = new GoogleConnectionService({
    api,
    now: Date.now,
    clock: { serverTimeAt: (local) => local },
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
      }),
    openConsent: async (url) => (opened.push(url), true),
    onCalendarChanged: () => undefined,
    pollMs: 50
  })
  service.start('u1')
  const dispose = registerGoogleIpc({ ipc, getContents: () => contents, entryUrl, google: service })
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
    api: bridge.google,
    service,
    handlers,
    ipc,
    contents,
    event,
    entryUrl,
    dispose,
    invoke,
    listeners,
    opened
  }
}

describe('Google connection IPC and preload boundary', () => {
  it('round-trips actions and snapshots, and exposes only validated state events', async () => {
    const t = setup()
    const listener = vi.fn<(event: GoogleConnectionEvent) => void>()
    t.api.subscribe(listener)
    expect(await t.api.getSnapshot()).toMatchObject({ ok: true, value: { read: 'idle' } })
    expect(await t.api.command({ action: 'refresh' })).toMatchObject({
      ok: true,
      value: { read: 'ready', connection: null }
    })
    expect(listener.mock.calls.at(-1)).toEqual([
      { type: 'google.state_changed', snapshot: t.service.getSnapshot() }
    ])
    expect(Object.keys(t.api).sort()).toEqual(['command', 'getSnapshot', 'subscribe'])
    await t.service.stop()
    t.dispose()
  })

  it('opens the consent page in the browser only through the service', async () => {
    const t = setup()
    expect(await t.api.command({ action: 'connect' })).toMatchObject({
      ok: true,
      value: { activity: 'authorizing' }
    })
    expect(t.opened).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?s=1'])
    await t.api.command({ action: 'cancel_connect' })
    await t.service.stop()
    t.dispose()
  })

  it('rejects forged requests in preload before invoking Main, and again in Main', async () => {
    const t = setup()
    const handle = t.handlers.get(GOOGLE_CHANNELS.command)!
    for (const request of [
      null,
      {},
      { action: 'delete_everything' },
      { action: 'sync', connectionId: '31' },
      { action: 'connect', url: 'https://evil.example/' },
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
    for (const args of [[], [{ action: 'sync' }, 'extra']])
      expect(await handle(t.event, ...args)).toMatchObject({ ok: false })
    expect(await t.handlers.get(GOOGLE_CHANNELS.snapshot)!(t.event, 'extra')).toMatchObject({
      ok: false
    })
    expect(t.service.getSnapshot().read).toBe('idle')
    await t.service.stop()
    t.dispose()
  })

  it('refuses foreign windows, subframes, missing frames and other documents on both channels', async () => {
    const t = setup()
    for (const channel of [GOOGLE_CHANNELS.command, GOOGLE_CHANNELS.snapshot]) {
      const handle = t.handlers.get(channel)!
      const args = channel === GOOGLE_CHANNELS.command ? [{ action: 'refresh' }] : []
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
    expect(t.opened).toEqual([])
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
    t.invoke.mockResolvedValueOnce({ ok: true, value: { read: 'maybe' } })
    expect(await t.api.getSnapshot()).toMatchObject({ ok: false })
    await t.service.stop()
    t.dispose()
  })

  it('discards invalid events, unsubscribes once, and stops pushing to a different document', async () => {
    const t = setup()
    const listener = vi.fn<(event: GoogleConnectionEvent) => void>()
    const unsubscribe = t.api.subscribe(listener)
    const receive = [...t.listeners.get(GOOGLE_CHANNELS.event)!][0]!
    receive({}, { type: 'google.state_changed', snapshot: { secret: 'secret' } })
    expect(listener).not.toHaveBeenCalled()
    Object.assign(t.contents.mainFrame, { url: 'file:///foreign.html' })
    await t.service.command('refresh')
    expect(listener).not.toHaveBeenCalled()
    Object.assign(t.contents.mainFrame, { url: t.entryUrl })
    unsubscribe()
    unsubscribe()
    receive({}, { type: 'google.state_changed', snapshot: t.service.getSnapshot() })
    await t.service.command('refresh')
    expect(listener).not.toHaveBeenCalled()
    await t.service.stop()
    t.dispose()
    t.dispose()
    expect(t.handlers.size).toBe(0)
  })
})
