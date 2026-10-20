import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import type { MediaCommandEnvelope } from '../../shared/ipc/media-api'
import { MEDIA_CHANNELS } from '../../shared/ipc/channels'

interface MediaWindowOptions {
  entryUrl: string
  preloadPath: string
  isQuitting(): boolean
  /** The renderer process crashed or was killed; its streams are gone. */
  onGone(): void
}

/**
 * A never-shown window that hosts the Media Renderer. It is created on first use (not at launch
 * and never before sign-in) and keeps running while hidden, minimized or locked.
 */
export class MediaWindow {
  private window: BrowserWindow | null = null
  private loaded: Promise<boolean> | null = null

  constructor(private readonly options: MediaWindowOptions) {}

  getContents(): WebContents | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : null
  }

  /** Deliver a command, creating and loading the window first. False if it cannot be reached. */
  async send(envelope: MediaCommandEnvelope): Promise<boolean> {
    if (this.options.isQuitting()) return false
    const window = this.ensureWindow()
    if (!(await this.loaded)) return false
    if (window.isDestroyed()) return false
    try {
      window.webContents.send(MEDIA_CHANNELS.command, envelope)
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    const window = this.window
    this.window = null
    this.loaded = null
    if (window && !window.isDestroyed()) window.destroy()
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      focusable: false,
      title: 'Jarvis Media',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Capture must keep running while the window is hidden, occluded or the screen is locked.
        backgroundThrottling: false
      }
    })
    this.window = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', () => {
      if (this.window === window) {
        this.window = null
        this.loaded = null
      }
      this.options.onGone()
    })
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.loaded = null
        this.options.onGone()
      }
    })
    this.loaded = window.loadURL(this.options.entryUrl).then(
      () => true,
      () => false
    )
    return window
  }
}
