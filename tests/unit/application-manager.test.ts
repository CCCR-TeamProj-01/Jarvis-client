import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    static windows: Window[] = []
    static getAllWindows() {
      return Window.windows.filter((window) => !window.destroyed)
    }
    private destroyed = false
    private visible = false
    private minimized = false
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' },
      setWindowOpenHandler: vi.fn<(handler: unknown) => void>(),
      isDestroyed: () => this.destroyed,
      send: vi.fn<(channel: string, value: unknown) => void>()
    })
    constructor(readonly options: unknown) {
      super()
      Window.windows.push(this)
    }
    async loadURL(url: string) {
      this.webContents.mainFrame.url = url
      queueMicrotask(() => this.emit('ready-to-show'))
    }
    isDestroyed() {
      return this.destroyed
    }
    isVisible() {
      return this.visible
    }
    isMinimized() {
      return this.minimized
    }
    minimize() {
      this.minimized = true
    }
    restore() {
      this.minimized = false
    }
    show() {
      this.visible = true
    }
    focus() {}
    hide() {
      this.visible = false
    }
    close() {
      let prevented = false
      this.emit('close', {
        preventDefault: () => {
          prevented = true
        }
      })
      if (!prevented) this.destroy()
    }
    destroy() {
      this.destroyed = true
      this.visible = false
      this.emit('closed')
    }
  }
  const app = Object.assign(new EventEmitter(), {
    setName: vi.fn<(name: string) => void>(),
    isPackaged: false,
    requestSingleInstanceLock: vi.fn<() => boolean>(() => true),
    whenReady: vi.fn<() => Promise<void>>(async () => undefined),
    quit: vi.fn<() => void>(() => {
      app.emit('before-quit', {})
      for (const window of Window.getAllWindows()) window.close()
      app.emit('will-quit', {})
    })
  })
  class FakeTray extends EventEmitter {
    private destroyed = false
    setToolTip = vi.fn<(text: string) => void>()
    setContextMenu = vi.fn<(menu: unknown) => void>()
    isDestroyed = () => this.destroyed
    destroy = vi.fn<() => void>(() => {
      this.destroyed = true
    })
  }
  const Tray = vi.fn<typeof FakeTray>(FakeTray)
  return {
    app,
    BrowserWindow: Window,
    Tray,
    globalShortcut: {
      register: vi.fn<(accelerator: string, callback: () => void) => boolean>(() => true),
      unregister: vi.fn<(accelerator: string) => void>()
    },
    ipcMain: {
      handle: vi.fn<(channel: string, listener: unknown) => void>(),
      removeHandler: vi.fn<(channel: string) => void>()
    },
    Menu: { buildFromTemplate: vi.fn<(items: unknown) => unknown>((items) => items) },
    dialog: { showErrorBox: vi.fn<(title: string, content: string) => void>() },
    nativeImage: {
      createFromBuffer: vi.fn<
        (
          buffer: Buffer,
          options?: unknown
        ) => { isEmpty(): boolean; setTemplateImage(value: boolean): void }
      >(() => ({ isEmpty: () => false, setTemplateImage: vi.fn<(value: boolean) => void>() }))
    }
  }
})

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Tray } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  ApplicationManager,
  DEFAULT_CALL_SHORTCUT,
  startApplication
} from '../../src/main/application/application-manager'
import { UI_CHANNELS } from '../../src/shared/ipc/channels'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const managers: ApplicationManager[] = []

beforeEach(() => {
  app.removeAllListeners()
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  vi.clearAllMocks()
  vi.mocked(app.requestSingleInstanceLock).mockReturnValue(true)
  vi.mocked(app.whenReady).mockResolvedValue()
  vi.mocked(globalShortcut.register).mockReturnValue(true)
  Object.assign(app, { isPackaged: false })
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
})

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  app.emit('before-quit', {})
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function makeManager() {
  const manager = new ApplicationManager('file:///jarvis/ui/index.html', '/jarvis/preload.js')
  managers.push(manager)
  return manager
}

