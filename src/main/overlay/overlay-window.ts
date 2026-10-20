import { EMPTY_OVERLAY } from '../../shared/contracts/overlay'
import type { OverlayState } from '../../shared/contracts/overlay'
import { OVERLAY_CHANNELS } from '../../shared/ipc/channels'
import type { OverlayWindowPort } from './overlay-controller'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** The part of Electron's window that the overlay uses, so it can be tested with a stand-in. */
export interface OverlayBrowserWindow {
  loadURL(url: string): Promise<void>
  isDestroyed(): boolean
  setBounds(bounds: Bounds): void
  showInactive(): void
  hide(): void
  destroy(): void
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void
  webContents: { send(channel: string, ...args: unknown[]): void }
  on(event: 'closed', listener: () => void): unknown
}

interface OverlayWindowOptions {
  entryUrl: string
  create(): OverlayBrowserWindow
  /** The area to cover: the display with this ID, or the main display when unknown. */
  displayBounds(displayId: string | null): Bounds
}

const isEmpty = (state: OverlayState) => state.voice === null && state.gesture === null

/**
 * A transparent window laid over one display. It lets the mouse through, never takes focus and
 * exists only while there is something to show. The one exception is a pill with a stop button:
 * while the pointer is over it, the window accepts the mouse.
 */
export class OverlayWindow implements OverlayWindowPort {
  private window: OverlayBrowserWindow | null = null
  private loaded = false
  private latest: OverlayState = EMPTY_OVERLAY
  private displayId: string | null = null

  constructor(private readonly options: OverlayWindowOptions) {}

  getState(): OverlayState {
    return this.latest
  }

  hasStoppable(): boolean {
    return this.latest.voice?.stoppable === true || this.latest.gesture?.stoppable === true
  }

  apply(state: OverlayState, displayId: string | null): void {
    this.latest = state
    this.displayId = displayId
    if (isEmpty(state)) {
      this.hide()
      return
    }
    const window = this.ensureWindow()
    window.setBounds(this.options.displayBounds(displayId))
    if (!this.hasStoppable()) window.setIgnoreMouseEvents(true, { forward: true })
    if (this.loaded) {
      window.webContents.send(OVERLAY_CHANNELS.state, state)
      window.showInactive()
    }
  }

  /** Honoured only while a stop button is on screen; otherwise the mouse keeps passing through. */
  setInteractive(interactive: boolean): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    window.setIgnoreMouseEvents(!(interactive && this.hasStoppable()), { forward: true })
  }

  dispose(): void {
    const window = this.window
    this.window = null
    this.loaded = false
    if (window && !window.isDestroyed()) window.destroy()
  }

  private hide(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    window.setIgnoreMouseEvents(true, { forward: true })
    if (this.loaded) window.webContents.send(OVERLAY_CHANNELS.state, this.latest)
    window.hide()
  }

  private ensureWindow(): OverlayBrowserWindow {
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
    window.setIgnoreMouseEvents(true, { forward: true })
    const finish = () => {
      if (this.window !== window || window.isDestroyed()) return
      this.loaded = true
      if (isEmpty(this.latest)) return
      window.setBounds(this.options.displayBounds(this.displayId))
      window.webContents.send(OVERLAY_CHANNELS.state, this.latest)
      window.showInactive()
    }
    // The page is told what to draw once it is ready; until then it can ask for the state itself.
    void window.loadURL(this.options.entryUrl).then(finish, () => {
      if (this.window === window) this.window = null
    })
    return window
  }
}
