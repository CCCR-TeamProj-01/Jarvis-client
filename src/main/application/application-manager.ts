import { app, dialog, globalShortcut, ipcMain, Menu, session, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Result } from '../../shared/contracts/common'
import type { AuthManager } from '../auth/auth-manager'
import { createDefaultAuth } from '../auth/create-auth'
import { InteractionManager } from '../interaction/interaction-manager'
import type { ActivationSource } from '../interaction/ports'
import { registerAuthIpc } from '../ipc/auth-ipc'
import { registerMediaIpc } from '../ipc/media-ipc'
import { registerUiIpc } from '../ipc/ui-ipc'
import { createSensorStack, isFakeMediaEnabled } from '../sensors/create-sensors'
import type { SensorStack } from '../sensors/create-sensors'
import { createOverlay } from '../overlay/create-overlay'
import { createGestureController } from '../gesture/create-gesture'
import type { GestureController } from '../gesture/gesture-controller'
import { startHandSelfTest } from '../gesture/dev-hand-selftest'
import { HandTrackingService } from '../gesture/hand-tracking'
import { modelPath } from '../models'
import { startSensorSelfTest } from '../sensors/dev-selftest'
import { installMediaPermissionPolicy } from '../sensors/media-permissions'
import { createSensorGate } from '../sensors/sensor-gate'
import type { SensorManager } from '../sensors/sensor-manager'
import { ConversationManager } from '../conversation/conversation-manager'
import { createRemoteSpeech } from '../speech/remote-speech/create-remote-speech'
import { createVoiceStack } from '../speech/create-voice'
import type { VoiceStack } from '../speech/create-voice'
import { startSpeechSelfTest, startVoiceSelfTest } from '../speech/dev-voice-selftest'
import { createToolStack } from '../tools/create-tools'
import type { ToolStack } from '../tools/create-tools'
import { startToolSelfTest } from '../tools/dev-tool-selftest'
import { createTrayIcon } from './tray-icon'
import { UiWindow } from './ui-window'

export const DEFAULT_CALL_SHORTCUT = 'CommandOrControl+Shift+Space'
/** Turns gesture control on or off; the way to stop it at once without touching the pointer. */
export const GESTURE_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+G'

export interface ApplicationDependencies {
  auth?: AuthManager
  /** Defaults are derived from the UI entry URL and preload path (`/ui/` -> `/media/`). */
  media?: { entryUrl: string; preloadPath: string }
}

