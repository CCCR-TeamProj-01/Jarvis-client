import { describe, expect, it, vi } from 'vitest'
import { PopupWindow, POPUP_WIDTH_PX } from '../../src/main/recommendation/popup-window'
import type { PopupBrowserWindow } from '../../src/main/recommendation/popup-window'
import type { RecommendationCard } from '../../src/shared/contracts/recommendation'
import { POPUP_CHANNELS } from '../../src/shared/ipc/channels'
import { POPUP_MAX_HEIGHT_PX, POPUP_MIN_HEIGHT_PX } from '../../src/shared/ipc/popup-api'

const card = (overrides: Partial<RecommendationCard> = {}): RecommendationCard => ({
  recommendationId: '701',
  reason: '자주 함께 쓰는 앱이에요.',
  targets: [{ position: 0, appCode: 'chrome', displayName: 'Google Chrome' }],
  expiresAtUnixMs: 1_000,
  phase: 'offered',
  ...overrides
})

class FakeWindow implements PopupBrowserWindow {
  destroyed = false
  visible = false
  bounds: { x: number; y: number; width: number; height: number } | null = null
  readonly sent: unknown[] = []
  readonly shown = vi.fn<() => void>()
  loadResolve: () => void = () => undefined
  loadReject: (error: Error) => void = () => undefined
  closedListener: () => void = () => undefined
  readonly webContents = {
    send: (_channel: string, value: unknown) => {
      this.sent.push(value)
    }
  }
  loadURL = vi.fn<(url: string) => Promise<void>>(
    () =>
      new Promise<void>((resolve, reject) => {
        this.loadResolve = resolve
        this.loadReject = reject
      })
  )
  isDestroyed() {
    return this.destroyed
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.bounds = bounds
  }
  showInactive() {
    this.visible = true
    this.shown()
  }
  hide() {
    this.visible = false
  }
  destroy() {
    this.destroyed = true
  }
  on(_event: 'closed', listener: () => void) {
    this.closedListener = listener
  }
}

