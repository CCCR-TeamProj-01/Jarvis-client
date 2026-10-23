import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { GestureDiagnosticsPort } from '../../src/main/gesture/gesture-diagnostics'
import { thresholdsOf } from '../../src/main/gesture/hand-analysis'
import { registerGestureDiagnosticsIpc } from '../../src/main/ipc/gesture-diagnostics-ipc'
import { createUiBridge } from '../../src/preload/ui-bridge'
import type {
  DiagnosticsEvent,
  DiagnosticsSnapshot
} from '../../src/shared/contracts/gesture-diagnostics'
import { GESTURE_DIAGNOSTICS_CHANNELS } from '../../src/shared/ipc/channels'
import { hand } from '../fixtures/hands'

const snapshotOf = (patch: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot => ({
  revision: 1,
  availability: 'ready',
  state: 'off',
  source: null,
  preview: false,
  error: null,
  thresholds: thresholdsOf(),
  ...patch
})

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
  let emit: (event: DiagnosticsEvent) => void = () => undefined
  let state = snapshotOf()
  const diagnostics: GestureDiagnosticsPort = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      emit = listener
      return () => {
        emit = () => undefined
      }
    },
    command: vi.fn<GestureDiagnosticsPort['command']>(async (request) => {
      state = snapshotOf({ revision: 2, state: request.action === 'start' ? 'on' : 'off' })
      return { ok: true, value: state }
    })
  }
  const dispose = registerGestureDiagnosticsIpc({
    ipc,
    getContents: () => contents,
    entryUrl,
    diagnostics
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
    api: bridge.gestureDiagnostics,
    diagnostics,
    handlers,
    contents,
    send,
    event,
    entryUrl,
    dispose,
    invoke,
    listeners,
    emit: (value: DiagnosticsEvent) => emit(value)
  }
}

const frameEvent = (withPicture = true): DiagnosticsEvent => ({
  type: 'gesture_diagnostics.frame',
  frame: {
    sequence: 3,
    fps: 29.5,
    hands: [
      {
        handId: 'right',
        handedness: 'right',
        confidence: 0.9,
        active: true,
        landmarks: hand({ pose: 'pointing' }).landmarks,
        pinch: 1,
        pinched: false,
        reach: { index: 2.1, middle: 0.7, ring: 0.7, pinky: 0.7 },
        pointing: true,
        reason: 'pointing',
        openFinger: null
      }
    ],
    picture: withPicture ? { width: 320, height: 180, jpeg: new Uint8Array([1, 2, 3]) } : null
  }
})

