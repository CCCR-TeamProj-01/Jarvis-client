import { describe, expect, it, vi } from 'vitest'
import { registerOverlayIpc } from '../../src/main/ipc/overlay-ipc'
import { isTrustedSender } from '../../src/main/ipc/trusted-sender'
import { createOverlayBridge } from '../../src/preload/overlay-bridge'
import { EMPTY_OVERLAY } from '../../src/shared/contracts/overlay'
import type { OverlayState } from '../../src/shared/contracts/overlay'
import { OVERLAY_CHANNELS } from '../../src/shared/ipc/channels'

const ENTRY = 'file:///overlay/index.html'
const state: OverlayState = {
  revision: 3,
  voice: { id: 'voice-1', kind: 'speaking', text: '답하고 있어요', stoppable: true },
  gesture: null
}

function contents() {
  const frame = { url: ENTRY }
  return { frame, wc: { isDestroyed: () => false, mainFrame: frame } }
}
const from = (sender: unknown, senderFrame: unknown) => ({ sender, senderFrame }) as never

function setup() {
  const { frame, wc } = contents()
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>()
  const listeners = new Map<string, (event: never, ...args: unknown[]) => void>()
  const setInteractive = vi.fn<(interactive: boolean) => void>()
  const stop = vi.fn<() => void>()
  const dispose = registerOverlayIpc({
    ipc: {
      handle: (channel: string, handler: never) => void handlers.set(channel, handler),
      removeHandler: (channel: string) => void handlers.delete(channel),
      on: (channel: string, listener: never) => void listeners.set(channel, listener),
      removeListener: (channel: string) => void listeners.delete(channel)
    } as never,
    getContents: () => wc as never,
    entryUrl: ENTRY,
    getState: () => state,
    setInteractive,
    stop
  })
  return { frame, wc, handlers, listeners, setInteractive, stop, dispose }
}

describe('isTrustedSender', () => {
  it('accepts only the expected window, its top frame and its entry page', () => {
    const { frame, wc } = contents()
    expect(isTrustedSender(from(wc, frame), wc as never, ENTRY)).toBe(true)
    expect(isTrustedSender(from({}, frame), wc as never, ENTRY)).toBe(false)
    expect(isTrustedSender(from(wc, { url: ENTRY }), wc as never, ENTRY)).toBe(false)
    expect(
      isTrustedSender(from(wc, { ...frame, url: 'file:///other.html' }), wc as never, ENTRY)
    ).toBe(false)
    expect(isTrustedSender(from(wc, null), wc as never, ENTRY)).toBe(false)
    expect(isTrustedSender(from(wc, frame), null, ENTRY)).toBe(false)
  })
})

describe('overlay IPC', () => {
  it('serves the state only to the overlay page', async () => {
    const t = setup()
    const handler = t.handlers.get(OVERLAY_CHANNELS.snapshot)!
    expect(await handler(from(t.wc, t.frame))).toEqual(state)
    expect(await handler(from({}, t.frame))).toEqual(EMPTY_OVERLAY)
  })

  it('passes the pointer’s position on, as a boolean only, from the page only', () => {
    const t = setup()
    const handler = t.listeners.get(OVERLAY_CHANNELS.interactive)!
    handler(from(t.wc, t.frame), true)
    handler(from(t.wc, t.frame), false)
    handler(from(t.wc, t.frame), 'yes')
    handler(from(t.wc, t.frame), true, 'extra')
    handler(from({}, t.frame), true)
    expect(t.setInteractive.mock.calls).toEqual([[true], [false]])
  })

  it('takes the stop request from the page only and with no payload', () => {
    const t = setup()
    const handler = t.listeners.get(OVERLAY_CHANNELS.stop)!
    handler(from({}, t.frame))
    handler(from(t.wc, t.frame), 'rm -rf')
    expect(t.stop).not.toHaveBeenCalled()
    handler(from(t.wc, t.frame))
    expect(t.stop).toHaveBeenCalledOnce()
  })

  it('stops listening when disposed', () => {
    const t = setup()
    t.dispose()
    t.dispose()
    expect(t.handlers.size).toBe(0)
    expect(t.listeners.size).toBe(0)
  })
})

describe('overlay bridge', () => {
  function bridge() {
    const listeners = new Set<(event: unknown, value: unknown) => void>()
    const sent: [string, unknown[]][] = []
    let invoked: unknown = state
    const api = createOverlayBridge({
      invoke: async () => invoked,
      on: (_channel, listener) => void listeners.add(listener),
      removeListener: (_channel, listener) => void listeners.delete(listener),
      send: (channel, ...args) => void sent.push([channel, args])
    })
    return {
      api,
      listeners,
      sent,
      setInvoked: (value: unknown) => {
        invoked = value
      }
    }
  }

  it('hands the page only valid state', async () => {
    const t = bridge()
    expect(await t.api.getState()).toEqual(state)
    t.setInvoked({ revision: 'x' })
    expect(await t.api.getState()).toEqual({ revision: 0, voice: null, gesture: null })
    const received: OverlayState[] = []
    const stop = t.api.subscribe((value) => received.push(value))
    for (const listener of t.listeners) {
      listener({}, state)
      listener({}, { ...state, extra: 1 })
      listener({}, null)
    }
    expect(received).toEqual([state])
    stop()
    expect(t.listeners.size).toBe(0)
  })

  it('sends only its two fixed messages', () => {
    const t = bridge()
    t.api.setInteractive(true)
    t.api.setInteractive('yes' as unknown as boolean)
    t.api.stop()
    expect(t.sent).toEqual([
      [OVERLAY_CHANNELS.interactive, [true]],
      [OVERLAY_CHANNELS.interactive, [false]],
      [OVERLAY_CHANNELS.stop, []]
    ])
  })
})
