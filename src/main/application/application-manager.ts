import { app, dialog, ipcMain, session, shell } from 'electron'
import type { Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AuthManager } from '../auth/auth-manager'
import { createDefaultAuth } from '../auth/create-auth'
import { runWhileSignedIn } from '../auth/run-while-signed-in'
import { createCalendar } from '../calendar/create-calendar'
import { createDeviceManagement } from '../devices/create-device-management'
import { createCommandService } from '../commands/create-command-service'
import { createGoogleConnection } from '../google-connection/create-google-connection'
import { ConversationManager } from '../conversation/conversation-manager'
import { createGestureController } from '../gesture/create-gesture'
import type { GestureController } from '../gesture/gesture-controller'
import { loadHandModel } from '../gesture/hand-model'
import { HandTrackingService } from '../gesture/hand-tracking'
import { InteractionManager } from '../interaction/interaction-manager'
import type { ActivationSource } from '../interaction/ports'
import { registerAuthIpc } from '../ipc/auth-ipc'
import { registerCalendarIpc } from '../ipc/calendar-ipc'
import { registerDevicesIpc } from '../ipc/devices-ipc'
import { registerGoogleIpc } from '../ipc/google-ipc'
import { registerMediaIpc } from '../ipc/media-ipc'
import { registerUiIpc } from '../ipc/ui-ipc'
import { createOverlay } from '../overlay/create-overlay'
import { createSensorStack, isFakeMediaEnabled } from '../sensors/create-sensors'
import type { SensorStack } from '../sensors/create-sensors'
import { installMediaPermissionPolicy } from '../sensors/media-permissions'
import { createSensorGate } from '../sensors/sensor-gate'
import { createLocalState } from '../settings/create-local-state'
import { NodeLocalFiles } from '../settings/node-local-files'
import type { LocalStatePort } from '../settings/ports'
import type { SensorManager } from '../sensors/sensor-manager'
import { createVoiceStack } from '../speech/create-voice'
import { createWakeWord } from '../speech/create-wake-word'
import type { VoiceStack } from '../speech/create-voice'
import { createRemoteSpeech } from '../speech/remote-speech/create-remote-speech'
import { createRecommendationService } from '../recommendation/create-recommendation-service'
import { createRecommendationPopup } from '../recommendation/create-popup'
import { createOpenAppsCheck } from '../recommendation/open-apps'
import { ToolNotices } from '../tools/tool-notices'
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
  localState?: LocalStatePort
  /** Defaults are derived from the UI entry URL and preload path (`/ui/` -> `/media/`). */
  media?: { entryUrl: string; preloadPath: string }
}

export class ApplicationManager {
  readonly interaction: InteractionManager
  readonly auth: AuthManager
  readonly localState: LocalStatePort
  readonly sensors: SensorManager
  readonly tools: ToolStack
  /** Where the results of what the server's commands did here are announced. */
  private readonly toolNotices = new ToolNotices()
  readonly voice: VoiceStack
  readonly handTracking: HandTrackingService
  readonly gesture: GestureController
  readonly conversation: ConversationManager
  private readonly sensorStack: SensorStack
  private readonly window: UiWindow
  private tray: Tray | null = null
  private disposeIpc: (() => void) | null = null
  private disposeAuthIpc: (() => void) | null = null
  private disposeCalendarIpc: (() => void) | null = null
  private disposeCalendar: (() => void) | null = null
  private disposeGoogleIpc: (() => void) | null = null
  private disposeGoogle: (() => void) | null = null
  private disposeDevicesIpc: (() => void) | null = null
  private disposeDevices: (() => void) | null = null
  private disposeMediaIpc: (() => void) | null = null
  private disposeState: (() => void) | null = null
  private disposeOverlay: (() => void) | null = null
  private disposeShortcuts: (() => void) | null = null
  private disposeSelfTests: (() => void) | null = null
  private disposeCommands: (() => void) | null = null
  private disposeRecommendations: (() => void) | null = null
  private disposePopup: (() => void) | null = null
  private disposeWakeWord: (() => void) | null = null
  private quitting = false
  private startPromise: Promise<void> | null = null
  private ready = false

