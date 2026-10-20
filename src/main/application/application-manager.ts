import { app, dialog, globalShortcut, ipcMain, Menu, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AuthManager } from '../auth/auth-manager'
import { createDefaultAuth } from '../auth/create-auth'
import { InteractionManager } from '../interaction/interaction-manager'
import type { ActivationSource } from '../interaction/ports'
import { registerAuthIpc } from '../ipc/auth-ipc'
import { registerUiIpc } from '../ipc/ui-ipc'
import { createTrayIcon } from './tray-icon'
import { UiWindow } from './ui-window'

export const DEFAULT_CALL_SHORTCUT = 'CommandOrControl+Shift+Space'

export interface ApplicationDependencies {
  auth?: AuthManager
}

export class ApplicationManager {
  readonly interaction: InteractionManager
  readonly auth: AuthManager
  private readonly window: UiWindow
  private tray: Tray | null = null
  private shortcutRegistered = false
  private disposeIpc: (() => void) | null = null
  private disposeAuthIpc: (() => void) | null = null
  private disposeAuthSync: (() => void) | null = null
  private quitting = false
  private started = false

  constructor(entryUrl: string, preloadPath: string, dependencies: ApplicationDependencies = {}) {
    this.auth = dependencies.auth ?? createDefaultAuth()
    this.window = new UiWindow({
      entryUrl,
      preloadPath,
      isQuitting: () => this.quitting,
      canHide: () => this.hasTray(),
      onMaterialChange: (material) => this.interaction.setWindowMaterial(material),
      nativeEffectsEnabled: !app.isPackaged && process.env.JARVIS_NATIVE_WINDOW_EFFECTS === '1',
      onLoadFailure: () => {
        if (this.quitting) return
        dialog.showErrorBox(
          '자비스를 열지 못했습니다',
          '화면을 불러오지 못했습니다. 앱을 다시 실행해 주세요.'
        )
        app.quit()
      }
    })
    this.interaction = new InteractionManager({
      auth: this.auth.getSnapshot(),
      accelerator: DEFAULT_CALL_SHORTCUT,
      createId: randomUUID,
      now: () => performance.now(),
      showWindow: () => this.window.open(),
      quit: () => app.quit()
    })
    this.disposeIpc = registerUiIpc({
      ipc: ipcMain,
      getContents: () => this.window.getContents(),
      entryUrl,
      interaction: this.interaction
    })
    this.disposeAuthIpc = registerAuthIpc({
      ipc: ipcMain,
      getContents: () => this.window.getContents(),
      entryUrl,
      auth: this.auth
    })
    // Main's authentication state is the source for the snapshot the UI and every entry point see.
    this.disposeAuthSync = this.auth.onGenerationChange((snapshot) =>
      this.interaction.setAuthSnapshot(snapshot)
    )
  }

  start(): void {
    if (this.started || this.quitting) return
    this.started = true
    this.createTray()
    this.registerShortcut()
    this.window.open()
    void this.auth.start()
  }

  activate(source: ActivationSource): void {
    if (!this.quitting) void this.interaction.activateConversation(source)
  }

  hasTray(): boolean {
    return this.tray !== null && !this.tray.isDestroyed()
  }

  dispose(): void {
    if (this.quitting) return
    this.quitting = true
    const tray = this.tray
    this.tray = null
    const releaseIpc = this.disposeIpc
    this.disposeIpc = null
    const releaseAuthIpc = this.disposeAuthIpc
    this.disposeAuthIpc = null
    const releaseAuthSync = this.disposeAuthSync
    this.disposeAuthSync = null
    const releaseShortcut = this.shortcutRegistered
    this.shortcutRegistered = false
    // A failed release must not prevent remaining resources from being released.
    for (const release of [
      () => {
        if (releaseShortcut) globalShortcut.unregister(DEFAULT_CALL_SHORTCUT)
      },
      () => releaseIpc?.(),
      () => releaseAuthIpc?.(),
      () => releaseAuthSync?.(),
      () => this.auth.dispose(),
      () => this.window.dispose(),
      () => {
        if (tray && !tray.isDestroyed()) tray.destroy()
      },
      () => this.interaction.dispose()
    ]) {
      try {
        release()
      } catch {
        /* Continue releasing this app's other resources. */
      }
    }
  }

  private createTray(): void {
    try {
      this.tray = new Tray(createTrayIcon())
      this.tray.setToolTip('자비스')
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '자비스 열기', click: () => this.activate('tray') },
          {
            label: '설정',
            click: () => {
              void this.interaction.dispatch({ type: 'settings.open' })
            }
          },
          { type: 'separator' },
          {
            label: '인식 일시 중지',
            click: () => {
              void this.interaction.dispatch({ type: 'recognition.pause' })
            }
          },
          {
            label: '인식 재개',
            click: () => {
              void this.interaction.dispatch({ type: 'recognition.resume' })
            }
          },
          {
            label: '제스처 중지',
            click: () => {
              void this.interaction.dispatch({ type: 'gesture.stop' })
            }
          },
          { type: 'separator' },
          { label: '앱 종료', click: () => app.quit() }
        ])
      )
      this.tray.on('click', () => this.activate('tray'))
      this.interaction.setTrayState({ status: 'ready' })
    } catch {
      if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
      this.tray = null
      this.interaction.setTrayState({
        status: 'unavailable',
        error: {
          code: 'unavailable',
          message: '트레이를 사용할 수 없습니다. 창의 앱 종료 버튼을 이용해 주세요.'
        }
      })
    }
  }

  private registerShortcut(): void {
    try {
      this.shortcutRegistered = globalShortcut.register(DEFAULT_CALL_SHORTCUT, () =>
        this.activate('hotkey')
      )
    } catch {
      this.shortcutRegistered = false
    }
    this.interaction.setShortcutState(
      this.shortcutRegistered
        ? { status: 'registered', accelerator: DEFAULT_CALL_SHORTCUT }
        : {
            status: 'unavailable',
            accelerator: DEFAULT_CALL_SHORTCUT,
            error: {
              code: 'conflict',
              message: '호출 단축키를 등록하지 못했습니다. 트레이에서 창을 열어 주세요.'
            }
          }
    )
  }
}

export function startApplication(): void {
  app.setName('Jarvis')
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  let manager: ApplicationManager | null = null
  let quitting = false
  app.on('second-instance', () => manager?.activate('hotkey'))
  app.on('activate', () => manager?.activate('hotkey'))
  app.on('before-quit', () => {
    quitting = true
    manager?.dispose()
  })
  app.on('will-quit', () => manager?.dispose())
  app.on('window-all-closed', () => {
    if (!manager?.hasTray()) app.quit()
  })
  void app
    .whenReady()
    .then(() => {
      if (quitting) return
      const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
      const entryUrl = devUrl
        ? new URL('/ui/index.html', devUrl).href
        : pathToFileURL(join(__dirname, '../renderer/ui/index.html')).href
      manager = new ApplicationManager(entryUrl, join(__dirname, '../preload/ui.js'))
      manager.start()
    })
    .catch(() => {
      dialog.showErrorBox('자비스를 시작하지 못했습니다', '앱을 다시 실행해 주세요.')
      app.quit()
    })
}
