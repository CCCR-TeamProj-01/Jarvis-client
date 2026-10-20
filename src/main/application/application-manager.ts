import { app, dialog, ipcMain, session } from 'electron'
import type { Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AuthManager } from '../auth/auth-manager'
import { createDefaultAuth } from '../auth/create-auth'
import { ConversationManager } from '../conversation/conversation-manager'
import { createGestureController } from '../gesture/create-gesture'
import type { GestureController } from '../gesture/gesture-controller'
import { loadHandModel } from '../gesture/hand-model'
import { HandTrackingService } from '../gesture/hand-tracking'
import { InteractionManager } from '../interaction/interaction-manager'
import type { ActivationSource } from '../interaction/ports'
import { registerAuthIpc } from '../ipc/auth-ipc'
import { registerMediaIpc } from '../ipc/media-ipc'
import { registerUiIpc } from '../ipc/ui-ipc'
import { createOverlay } from '../overlay/create-overlay'
import { createSensorStack, isFakeMediaEnabled } from '../sensors/create-sensors'
import type { SensorStack } from '../sensors/create-sensors'
import { installMediaPermissionPolicy } from '../sensors/media-permissions'
import { createSensorGate } from '../sensors/sensor-gate'
import type { SensorManager } from '../sensors/sensor-manager'
import { createVoiceStack } from '../speech/create-voice'
import type { VoiceStack } from '../speech/create-voice'
import { createRemoteSpeech } from '../speech/remote-speech/create-remote-speech'
import { createToolStack } from '../tools/create-tools'
import type { ToolStack } from '../tools/create-tools'
import { startDevSelfTests } from './dev-selftests'
import { releaseAll } from './release-all'
import { DEFAULT_CALL_SHORTCUT, registerShortcuts } from './shortcuts'
import { connectAppState } from './state-sync'
import { createAppTray } from './tray'
import { UiWindow } from './ui-window'

export { DEFAULT_CALL_SHORTCUT, GESTURE_TOGGLE_SHORTCUT } from './shortcuts'
export { trayClickOpensWindow } from './tray'

export interface ApplicationDependencies {
  auth?: AuthManager
  /** Defaults are derived from the UI entry URL and preload path (`/ui/` -> `/media/`). */
  media?: { entryUrl: string; preloadPath: string }
}

