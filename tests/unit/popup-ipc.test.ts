import { describe, expect, it, vi } from 'vitest'
import { registerPopupIpc } from '../../src/main/ipc/popup-ipc'
import { createPopupBridge } from '../../src/preload/popup-bridge'
import type { Result } from '../../src/shared/contracts/common'
import type {
  RecommendationCard,
  RecommendationResponse
} from '../../src/shared/contracts/recommendation'
import { POPUP_CHANNELS } from '../../src/shared/ipc/channels'

const ENTRY = 'file:///popup/index.html'
const card: RecommendationCard = {
  recommendationId: '701',
  reason: '자주 함께 쓰는 앱이에요.',
  targets: [{ position: 0, appCode: 'chrome', displayName: 'Google Chrome' }],
  expiresAtUnixMs: 1_000,
  phase: 'offered'
}

function contents() {
  const frame = { url: ENTRY }
  return { frame, wc: { isDestroyed: () => false, mainFrame: frame } }
}
const from = (sender: unknown, senderFrame: unknown) => ({ sender, senderFrame }) as never

function setup(respond?: (id: string, response: RecommendationResponse) => Promise<Result<void>>) {
  const { frame, wc } = contents()
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>()
  const listeners = new Map<string, (event: never, ...args: unknown[]) => void>()
  const answers = vi.fn<(id: string, response: RecommendationResponse) => Promise<Result<void>>>(
    respond ?? (async () => ({ ok: true, value: undefined }))
  )
  const resize = vi.fn<(height: number) => void>()
  const dispose = registerPopupIpc({
    ipc: {
      handle: (channel: string, handler: never) => void handlers.set(channel, handler),
      removeHandler: (channel: string) => void handlers.delete(channel),
      on: (channel: string, listener: never) => void listeners.set(channel, listener),
      removeListener: (channel: string) => void listeners.delete(channel)
    } as never,
    getContents: () => wc as never,
    entryUrl: ENTRY,
    getState: () => card,
    respond: answers,
    resize
  })
  const invoke = (channel: string, event: unknown, ...args: unknown[]) =>
    handlers.get(channel)!(event as never, ...args)
  const send = (channel: string, event: unknown, ...args: unknown[]) =>
    listeners.get(channel)!(event as never, ...args)
  return { frame, wc, handlers, listeners, answers, resize, dispose, invoke, send }
}

describe('popup IPC', () => {
  it('serves the card only to the popup page', async () => {
    const t = setup()
    expect(await t.invoke(POPUP_CHANNELS.snapshot, from(t.wc, t.frame))).toEqual(card)
    expect(await t.invoke(POPUP_CHANNELS.snapshot, from({}, t.frame))).toBeNull()
    expect(await t.invoke(POPUP_CHANNELS.snapshot, from(t.wc, { ...t.frame }))).toBeNull()
  })

  it.each(['approved', 'snoozed', 'rejected', 'dismissed'] as const)(
    'passes %s on from the popup page',
    async (response) => {
      const t = setup()
      expect(await t.invoke(POPUP_CHANNELS.respond, from(t.wc, t.frame), '701', response)).toEqual({
        ok: true,
        value: undefined
      })
      expect(t.answers).toHaveBeenCalledExactlyOnceWith('701', response)
    }
  )

  it('passes a failure on as it is', async () => {
    const failure = {
      ok: false,
      error: { code: 'expired', message: '추천 시간이 지났어요.' }
    } as const
    const t = setup(async () => failure)
    expect(await t.invoke(POPUP_CHANNELS.respond, from(t.wc, t.frame), '701', 'approved')).toEqual(
      failure
    )
  })

  it('refuses an answer from anywhere else, without acting on it', async () => {
    const t = setup()
    for (const sender of [from({}, t.frame), from(t.wc, { ...t.frame }), from(t.wc, null)]) {
      expect(await t.invoke(POPUP_CHANNELS.respond, sender, '701', 'approved')).toMatchObject({
        ok: false,
        error: { code: 'permission_denied' }
      })
    }
    expect(t.answers).not.toHaveBeenCalled()
  })

  it.each([
    ['no arguments', []],
    ['one argument', ['701']],
    ['three arguments', ['701', 'approved', 'x']],
    ['an empty ID', ['', 'approved']],
    ['an ID with surrounding space', [' 701', 'approved']],
    ['a number for an ID', [701, 'approved']],
    ['an unknown answer', ['701', 'maybe']],
    ['a wrong-case answer', ['701', 'Approved']],
    ['an object for the answer', ['701', { response: 'approved' }]],
    ['null', [null, null]]
  ])('refuses %s', async (_name, args) => {
    const t = setup()
    expect(await t.invoke(POPUP_CHANNELS.respond, from(t.wc, t.frame), ...args)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    expect(t.answers).not.toHaveBeenCalled()
  })

  it('takes a height from the popup page only, and only a finite number', () => {
    const t = setup()
    t.send(POPUP_CHANNELS.resize, from(t.wc, t.frame), 260)
    expect(t.resize).toHaveBeenCalledExactlyOnceWith(260)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '260', null, undefined, {}]) {
      t.send(POPUP_CHANNELS.resize, from(t.wc, t.frame), bad)
    }
    t.send(POPUP_CHANNELS.resize, from(t.wc, t.frame))
    t.send(POPUP_CHANNELS.resize, from(t.wc, t.frame), 100, 200)
    t.send(POPUP_CHANNELS.resize, from({}, t.frame), 300)
    expect(t.resize).toHaveBeenCalledTimes(1)
  })

  it('stops listening on dispose, once', () => {
    const t = setup()
    t.dispose()
    t.dispose()
    expect(t.handlers.size).toBe(0)
    expect(t.listeners.size).toBe(0)
  })
})