  constructor(entryUrl: string, preloadPath: string, dependencies: ApplicationDependencies = {}) {
    this.localState = dependencies.localState ?? createLocalState()
    // The installation key is read when a login or recovery needs it, after the state is loaded.
    const login =
      dependencies.auth === undefined
        ? createDefaultAuth({ deviceKey: () => this.localState.getSnapshot()?.deviceKey ?? null })
        : { auth: dependencies.auth, api: null }
    this.auth = login.auth
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
    // The server's recommendations are offered while someone is signed in and nothing else is going on.
    const recommendations = createRecommendationService({
      isPackaged: app.isPackaged,
      env: process.env,
      api: login.api,
      canShow: () => {
        const state = this.interaction.getSnapshot()
        return state.conversation.phase === 'idle' && state.speech.phase === 'idle'
      },
      // Apps that are already open are not worth suggesting. `tools` is built a little later.
      alreadyOpen: (targets) =>
        createOpenAppsCheck(this.tools.appControl, process.platform)(targets),
      publish: (card) => this.interaction.setRecommendationState(card)
    })
    if (recommendations) {
      this.interaction.setRecommendationHandler((id, response) =>
        recommendations.respond(id, response)
      )
      this.disposeRecommendations = runWhileSignedIn(this.auth, recommendations)
      // The recommendation appears in its own small window, so it is seen even when the main window is hidden.
      this.disposePopup = createRecommendationPopup({
        entryUrl: entryUrl.replace(/\/ui\/index\.html$/, '/popup/index.html'),
        preloadPath: preloadPath.replace(/ui\.js$/, 'popup.js'),
        interaction: this.interaction
      }).dispose
    }
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
    // The calendar tab reads the server while someone is signed in; without a server it says so.
    const { service: calendarService, calendar } = createCalendar({
      isPackaged: app.isPackaged,
      env: process.env,
      api: login.api
    })
    if (calendarService) this.disposeCalendar = runWhileSignedIn(this.auth, calendarService)
    this.disposeCalendarIpc = registerCalendarIpc({
      ipc: ipcMain,
      getContents: () => this.window.getContents(),
      entryUrl,
      calendar
    })
    // The Google Calendar connection: its own state, and the calendar is read again when it changes what is shown.
    const { service: googleService, connection: google } = createGoogleConnection({
      isPackaged: app.isPackaged,
      env: process.env,
      api: login.api,
      openExternal: (url) => shell.openExternal(url),
      onCalendarChanged: () => void calendarService?.refreshIfShown()
    })
    if (googleService) this.disposeGoogle = runWhileSignedIn(this.auth, googleService)
    this.disposeGoogleIpc = registerGoogleIpc({
      ipc: ipcMain,
      getContents: () => this.window.getContents(),
      entryUrl,
      google
    })
    // The devices of the account and this device's apps: signing out everywhere ends this session too.
    const { service: devicesService, devices } = createDeviceManagement({
      isPackaged: app.isPackaged,
      env: process.env,
      api: login.api,
      endLocalSession: () => this.auth.signOut()
    })
    if (devicesService) this.disposeDevices = runWhileSignedIn(this.auth, devicesService)
    this.disposeDevicesIpc = registerDevicesIpc({
      ipc: ipcMain,
      getContents: () => this.window.getContents(),
      entryUrl,
      devices
    })
    this.tools = createToolStack(this.auth)
    // Commands the server sends to this device are received while someone is signed in.
    const commands = login.api
      ? createCommandService({
          isPackaged: app.isPackaged,
          env: process.env,
          api: login.api,
          executor: this.tools.executor,
          files: new NodeLocalFiles(app.getPath('userData')),
          appControl: this.tools.appControl,
          announce: (notice) => this.toolNotices.publish(notice),
          platform: process.platform
        })
      : null
    if (commands) this.disposeCommands = runWhileSignedIn(this.auth, commands)
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
    const server = createRemoteSpeech({
      isPackaged: app.isPackaged,
      env: process.env,
      api: login.api,
      speechOutputEnabled: () =>
        this.localState.getSnapshot()?.settings.speechOutputEnabled ?? false
    })
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
    this.voice = createVoiceStack(
      stack,
      sensorGate,
      this.conversation,
      server.speech,
      () => this.localState.getSnapshot()?.settings.speechOutputEnabled ?? false
    )
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
      gesture: this.gesture,
      toolNotices: this.toolNotices
    })
    // The status overlay watches the same state; it can be switched off while developing.
    if (app.isPackaged || process.env.JARVIS_NO_OVERLAY !== '1')
      this.disposeOverlay = createOverlay({
        entryUrl: entryUrl.replace(/\/ui\/index\.html$/, '/overlay/index.html'),
        preloadPath: preloadPath.replace(/ui\.js$/, 'overlay.js'),
        interaction: this.interaction,
        conversation: this.conversation,
        speech: this.voice.session,
        toolNotices: this.toolNotices,
        gesture: this.gesture,
        stopConversation: () => void this.interaction.dispatch({ type: 'conversation.stop' })
      }).dispose
  }

  start(): Promise<void> {
    if (this.quitting) return this.startPromise ?? Promise.resolve()
    return (this.startPromise ??= this.initializeAndStart())
  }

  private async initializeAndStart(): Promise<void> {
    const initialized = await this.localState.initialize()
    if (this.quitting) return
    if (!initialized.ok) {
      dialog.showErrorBox('기기 정보를 준비하지 못했습니다', initialized.error.message)
      app.quit()
      return
    }
    this.ready = true
    this.disposeWakeWord = createWakeWord({
      auth: this.auth,
      interaction: this.interaction,
      sensors: this.sensors,
      voice: this.voice,
      capturePreviousApp: () => {
        void this.tools.restoreTracker.capture().catch(() => undefined)
      }
    })
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
    if (this.quitting || !this.ready) return
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
    if (this.quitting || !this.ready) return
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
        | 'disposeCalendarIpc'
        | 'disposeCalendar'
        | 'disposeGoogleIpc'
        | 'disposeGoogle'
        | 'disposeDevicesIpc'
        | 'disposeDevices'
        | 'disposeMediaIpc'
        | 'disposeState'
        | 'disposeOverlay'
        | 'disposeShortcuts'
        | 'disposeSelfTests'
        | 'disposeCommands'
        | 'disposeRecommendations'
        | 'disposePopup'
        | 'disposeWakeWord'
    ) => {
      const release = this[name]
      this[name] = null
      return () => release?.()
    }
    // A failed release must not prevent remaining resources from being released.
    releaseAll([
      take('disposeWakeWord'),
      take('disposeShortcuts'),
      take('disposeIpc'),
      take('disposeAuthIpc'),
      take('disposeCalendarIpc'),
      take('disposeCalendar'),
      take('disposeGoogleIpc'),
      take('disposeGoogle'),
      take('disposeDevicesIpc'),
      take('disposeDevices'),
      take('disposeState'),
      take('disposeSelfTests'),
      take('disposeCommands'),
      take('disposeRecommendations'),
      take('disposePopup'),
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
    .then(async () => {
      if (quitting) return
      const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
      const entryUrl = devUrl
        ? new URL('/ui/index.html', devUrl).href
        : pathToFileURL(join(__dirname, '../renderer/ui/index.html')).href
      manager = new ApplicationManager(entryUrl, join(__dirname, '../preload/ui.js'))
      await manager.start()
    })
    .catch(() => {
      dialog.showErrorBox('자비스를 시작하지 못했습니다', '앱을 다시 실행해 주세요.')
      app.quit()
    })
}