function setup(workArea = { x: 0, y: 25, width: 1440, height: 875 }) {
  const windows: FakeWindow[] = []
  const popup = new PopupWindow({
    entryUrl: 'file:///popup/index.html',
    workArea: () => workArea,
    create: () => {
      const created = new FakeWindow()
      windows.push(created)
      return created
    }
  })
  const ready = async (index = 0) => {
    windows[index]!.loadResolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { popup, windows, ready }
}

describe('PopupWindow', () => {
  it('opens no window until there is something to show', () => {
    const t = setup()
    t.popup.apply(null)
    expect(t.windows).toHaveLength(0)
  })

  it('loads its page, and shows the card once the page is ready, without taking focus', async () => {
    const t = setup()
    t.popup.apply(card())
    expect(t.windows).toHaveLength(1)
    expect(t.windows[0]!.loadURL).toHaveBeenCalledExactlyOnceWith('file:///popup/index.html')
    // Nothing is shown, or sent, before the page can take it.
    expect(t.windows[0]!.visible).toBe(false)
    expect(t.windows[0]!.sent).toEqual([])
    await t.ready()
    expect(t.windows[0]!.sent).toEqual([card()])
    expect(t.windows[0]!.visible).toBe(true)
  })

  it('goes in the bottom right corner of the usable area', async () => {
    const t = setup({ x: 100, y: 25, width: 1000, height: 700 })
    t.popup.apply(card())
    await t.ready()
    const bounds = t.windows[0]!.bounds!
    expect(bounds.x).toBe(100 + 1000 - POPUP_WIDTH_PX - 16)
    expect(bounds.width).toBe(POPUP_WIDTH_PX)
    // The corner is the usable area's, not the display's: above the Dock or taskbar.
    expect(bounds.y + bounds.height).toBe(25 + 700 - 16)
  })

  it('keeps its bottom edge in place when the card gets taller or shorter', async () => {
    const t = setup({ x: 0, y: 0, width: 1000, height: 800 })
    t.popup.apply(card())
    await t.ready()
    for (const height of [180, 300, 450]) {
      t.popup.setHeight(height)
      const bounds = t.windows[0]!.bounds!
      expect(bounds.height).toBe(height)
      expect(bounds.y + bounds.height).toBe(800 - 16)
    }
  })

  it('is no taller than a short screen has room for', async () => {
    const t = setup({ x: 0, y: 25, width: 1280, height: 300 })
    t.popup.apply(card())
    await t.ready()
    t.popup.setHeight(500)
    const bounds = t.windows[0]!.bounds!
    expect(bounds.height).toBe(300 - 32)
    expect(bounds.y).toBe(25 + 16)
  })

  it('stays inside a small screen even at its tallest', async () => {
    const t = setup({ x: 0, y: 25, width: 1280, height: 600 })
    t.popup.apply(card())
    await t.ready()
    t.popup.setHeight(100_000)
    const bounds = t.windows[0]!.bounds!
    expect(bounds.y).toBeGreaterThanOrEqual(25)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(25 + 600)
  })

  it('does not draw the same card twice, and updates it when it changes', async () => {
    const t = setup()
    t.popup.apply(card())
    await t.ready()
    const window = t.windows[0]!
    t.popup.apply(card())
    t.popup.apply(card())
    expect(window.sent).toHaveLength(1)
    expect(window.shown).toHaveBeenCalledTimes(1)
    t.popup.apply(card({ phase: 'responding' }))
    expect(window.sent).toHaveLength(2)
    expect(window.sent[1]).toMatchObject({ phase: 'responding' })
  })

  it('hides when the card goes away, and tells the page', async () => {
    const t = setup()
    t.popup.apply(card())
    await t.ready()
    t.popup.apply(null)
    expect(t.windows[0]!.visible).toBe(false)
    expect(t.windows[0]!.sent.at(-1)).toBeNull()
    expect(t.popup.getState()).toBeNull()
  })

  it('reuses its window for the next card', async () => {
    const t = setup()
    t.popup.apply(card())
    await t.ready()
    t.popup.apply(null)
    t.popup.apply(card({ recommendationId: '702' }))
    expect(t.windows).toHaveLength(1)
    expect(t.windows[0]!.visible).toBe(true)
    expect(t.windows[0]!.sent.at(-1)).toMatchObject({ recommendationId: '702' })
  })

  it('shows what was asked for while the page was still loading, not what was asked for before', async () => {
    const t = setup()
    t.popup.apply(card({ recommendationId: '701' }))
    t.popup.apply(card({ recommendationId: '702' }))
    await t.ready()
    expect(t.windows[0]!.sent).toEqual([card({ recommendationId: '702' })])
  })

  it('shows nothing if the card went away while the page was loading', async () => {
    const t = setup()
    t.popup.apply(card())
    t.popup.apply(null)
    await t.ready()
    expect(t.windows[0]!.visible).toBe(false)
    expect(t.windows[0]!.sent).toEqual([])
  })

  it('fits the height the page reports, within limits', async () => {
    const t = setup()
    t.popup.apply(card())
    await t.ready()
    t.popup.setHeight(310.4)
    expect(t.windows[0]!.bounds?.height).toBe(310)
    t.popup.setHeight(10)
    expect(t.windows[0]!.bounds?.height).toBe(POPUP_MIN_HEIGHT_PX)
    t.popup.setHeight(100_000)
    expect(t.windows[0]!.bounds?.height).toBe(POPUP_MAX_HEIGHT_PX)
    t.popup.setHeight(Number.NaN)
    t.popup.setHeight(Number.POSITIVE_INFINITY)
    expect(t.windows[0]!.bounds?.height).toBe(POPUP_MAX_HEIGHT_PX)
  })

  it('does not move a window that is not shown when the page reports a height', async () => {
    const t = setup()
    t.popup.apply(card())
    await t.ready()
    t.popup.apply(null)
    t.windows[0]!.bounds = null
    t.popup.setHeight(300)
    expect(t.windows[0]!.bounds).toBeNull()
  })

  it('opens a new window when the old one was closed', async () => {
    const t = setup()
    t.popup.apply(card())
    await t.ready()
    t.windows[0]!.closedListener()
    t.popup.apply(card({ recommendationId: '702' }))
    expect(t.windows).toHaveLength(2)
    await t.ready(1)
    expect(t.windows[1]!.visible).toBe(true)
  })

  it('opens a new window when the old one was destroyed', async () => {
    const t = setup()
    t.popup.apply(card())
    await t.ready()
    t.windows[0]!.destroyed = true
    t.popup.apply(card({ recommendationId: '702' }))
    expect(t.windows).toHaveLength(2)
  })

  it('tries again with a new window when the page failed to load', async () => {
    const t = setup()
    t.popup.apply(card())
    t.windows[0]!.loadReject(new Error('load failed'))
    await Promise.resolve()
    await Promise.resolve()
    t.popup.apply(card({ recommendationId: '702' }))
    expect(t.windows).toHaveLength(2)
  })

  it('tries again for the same card when the page failed to load and the state is announced again', async () => {
    const t = setup()
    t.popup.apply(card())
    t.windows[0]!.loadReject(new Error('load failed'))
    await Promise.resolve()
    await Promise.resolve()
    t.popup.apply(card())
    expect(t.windows).toHaveLength(2)
  })

  it('hands out a copy of the card, so nothing outside can change what it shows', async () => {
    const t = setup()
    t.popup.apply(card())
    const copy = t.popup.getState()!
    copy.reason = 'changed'
    expect(t.popup.getState()?.reason).toBe('자주 함께 쓰는 앱이에요.')
  })

  it('does not take what it was given as its own', async () => {
    const t = setup()
    const given = card()
    t.popup.apply(given)
    given.reason = 'changed'
    expect(t.popup.getState()?.reason).toBe('자주 함께 쓰는 앱이에요.')
    await t.ready()
    expect(t.windows[0]!.sent[0]).toMatchObject({ reason: '자주 함께 쓰는 앱이에요.' })
  })

  it('destroys its window on dispose and shows nothing after', async () => {
    const t = setup()
    t.popup.apply(card())
    await t.ready()
    t.popup.dispose()
    expect(t.windows[0]!.destroyed).toBe(true)
    expect(t.popup.getState()).toBeNull()
    t.popup.setHeight(300)
  })

  it('uses the channel the page listens on', async () => {
    expect(POPUP_CHANNELS.state).toBe('jarvis:popup:state')
  })
})