describe('gesture diagnostics IPC and preload boundary', () => {
  it('round-trips start, stop and the snapshot, and exposes only validated events', async () => {
    const t = setup()
    const listener = vi.fn<(event: DiagnosticsEvent) => void>()
    t.api.subscribe(listener)
    expect(await t.api.getSnapshot()).toMatchObject({ ok: true, value: { state: 'off' } })
    expect(await t.api.command({ action: 'start' })).toMatchObject({
      ok: true,
      value: { state: 'on' }
    })
    expect(await t.api.command({ action: 'stop' })).toMatchObject({
      ok: true,
      value: { state: 'off' }
    })
    expect(Object.keys(t.api).sort()).toEqual(['command', 'getSnapshot', 'subscribe'])
    t.dispose()
  })

  it('carries a frame with its picture bytes to the window intact', async () => {
    const t = setup()
    const listener = vi.fn<(event: DiagnosticsEvent) => void>()
    t.api.subscribe(listener)
    t.emit(frameEvent())
    expect(listener).toHaveBeenCalledTimes(1)
    // The bytes of the picture, and the 21 joints of each hand, arrive as they were sent.
    expect(listener.mock.calls[0]![0]).toEqual(frameEvent())
    t.emit(frameEvent(false))
    expect(listener).toHaveBeenCalledTimes(2)
    t.dispose()
  })

  it('does not send the window a frame or a state that is not in the contract', async () => {
    const t = setup()
    t.send.mockClear()
    const bad = frameEvent()
    if (bad.type === 'gesture_diagnostics.frame') {
      t.emit({
        ...bad,
        frame: { ...bad.frame, picture: { width: 320, height: 180, jpeg: new Uint8Array(200_001) } }
      })
      t.emit({
        ...bad,
        frame: { ...bad.frame, hands: [{ ...bad.frame.hands[0]!, secret: 1 } as never] }
      })
      t.emit({
        ...bad,
        frame: { ...bad.frame, picture: { width: 9000, height: 180, jpeg: new Uint8Array(3) } }
      })
    }
    t.emit({ type: 'gesture_diagnostics.state_changed', snapshot: { secret: 1 } } as never)
    expect(t.send).not.toHaveBeenCalled()
    t.dispose()
  })

  it('rejects forged requests in preload before invoking Main, and again in Main', async () => {
    const t = setup()
    const handle = t.handlers.get(GESTURE_DIAGNOSTICS_CHANNELS.command)!
    for (const request of [
      null,
      {},
      { action: 'record' },
      { action: 'start', save: true },
      { action: 'start', toServer: true },
      { action: 1 },
      'start'
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
    for (const args of [[], [{ action: 'start' }, 'extra']])
      expect(await handle(t.event, ...args)).toMatchObject({ ok: false })
    expect(
      await t.handlers.get(GESTURE_DIAGNOSTICS_CHANNELS.snapshot)!(t.event, 'extra')
    ).toMatchObject({
      ok: false
    })
    expect(t.diagnostics.command).not.toHaveBeenCalled()
    t.dispose()
  })

  it('refuses foreign windows, subframes, missing frames and other documents on both channels', async () => {
    const t = setup()
    for (const channel of [
      GESTURE_DIAGNOSTICS_CHANNELS.command,
      GESTURE_DIAGNOSTICS_CHANNELS.snapshot
    ]) {
      const handle = t.handlers.get(channel)!
      const args = channel === GESTURE_DIAGNOSTICS_CHANNELS.command ? [{ action: 'start' }] : []
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
    // Nobody but the main window could turn the camera on.
    expect(t.diagnostics.command).not.toHaveBeenCalled()
    t.dispose()
  })

  it('never pushes the camera picture to a different document', async () => {
    const t = setup()
    const listener = vi.fn<(event: DiagnosticsEvent) => void>()
    t.api.subscribe(listener)
    t.send.mockClear()
    Object.assign(t.contents.mainFrame, { url: 'file:///foreign.html' })
    t.emit(frameEvent())
    expect(t.send).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    Object.assign(t.contents.mainFrame, { url: t.entryUrl })
    t.emit(frameEvent())
    expect(listener).toHaveBeenCalledTimes(1)
    t.dispose()
  })

  it('turns exceptions and invalid answers into fixed errors without exposing internals', async () => {
    const t = setup()
    vi.mocked(t.diagnostics.command).mockRejectedValueOnce(new Error('secret'))
    const failed = await t.api.command({ action: 'start' })
    expect(failed).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(failed)).not.toContain('secret')
    vi.mocked(t.diagnostics.command).mockResolvedValueOnce({
      ok: true,
      value: { secret: 1 }
    } as never)
    expect(await t.api.command({ action: 'start' })).toMatchObject({ ok: false })
    t.invoke.mockResolvedValueOnce({ ok: true, value: { state: 'maybe' } })
    expect(await t.api.getSnapshot()).toMatchObject({ ok: false })
    t.dispose()
  })

  it('discards invalid events in preload, unsubscribes once, and removes its handlers when disposed', async () => {
    const t = setup()
    const listener = vi.fn<(event: DiagnosticsEvent) => void>()
    const unsubscribe = t.api.subscribe(listener)
    const receive = [...t.listeners.get(GESTURE_DIAGNOSTICS_CHANNELS.event)!][0]!
    receive({}, { type: 'gesture_diagnostics.frame', frame: { secret: 'secret' } })
    receive({}, { type: 'other' })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
    unsubscribe()
    t.emit(frameEvent())
    expect(listener).not.toHaveBeenCalled()
    expect(t.listeners.get(GESTURE_DIAGNOSTICS_CHANNELS.event)?.size).toBe(0)
    expect([...t.handlers.keys()].sort()).toEqual([
      GESTURE_DIAGNOSTICS_CHANNELS.command,
      GESTURE_DIAGNOSTICS_CHANNELS.snapshot
    ])
    t.dispose()
    t.dispose()
    expect(t.handlers.size).toBe(0)
  })
})
