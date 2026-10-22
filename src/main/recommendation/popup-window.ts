import type { RecommendationCard } from '../../shared/contracts/recommendation'
import { POPUP_CHANNELS } from '../../shared/ipc/channels'
import { POPUP_MAX_HEIGHT_PX, POPUP_MIN_HEIGHT_PX } from '../../shared/ipc/popup-api'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** The part of Electron's window that the popup uses, so it can be tested with a stand-in. */
export interface PopupBrowserWindow {
  loadURL(url: string): Promise<void>
  isDestroyed(): boolean
  setBounds(bounds: Bounds): void
  showInactive(): void
  hide(): void
  destroy(): void
  webContents: { send(channel: string, ...args: unknown[]): void }
  on(event: 'closed', listener: () => void): unknown
}

interface PopupWindowOptions {
  entryUrl: string
  create(): PopupBrowserWindow
  /** The usable area of the display the popup goes on (below the menu bar, above the Dock). */
  workArea(): Bounds
}

export const POPUP_WIDTH_PX = 400
const MARGIN_PX = 16
/** Until the page says how tall it is. */
const INITIAL_HEIGHT_PX = 220

/**
 * A small window in the bottom right corner of the screen that shows the recommendation on offer. It
 * is shown without taking the keyboard from whatever the user is working in, exists only while
 * there is a card, and is told what to draw rather than deciding anything itself.
 */
export class PopupWindow {
  private window: PopupBrowserWindow | null = null
  private loaded = false
  private latest: RecommendationCard | null = null
  private height = INITIAL_HEIGHT_PX

  constructor(private readonly options: PopupWindowOptions) {}

  getState(): RecommendationCard | null {
    return this.latest ? structuredClone(this.latest) : null
  }

  /** The card to show, or null to take the popup away. */
  apply(card: RecommendationCard | null): void {
    // The same card again (the app's state changes for many other reasons) changes nothing on screen.
    // Unless there is no window to draw it (never opened, or it failed), which is worth trying again.
    const drawn = this.window !== null && !this.window.isDestroyed()
    if (JSON.stringify(card) === JSON.stringify(this.latest) && (drawn || card === null)) return
    this.latest = card ? structuredClone(card) : null
    if (card === null) {
      this.hide()
      return
    }
    const window = this.ensureWindow()
    if (!this.loaded) return // shown as soon as the page is ready
    this.place(window)
    window.webContents.send(POPUP_CHANNELS.state, this.getState())
    window.showInactive()
  }

  /** The page's own height, kept within limits so a page cannot make the window absurd. */
  setHeight(heightPx: number): void {
    if (!Number.isFinite(heightPx)) return
    this.height = Math.min(Math.max(Math.round(heightPx), POPUP_MIN_HEIGHT_PX), POPUP_MAX_HEIGHT_PX)
    const window = this.window
    if (window && !window.isDestroyed() && this.loaded && this.latest) this.place(window)
  }

  dispose(): void {
    const window = this.window
    this.window = null
    this.loaded = false
    this.latest = null
    if (window && !window.isDestroyed()) window.destroy()
  }

  private place(window: PopupBrowserWindow): void {
    const area = this.options.workArea()
    // On a short screen the window is no taller than the screen has room for.
    const height = Math.max(1, Math.min(this.height, area.height - 2 * MARGIN_PX))
    // The bottom edge stays put, so a taller card grows upward instead of off the screen.
    window.setBounds({
      x: Math.round(area.x + area.width - POPUP_WIDTH_PX - MARGIN_PX),
      y: Math.round(area.y + area.height - height - MARGIN_PX),
      width: POPUP_WIDTH_PX,
      height
    })
  }

  private hide(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (this.loaded) window.webContents.send(POPUP_CHANNELS.state, null)
    window.hide()
  }

  private ensureWindow(): PopupBrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const window = this.options.create()
    this.window = window
    this.loaded = false
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.loaded = false
      }
    })
    const finish = () => {
      if (this.window !== window || window.isDestroyed()) return
      this.loaded = true
      if (this.latest === null) return
      this.place(window)
      window.webContents.send(POPUP_CHANNELS.state, this.getState())
      window.showInactive()
    }
    void window.loadURL(this.options.entryUrl).then(finish, () => {
      if (this.window === window) this.window = null
    })
    return window
  }
}
