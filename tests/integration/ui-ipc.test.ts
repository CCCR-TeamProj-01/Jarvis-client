import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { InteractionManager } from '../../src/main/interaction/interaction-manager'
import { registerUiIpc } from '../../src/main/ipc/ui-ipc'
import { createUiBridge } from '../../src/preload/ui-bridge'
import { UI_CHANNELS } from '../../src/shared/ipc/channels'
import type { UiEvent } from '../../src/shared/contracts/interaction'
import { authGeneration } from '../fixtures/contracts'

function setup() {
  const entryUrl = 'file:///jarvis/ui/index.html'
  const listeners = new Set<(event: unknown, value: unknown) => void>()
  const send = vi.fn<(channel: string, value: unknown) => void>((channel, value) => {
    if (channel === UI_CHANNELS.event)
      for (const listener of [...listeners]) listener({ native: true }, structuredClone(value))
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
  const manager = new InteractionManager({
    auth: { phase: 'signed_out', generation: authGeneration, user: null },
    accelerator: 'CommandOrControl+Shift+Space',
    createId: () => 'command-1',
    now: () => 100,
    showWindow: vi.fn<() => void>(),
    quit: vi.fn<() => void>()
  })
  const dispose = registerUiIpc({
    ipc,
    getContents: () => contents,
    entryUrl,
    interaction: manager
  })
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(
    async (channel, ...args) => structuredClone(await handlers.get(channel)!(event, ...args))
  )
  const transport = {
    invoke,
    on: (_channel: string, listener: (event: unknown, value: unknown) => void) => {
      listeners.add(listener)
    },
    removeListener: (_channel: string, listener: (event: unknown, value: unknown) => void) => {
      listeners.delete(listener)
    }
  }
  return {
    api: createUiBridge(transport, 'darwin'),
    handlers,
    manager,
    dispose,
    contents,
    event,
    entryUrl,
    ipc,
    invoke,
    send,
    listeners
  }
}

describe('implemented UI IPC boundary', () => {
  it('round-trips validated snapshots, commands and state events without an Electron event object', async () => {
    const { api, manager, dispose } = setup()
    expect(await api.getSnapshot()).toMatchObject({
      ok: true,
      value: { screen: 'login', auth: { phase: 'signed_out' } }
    })
    const listener = vi.fn<(event: UiEvent) => void>()
    const unsubscribe = api.subscribe(listener)
    expect(await api.dispatch({ type: 'auth.open', screen: 'signup' })).toMatchObject({ ok: true })
    expect(listener).toHaveBeenCalledWith({
      type: 'state.changed',
      snapshot: manager.getSnapshot()
    })
    expect(listener.mock.calls[0]).toHaveLength(1)
    expect(Object.keys(api).sort()).toEqual([
      'auth',
      'calendar',
      'collection',
      'devices',
      'dispatch',
      'gestureDiagnostics',
      'getSnapshot',
      'google',
      'platform',
      'subscribe'
    ])
    unsubscribe()
    dispose()
  })

  it('rejects foreign windows, subframes, a missing frame and a different entry document', async () => {
    const { handlers, contents, event, entryUrl, dispose } = setup()
    const handle = handlers.get(UI_CHANNELS.snapshot)!
    const senders = [
      { ...event, sender: {} },
      { ...event, senderFrame: { url: entryUrl } },
      { ...event, senderFrame: null }
    ]
    for (const sender of senders)
      expect(await handle(sender as IpcMainInvokeEvent)).toMatchObject({
        ok: false,
        error: { code: 'permission_denied' }
      })
    Object.assign(contents.mainFrame, { url: 'file:///jarvis/media/index.html' })
    expect(await handle(event)).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    dispose()
  })

  it('validates commands again in Main and refuses extra arguments or snapshots claimed by UI', async () => {
    const { handlers, event, dispose } = setup()
    const command = handlers.get(UI_CHANNELS.command)!
    for (const args of [
      [],
      [{ type: 'auth.open', screen: 'login', authenticated: true }],
      [{ type: 'auth.open', screen: 'login' }, 'extra'],
      [{ type: 'arbitrary.shell' }]
    ]) {
      expect(await command(event, ...args)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    }
    expect(await handlers.get(UI_CHANNELS.snapshot)!(event, { authenticated: true })).toMatchObject(
      { ok: false, error: { code: 'invalid_input' } }
    )
    dispose()
  })

  it('maps unexpected failures and invalid Main outputs to safe errors', async () => {
    const { api, manager, dispose } = setup()
    vi.spyOn(manager, 'dispatch').mockRejectedValueOnce(new Error('sensitive details'))
    const result = await api.dispatch({ type: 'auth.open', screen: 'signup' })
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(result)).not.toContain('sensitive')
    vi.spyOn(manager, 'getSnapshot').mockReturnValueOnce({
      ...manager.getSnapshot(),
      token: 'secret'
    } as never)
    expect(await api.getSnapshot()).toMatchObject({ ok: false, error: { code: 'internal' } })
    dispose()
  })

  it('keeps identical listener subscriptions independent and removes only owned Main handlers', async () => {
    const { api, ipc, listeners, dispose } = setup()
    const listener = vi.fn<(event: UiEvent) => void>()
    const first = api.subscribe(listener)
    const second = api.subscribe(listener)
    first()
    first()
    expect(listeners.size).toBe(1)
    await api.dispatch({ type: 'auth.open', screen: 'signup' })
    expect(listener).toHaveBeenCalledOnce()
    second()
    dispose()
    dispose()
    expect(listeners.size).toBe(0)
    expect(ipc.removeHandler.mock.calls).toEqual([[UI_CHANNELS.command], [UI_CHANNELS.snapshot]])
  })

  it('does not send invalid state/error payloads or events to a different loaded document', async () => {
    const { manager, contents, send, dispose, ipc, entryUrl } = setup()
    dispose()
    let emit!: (event: UiEvent) => void
    vi.spyOn(manager, 'subscribe').mockImplementation((listener) => {
      emit = listener
      return () => undefined
    })
    const cleanup = registerUiIpc({
      ipc,
      interaction: manager,
      entryUrl,
      getContents: () => contents
    })
    emit({
      type: 'client.error',
      error: { code: 'internal', message: 'Error', token: 'secret' }
    } as never)
    expect(send).not.toHaveBeenCalled()
    Object.assign(contents.mainFrame, { url: 'https://untrusted.example/' })
    emit({ type: 'state.changed', snapshot: manager.getSnapshot() })
    expect(send).not.toHaveBeenCalled()
    cleanup()
  })

  it('returns a typed connection failure instead of leaking invoke exceptions', async () => {
    const { api, invoke, dispose } = setup()
    invoke.mockRejectedValueOnce(new Error('raw Electron stack'))
    expect(await api.getSnapshot()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    dispose()
  })
})