describe('native application lifecycle', () => {
  it('exits a second process without creating windows, IPC handlers or a tray', async () => {
    vi.mocked(app.requestSingleInstanceLock).mockReturnValue(false)
    startApplication()
    await flush()
    expect(app.quit).toHaveBeenCalledOnce()
    expect(BrowserWindow.getAllWindows()).toHaveLength(0)
    expect(Tray).not.toHaveBeenCalled()
    expect(ipcMain.handle).not.toHaveBeenCalled()
  })

  it('hides on close and reuses the same window on another launch, Dock or shortcut', async () => {
    startApplication()
    await flush()
    const window = BrowserWindow.getAllWindows()[0]
    expect(window.isVisible()).toBe(true)
    window.close()
    expect(window.isDestroyed()).toBe(false)
    expect(window.isVisible()).toBe(false)
    app.emit('second-instance', {}, [], '')
    expect(window.isVisible()).toBe(true)
    window.close()
    app.emit('activate')
    expect(window.isVisible()).toBe(true)
    window.minimize()
    vi.mocked(globalShortcut.register).mock.calls[0][1]()
    expect(window.isMinimized()).toBe(false)
    expect(BrowserWindow.getAllWindows()).toEqual([window])
  })

  it('releases its shortcut, tray and IPC handlers when explicitly quitting', async () => {
    startApplication()
    await flush()
    const tray = vi.mocked(Tray).mock.results[0].value as Tray
    app.quit()
    expect(BrowserWindow.getAllWindows()).toHaveLength(0)
    expect(globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith(DEFAULT_CALL_SHORTCUT)
    expect(tray.destroy).toHaveBeenCalledOnce()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(UI_CHANNELS.command)
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(UI_CHANNELS.snapshot)
    app.emit('will-quit', {})
    expect(tray.destroy).toHaveBeenCalledOnce()
  })

  it('persists shortcut failure and keeps the tray as a working fallback', async () => {
    vi.mocked(globalShortcut.register).mockReturnValue(false)
    const manager = makeManager()
    manager.start()
    manager.start()
    await flush()
    expect(manager.interaction.getSnapshot().application.shortcut).toMatchObject({
      status: 'unavailable',
      error: { code: 'conflict' }
    })
    const window = BrowserWindow.getAllWindows()[0]
    window.close()
    const tray = vi.mocked(Tray).mock.results[0].value as Tray
    tray.emit('click')
    expect(window.isVisible()).toBe(true)
    expect(Tray).toHaveBeenCalledOnce()
    manager.dispose()
    expect(globalShortcut.unregister).not.toHaveBeenCalled()
  })

  it('does not hide the last reachable window if creating the tray fails', async () => {
    vi.mocked(Tray).mockImplementationOnce(() => {
      throw new Error('Tray unavailable')
    })
    startApplication()
    await flush()
    const window = BrowserWindow.getAllWindows()[0]
    window.close()
    expect(window.isVisible()).toBe(true)
    const snapshotHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === UI_CHANNELS.snapshot)![1]
    const result = await snapshotHandler({
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame
    } as IpcMainInvokeEvent)
    expect(result).toMatchObject({
      ok: true,
      value: { application: { tray: { status: 'unavailable' } } }
    })
    app.quit()
    expect(window.isDestroyed()).toBe(true)
  })

  it('does not recreate a window after disposal and continues cleanup after a release fails', async () => {
    const manager = makeManager()
    manager.start()
    await flush()
    const tray = vi.mocked(Tray).mock.results[0].value as Tray
    vi.mocked(globalShortcut.unregister).mockImplementationOnce(() => {
      throw new Error('Release failed')
    })
    manager.dispose()
    manager.dispose()
    const window = BrowserWindow.getAllWindows()[0]
    window.close()
    manager.activate('tray')
    expect(BrowserWindow.getAllWindows()).toHaveLength(0)
    expect(tray.destroy).toHaveBeenCalledOnce()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(UI_CHANNELS.snapshot)
  })

  it('does not initialize after quitting while app readiness is pending', async () => {
    let ready!: () => void
    vi.mocked(app.whenReady).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve
      })
    )
    startApplication()
    app.quit()
    ready()
    await flush()
    expect(BrowserWindow.getAllWindows()).toHaveLength(0)
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  it('quits and cleans up after a page load failure without exposing native error details', async () => {
    vi.spyOn(BrowserWindow.prototype, 'loadURL').mockRejectedValueOnce(
      new Error('Private filesystem path')
    )
    startApplication()
    await flush()
    expect(dialog.showErrorBox).toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(dialog.showErrorBox).mock.calls)).not.toContain(
      'Private filesystem'
    )
    expect(app.quit).toHaveBeenCalledOnce()
    expect(globalShortcut.unregister).toHaveBeenCalledOnce()
  })

  it('ignores a renderer URL override in a packaged application', async () => {
    Object.assign(app, { isPackaged: true })
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://untrusted.example/')
    startApplication()
    await flush()
    expect(BrowserWindow.getAllWindows()[0].webContents.mainFrame.url).toMatch(/^file:/)
  })
})