/** `0` (or `forever`) keeps tracking until sign-out or quit; otherwise the number of seconds. */
function parseHandSelfTestSeconds(value: string): number {
  if (value === 'forever') return 0
  const seconds = Number.parseInt(value, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 5
}

const HAND_MODEL_FILE = 'hand_landmarker.task'

async function loadHandModel(): Promise<Result<Uint8Array>> {
  try {
    return { ok: true, value: new Uint8Array(await readFile(modelPath(HAND_MODEL_FILE))) }
  } catch {
    // A missing model is a setup problem to name clearly rather than a mysterious engine failure.
    return {
      ok: false,
      error: {
        code: 'unavailable',
        message: '손 인식 모델이 없습니다. pnpm models:fetch로 내려받아 주세요.'
      }
    }
  }
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
  private recognitionWasPaused = false
  private disposeMediaIpc: (() => void) | null = null
  private disposeSensorSync: (() => void) | null = null
  private disposeSelfTest: (() => void) | null = null
  private disposeToolSelfTest: (() => void) | null = null
  private disposeVoiceSelfTest: (() => void) | null = null
  private disposeSpeechSelfTest: (() => void) | null = null
  private disposeHandSelfTest: (() => void) | null = null
  private disposeSpeechSync: (() => void) | null = null
  private disposeOverlay: (() => void) | null = null
  private readonly window: UiWindow
  private tray: Tray | null = null
  private shortcutRegistered = false
  private gestureShortcutRegistered = false
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
    // Main's authentication state is the source for the snapshot the UI and every entry point see.
    // Any change of generation (sign-out, expiry re-check, account switch) also ends sensor use.
    this.disposeAuthSync = this.auth.onGenerationChange((snapshot) => {
      this.interaction.setAuthSnapshot(snapshot)
      // The previous user's tool history, pending work and "go back" target must not carry over.
      this.tools.executor.resetForNewSession()
      this.tools.restoreTracker.clear()
      // A conversation belongs to the user who started it.
      void this.voice.session.stop()
      void this.conversation.end()
      void this.gesture.stop()
      void this.sensors.revokeAll({
        code: 'authentication_required',
        message: '로그인 상태가 변경되어 센서를 해제했습니다.'
      })
    })
    const stopSensorSnapshots = this.sensors.subscribe((event) => {
      if (event.type === 'sensor.state_changed')
        this.interaction.setSensors(this.sensors.getSnapshots())
    })
    const stopPauseWatch = this.interaction.subscribe((event) => {
      if (event.type !== 'state.changed') return
      const paused = event.snapshot.recognitionPaused
      if (paused && !this.recognitionWasPaused) {
        void this.voice.session.stop()
        void this.conversation.end()
        void this.gesture.stop()
      }
      if (paused && !this.recognitionWasPaused)
        void this.sensors.revokeAll({
          code: 'cancelled',
          message: '인식이 일시 중지되어 센서를 해제했습니다.'
        })
      this.recognitionWasPaused = paused
    })
    this.disposeSensorSync = () => {
      stopSensorSnapshots()
      stopPauseWatch()
    }
    // Commands, state and the words shown to the user all go through Main's interaction state.
    const speechSession = this.voice.session
    const conversation = this.conversation
    this.interaction.setConversationHandlers({
      // Starting means a conversation with the voice side attached (the call shortcut, tray, button).
      start: () => speechSession.activate('ui'),
      submitText: (text) => conversation.submit({ text, modality: 'text' }),
      stop: async () => {
        await speechSession.stop()
        return conversation.end()
      }
    })
    this.interaction.setGestureHandlers({
      start: () => this.gesture.start({ activeHand: 'auto_lock', displayId: 'primary' }),
      stop: () => this.gesture.stop()
    })
    const stopGestureState = this.gesture.subscribe((snapshot) =>
      this.interaction.setGestureState(snapshot)
    )
    const stopGestureProblems = this.gesture.subscribeProblems((error) =>
      this.interaction.publishNotice({ type: 'problem', error })
    )
    // The status overlay watches the same state; it can be switched off while developing.
    if (app.isPackaged || process.env.JARVIS_NO_OVERLAY !== '1')
      this.disposeOverlay = createOverlay({
        entryUrl: entryUrl.replace(/\/ui\/index\.html$/, '/overlay/index.html'),
        preloadPath: preloadPath.replace(/ui\.js$/, 'overlay.js'),
        interaction: this.interaction,
        conversation,
        speech: speechSession,
        gesture: this.gesture,
        stopConversation: () => void this.interaction.dispatch({ type: 'conversation.stop' })
      }).dispose
    const stopConversationState = conversation.subscribe((snapshot) => {
      this.interaction.setConversationState(snapshot)
      // Without a conversation there is nothing to listen for. A reply being worked on or spoken
      // is let finish (it may be the final one): the session ends on its own right after it.
      const phase = speechSession.getSnapshot().phase
      if (snapshot.phase === 'idle' && phase !== 'processing' && phase !== 'speaking')
        void speechSession.stop()
    })
    const stopSpeechState = speechSession.subscribe((snapshot) =>
      this.interaction.setSpeechState(snapshot)
    )
    const stopNotices = [
      conversation.subscribeNotices((notice) => this.interaction.publishNotice(notice)),
      speechSession.subscribeNotices((notice) => this.interaction.publishNotice(notice))
    ]
    this.disposeSpeechSync = () => {
      stopConversationState()
      stopSpeechState()
      stopGestureState()
      stopGestureProblems()
      for (const stop of stopNotices) stop()
      this.interaction.setConversationHandlers(null)
      this.interaction.setGestureHandlers(null)
    }
  }

  start(): void {
    if (this.started || this.quitting) return
    this.started = true
    this.createTray()
    this.registerShortcut()
    this.window.open()
    if (!app.isPackaged && process.env.JARVIS_SENSOR_SELFTEST === '1')
      this.disposeSelfTest = startSensorSelfTest(this.auth, this.sensors)
    if (!app.isPackaged && process.env.JARVIS_SPEECH_SELFTEST === '1')
      this.disposeSpeechSelfTest = startSpeechSelfTest(
        this.auth,
        this.voice.session,
        this.conversation
      )
    if (!app.isPackaged && process.env.JARVIS_VOICE_SELFTEST)
      this.disposeVoiceSelfTest = startVoiceSelfTest(
        Math.max(1, Number.parseInt(process.env.JARVIS_VOICE_SELFTEST, 10) || 1),
        this.auth,
        this.voice.input
      )
    if (!app.isPackaged && process.env.JARVIS_HAND_SELFTEST)
      this.disposeHandSelfTest = startHandSelfTest(
        parseHandSelfTestSeconds(process.env.JARVIS_HAND_SELFTEST),
        this.auth,
        this.handTracking
      )
    if (!app.isPackaged && process.env.JARVIS_TOOL_SELFTEST)
      this.disposeToolSelfTest = startToolSelfTest(
        process.env.JARVIS_TOOL_SELFTEST,
        this.auth,
        this.tools
      )
    void this.auth.start()
  }

  activate(source: ActivationSource): void {
    if (this.quitting) return
    // Record where the user was before Jarvis takes the foreground, so "go back" has a target.
    if (this.auth.isSignedIn()) void this.tools.restoreTracker.capture()
    void this.interaction.activateConversation(source)
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
    const releaseMediaIpc = this.disposeMediaIpc
    this.disposeMediaIpc = null
    const releaseSensorSync = this.disposeSensorSync
    this.disposeSensorSync = null
    const releaseSelfTest = this.disposeSelfTest
    this.disposeSelfTest = null
    const releaseToolSelfTest = this.disposeToolSelfTest
    this.disposeToolSelfTest = null
    const releaseVoiceSelfTest = this.disposeVoiceSelfTest
    this.disposeVoiceSelfTest = null
    const releaseSpeechSelfTest = this.disposeSpeechSelfTest
    this.disposeSpeechSelfTest = null
    const releaseHandSelfTest = this.disposeHandSelfTest
    this.disposeHandSelfTest = null
    const releaseSpeechSync = this.disposeSpeechSync
    this.disposeSpeechSync = null
    const releaseOverlay = this.disposeOverlay
    this.disposeOverlay = null
    const releaseShortcut = this.shortcutRegistered
    this.shortcutRegistered = false
    const releaseGestureShortcut = this.gestureShortcutRegistered
    this.gestureShortcutRegistered = false
    // A failed release must not prevent remaining resources from being released.
    for (const release of [
      () => {
        if (releaseShortcut) globalShortcut.unregister(DEFAULT_CALL_SHORTCUT)
      },
      () => {
        if (releaseGestureShortcut) globalShortcut.unregister(GESTURE_TOGGLE_SHORTCUT)
      },
      () => releaseIpc?.(),
      () => releaseAuthIpc?.(),
      () => releaseAuthSync?.(),
      () => releaseSelfTest?.(),
      () => releaseToolSelfTest?.(),
      () => releaseVoiceSelfTest?.(),
      () => releaseSpeechSelfTest?.(),
      () => releaseHandSelfTest?.(),
      () => releaseSpeechSync?.(),
      () => releaseOverlay?.(),
      () => releaseSensorSync?.(),
      () => releaseMediaIpc?.(),
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
            label: '제스처 시작',
            click: () => {
              void this.interaction.dispatch({ type: 'gesture.start' })
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
    try {
      this.gestureShortcutRegistered = globalShortcut.register(GESTURE_TOGGLE_SHORTCUT, () => {
        const running = this.interaction.getSnapshot().gesture.phase !== 'off'
        void this.interaction.dispatch({ type: running ? 'gesture.stop' : 'gesture.start' })
      })
    } catch {
      this.gestureShortcutRegistered = false
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