describe('popup bridge', () => {
  function transport(
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown> = async () => null
  ) {
    const listeners = new Set<(event: unknown, value: unknown) => void>()
    const send = vi.fn<(channel: string, ...args: unknown[]) => void>()
    const ipc = {
      invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(invoke),
      on: (_channel: string, listener: (event: unknown, value: unknown) => void) =>
        void listeners.add(listener),
      removeListener: (_channel: string, listener: (event: unknown, value: unknown) => void) =>
        void listeners.delete(listener),
      send
    }
    return {
      ipc,
      listeners,
      send,
      emit: (value: unknown) => [...listeners].forEach((l) => l({}, value))
    }
  }

  it('gives the page the card Main has, and nothing for anything malformed', async () => {
    expect(await createPopupBridge(transport(async () => card).ipc).getState()).toEqual(card)
    expect(await createPopupBridge(transport(async () => null).ipc).getState()).toBeNull()
    expect(
      await createPopupBridge(transport(async () => ({ ...card, reason: '' })).ipc).getState()
    ).toBeNull()
    expect(await createPopupBridge(transport(async () => 'x').ipc).getState()).toBeNull()
  })

  it('passes on only valid cards, and null, to a listener, until it unsubscribes', () => {
    const t = transport()
    const seen: unknown[] = []
    const stop = createPopupBridge(t.ipc).subscribe((value) => seen.push(value))
    t.emit(card)
    t.emit(null)
    t.emit({ ...card, targets: [] })
    t.emit('nonsense')
    t.emit({ ...card, runs: 'rm -rf' })
    expect(seen).toEqual([card, null])
    stop()
    stop()
    t.emit(card)
    expect(seen).toHaveLength(2)
    expect(t.listeners.size).toBe(0)
  })

  it('sends an answer to Main and returns what Main says', async () => {
    const t = transport(async () => ({ ok: true, value: undefined }))
    expect(await createPopupBridge(t.ipc).respond('701', 'approved')).toEqual({
      ok: true,
      value: undefined
    })
    expect(t.ipc.invoke).toHaveBeenCalledExactlyOnceWith(POPUP_CHANNELS.respond, '701', 'approved')
  })

  it("returns Main's failure with its wording", async () => {
    const failure = { ok: false, error: { code: 'expired', message: '추천 시간이 지났어요.' } }
    const t = transport(async () => failure)
    expect(await createPopupBridge(t.ipc).respond('701', 'approved')).toEqual(failure)
  })

  it("answers with a fixed failure when Main's reply is malformed or the call fails", async () => {
    for (const invoke of [
      async () => 'nonsense',
      async () => ({ ok: true }),
      async () => {
        throw new Error('channel closed')
      }
    ]) {
      const result = await createPopupBridge(transport(invoke).ipc).respond('701', 'approved')
      expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
      expect(JSON.stringify(result)).not.toContain('channel closed')
    }
  })

  it('does not send what Main would refuse', async () => {
    const t = transport()
    const bridge = createPopupBridge(t.ipc)
    expect(await bridge.respond('701', 'maybe' as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    expect(await bridge.respond(701 as never, 'approved')).toMatchObject({ ok: false })
    expect(t.ipc.invoke).not.toHaveBeenCalled()
  })

  it('sends a height as a whole number, and nothing for one that is not a number', () => {
    const t = transport()
    const bridge = createPopupBridge(t.ipc)
    bridge.resize(260.6)
    bridge.resize(Number.NaN)
    bridge.resize(Number.POSITIVE_INFINITY)
    expect(t.send.mock.calls).toEqual([[POPUP_CHANNELS.resize, 261]])
  })
})
