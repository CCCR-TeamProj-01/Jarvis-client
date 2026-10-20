import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'

interface UiWindowOptions {
  entryUrl: string
  preloadPath: string
  isQuitting(): boolean
  canHide(): boolean
  onLoadFailure(): void
}

export class UiWindow {
  private window: BrowserWindow | null = null
  private ready = false
  private showRequested = false

  constructor(private readonly options: UiWindowOptions) {}

  getContents(): WebContents | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : null
  }

  open(): void {
    if (this.options.isQuitting()) return
    this.showRequested = true
    const window = this.ensureWindow()
    if (this.ready) this.show(window)
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    this.ready = false
    const window = new BrowserWindow({
      width: 880,
      height: 800,
      minWidth: 640,
      minHeight: 560,
      show: false,
      backgroundColor: '#0b1220',
      title: 'Jarvis',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.window = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    window.once('ready-to-show', () => {
      if (this.window !== window || window.isDestroyed()) return
      this.ready = true
      if (this.showRequested && !this.options.isQuitting()) this.show(window)
    })
    window.on('close', (event) => {
      if (this.options.isQuitting()) return
      event.preventDefault()
      // Keep a reachable window if the tray could not be created.
      if (this.options.canHide()) {
        this.showRequested = false
        window.hide()
      }
    })
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.ready = false
      }
    })
    void window.loadURL(this.options.entryUrl).catch(() => this.options.onLoadFailure())
    return window
  }

  private show(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}
