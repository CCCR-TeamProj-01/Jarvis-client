import { BrowserWindow, nativeTheme } from 'electron'
import type { WebContents } from 'electron'
import { release } from 'node:os'
import type { WindowMaterial } from '../../shared/contracts/application'
import { OPAQUE_WINDOW_BACKGROUND, watchWindowMaterial } from './window-material'

interface UiWindowOptions {
  entryUrl: string
  preloadPath: string
  isQuitting(): boolean
  canHide(): boolean
  onLoadFailure(): void
  onMaterialChange(material: WindowMaterial): void
  nativeEffectsEnabled?: boolean
}

export class UiWindow {
  private window: BrowserWindow | null = null
  private ready = false
  private showRequested = false
  private releaseMaterial: (() => void) | null = null

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

  dispose(): void {
    this.releaseMaterial?.()
    this.releaseMaterial = null
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    this.ready = false
    const window = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 640,
      minHeight: 520,
      show: false,
      backgroundColor: OPAQUE_WINDOW_BACKGROUND,
      visualEffectState: 'followWindow',
      title: 'Jarvis',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.window = window
    this.releaseMaterial = watchWindowMaterial(
      window,
      nativeTheme,
      process.platform,
      release(),
      this.options.onMaterialChange,
      this.options.nativeEffectsEnabled === true
    )
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
        this.dispose()
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