export class ApplicationManager {
  readonly interaction: InteractionManager
  readonly auth: AuthManager
  readonly sensors: SensorManager
  readonly tools: ToolStack
  readonly voice: VoiceStack
  readonly handTracking: HandTrackingService
  readonly gesture: GestureController
  readonly conversation: ConversationManager
  private readonly sensorStack: SensorStack
  private readonly window: UiWindow
  private tray: Tray | null = null
  private disposeIpc: (() => void) | null = null
  private disposeAuthIpc: (() => void) | null = null
  private disposeMediaIpc: (() => void) | null = null
  private disposeState: (() => void) | null = null
  private disposeOverlay: (() => void) | null = null
  private disposeShortcuts: (() => void) | null = null
  private disposeSelfTests: (() => void) | null = null
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
    this.tools = createToolStack(this.auth)
    const mediaEntryUrl =
      dependencies.media?.entryUrl ?? entryUrl.replace(/\/ui\/index\.html$/, '/media/index.html')
    const mediaPreloadPath =
      dependencies.media?.preloadPath ?? preloadPath.replace(/ui\.js$/, 'media.js')
    const sensorGate = createSensorGate(
      this.auth,
      () => this.interaction.getSnapshot().recognitionPaused
    )
    this.sensorStack = createSensorStack({
      mediaEntryUrl,
      mediaPreloadPath,
      isQuitting: () => this.quitting,
      gate: sensorGate
    })
    this.sensors = this.sensorStack.sensors
    const stack = this.sensorStack
    const server = createRemoteSpeech({ isPackaged: app.isPackaged, env: process.env })
    this.conversation = new ConversationManager({
      gate: sensorGate,
      assistant: server.assistant,
      tools: { executor: this.tools.executor, registry: this.tools.registry },
      clock: { now: () => performance.now() },
      createId: randomUUID,
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        timer.unref()
        return () => clearTimeout(timer)
      }
    })
    this.voice = createVoiceStack(stack, sensorGate, this.conversation, server.speech)
    this.handTracking = new HandTrackingService({
      sensors: this.sensors,
      bridge: stack.bridge,
      loadModel: loadHandModel
    })
    this.gesture = createGestureController({
      tracking: this.handTracking,
      gate: sensorGate,
      isPackaged: app.isPackaged,
      env: process.env
    })
    this.disposeMediaIpc = registerMediaIpc({
      ipc: ipcMain,
      getContents: () => stack.window.getContents(),
      entryUrl: mediaEntryUrl,
      bridge: stack.bridge
    })
    installMediaPermissionPolicy({
      session: session.defaultSession,
      getMediaContents: () => stack.window.getContents(),
      entryUrl: mediaEntryUrl,
      isKindPermitted: (kind) => this.sensors.permits(kind)
    })
    this.disposeState = connectAppState({
      auth: this.auth,
      interaction: this.interaction,
      sensors: this.sensors,
      tools: this.tools,
      voice: this.voice,
      conversation: this.conversation,
      gesture: this.gesture
    })
    // The status overlay watches the same state; it can be switched off while developing.
    if (app.isPackaged || process.env.JARVIS_NO_OVERLAY !== '1')
      this.disposeOverlay = createOverlay({
        entryUrl: entryUrl.replace(/\/ui\/index\.html$/, '/overlay/index.html'),
        preloadPath: preloadPath.replace(/ui\.js$/, 'overlay.js'),
        interaction: this.interaction,
        conversation: this.conversation,
        speech: this.voice.session,
        gesture: this.gesture,
        stopConversation: () => void this.interaction.dispatch({ type: 'conversation.stop' })
      }).dispose
  }

  start(): void {
    if (this.started || this.quitting) return
    this.started = true
    this.createTray()
    this.disposeShortcuts = registerShortcuts({
      call: () => this.activate('hotkey'),
      toggleGesture: () => {
        const running = this.interaction.getSnapshot().gesture.phase !== 'off'
        void this.interaction.dispatch({ type: running ? 'gesture.stop' : 'gesture.start' })
      },
      report: (state) => this.interaction.setShortcutState(state)
    })
    this.window.open()
    this.disposeSelfTests = startDevSelfTests({
      isPackaged: app.isPackaged,
      env: process.env,
      auth: this.auth,
      sensors: this.sensors,
      voice: this.voice,
      conversation: this.conversation,
      handTracking: this.handTracking,
      tools: this.tools
    })
    void this.auth.start()
  }

  /** The call: start a conversation with the voice side (hotkey). It does not open the window. */
  activate(source: ActivationSource): void {
    if (this.quitting) return
    // Record where the user was before Jarvis takes the foreground, so "go back" has a target.
    if (this.auth.isSignedIn()) void this.tools.restoreTracker.capture()
    void this.interaction.activateConversation(source)
  }

  /**
   * Brings the window up: a second launch, the Dock icon, the tray icon or its menu. Opening the
   * app is a different thing from calling it, so this never starts a conversation. Where the user
   * was is noted first, because the window takes the foreground.
   */
  showWindow(): void {
    if (this.quitting) return
    if (!this.auth.isSignedIn()) {
      this.window.open()
      return
    }
    void this.tools.restoreTracker
      .capture()
      .catch(() => undefined)
      .finally(() => this.window.open())
  }

  hasTray(): boolean {
    return this.tray !== null && !this.tray.isDestroyed()
  }

  dispose(): void {
    if (this.quitting) return
    this.quitting = true
    const tray = this.tray
    this.tray = null
    const take = (
      name:
        | 'disposeIpc'
        | 'disposeAuthIpc'
        | 'disposeMediaIpc'
        | 'disposeState'
        | 'disposeOverlay'
        | 'disposeShortcuts'
        | 'disposeSelfTests'
    ) => {
      const release = this[name]
      this[name] = null
      return () => release?.()
    }
    // A failed release must not prevent remaining resources from being released.
    releaseAll([
      take('disposeShortcuts'),
      take('disposeIpc'),
      take('disposeAuthIpc'),
      take('disposeState'),
      take('disposeSelfTests'),
      take('disposeOverlay'),
      take('disposeMediaIpc'),
      () => {
        // Releases devices through the media window, then the window itself goes away.
        void this.voice.session.stop()
        void this.conversation.end()
        void this.gesture.stop()
        this.handTracking.dispose()
        this.voice.playback.dispose()
        this.voice.router.dispose()
        this.voice.vad.dispose()
        void this.sensors.dispose()
        this.sensorStack.window.dispose()
        this.sensorStack.bridge.dispose()
        this.sensorStack.hardware.dispose()
      },
      () => this.auth.dispose(),
      () => this.window.dispose(),
      () => {
        if (tray && !tray.isDestroyed()) tray.destroy()
      },
      () => this.interaction.dispose()
    ])()
  }

  private createTray(): void {
    this.tray = createAppTray(
      {
        showWindow: () => this.showWindow(),
        startConversation: () => this.activate('tray'),
        dispatch: (command) => void this.interaction.dispatch(command),
        quit: () => app.quit()
      },
      process.platform
    )
    this.interaction.setTrayState(
      this.tray
        ? { status: 'ready' }
        : {
            status: 'unavailable',
            error: {
              code: 'unavailable',
              message: '트레이를 사용할 수 없습니다. 창의 앱 종료 버튼을 이용해 주세요.'
            }
          }
    )
  }
}

export function startApplication(): void {
  app.setName('Jarvis')
  if (isFakeMediaEnabled()) {
    // Development only: synthetic camera/microphone. The permission handler stays authoritative;
    // Chromium's fake-UI switch is deliberately not used because it would bypass that handler.
    app.commandLine.appendSwitch('use-fake-device-for-media-stream')
    // Optionally play a WAV file as the microphone, once (for exercising capture and VAD).
    // Optionally play a video as the camera, for exercising hand tracking.
    const fakeVideo = process.env.JARVIS_FAKE_VIDEO_FILE
    if (fakeVideo) app.commandLine.appendSwitch('use-file-for-fake-video-capture', fakeVideo)
    const fakeAudio = process.env.JARVIS_FAKE_AUDIO_FILE
    if (fakeAudio)
      app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${fakeAudio}%noloop`)
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  let manager: ApplicationManager | null = null
  let quitting = false
  app.on('second-instance', () => manager?.showWindow())
  app.on('activate', () => manager?.showWindow())
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
