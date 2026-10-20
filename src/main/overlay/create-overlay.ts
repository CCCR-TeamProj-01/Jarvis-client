import { BrowserWindow, ipcMain, screen } from 'electron'
import type { WebContents } from 'electron'
import type { ClientSnapshot, UiEvent } from '../../shared/contracts/interaction'
import type { ConversationNotice } from '../conversation/ports'
import type { GestureController } from '../gesture/gesture-controller'
import { registerOverlayIpc } from '../ipc/overlay-ipc'
import type { SpeechNotice } from '../speech/session/ports'
import { OverlayController } from './overlay-controller'
import { OverlayWindow } from './overlay-window'

interface OverlayWiring {
  entryUrl: string
  preloadPath: string
  interaction: {
    getSnapshot(): ClientSnapshot
    subscribe(listener: (event: UiEvent) => void): () => void
  }
  conversation: { subscribeNotices(listener: (notice: ConversationNotice) => void): () => void }
  speech: { subscribeNotices(listener: (notice: SpeechNotice) => void): () => void }
  gesture: Pick<GestureController, 'subscribeProblems' | 'subscribeClicks'>
  /** The stop button on a speaking pill. */
  stopConversation(): void
}

const schedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

/**
 * The usable area of one display (below the menu bar, above the Dock or taskbar); the main display
 * when it is unknown or has gone. macOS moves a window out from under the menu bar, which would push
 * the corner pill off the bottom of the screen if the full display were covered.
 */
function displayBounds(displayId: string | null) {
  const displays = screen.getAllDisplays()
  const match = displays.find((display) => String(display.id) === displayId)
  return (match ?? screen.getPrimaryDisplay()).workArea
}

/**
 * Builds the overlay and connects it to the app's own state. It watches the same snapshot the UI
 * gets and the same notices, and never starts or changes anything except through the one stop button.
 */
export function createOverlay(wiring: OverlayWiring): {
  controller: OverlayController
  dispose(): void
} {
  let contents: WebContents | null = null
  const window = new OverlayWindow({
    entryUrl: wiring.entryUrl,
    displayBounds,
    create: () => {
      const created = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        // Showing status must never take the keyboard from whatever the user is working in.
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        fullscreenable: false,
        title: 'Jarvis Overlay',
        webPreferences: {
          preload: wiring.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false
        }
      })
      created.setAlwaysOnTop(true, 'screen-saver')
      // Skipping the process transform keeps the app's Dock icon; the overlay then follows the
      // user across desktops, and over full-screen apps where macOS allows it.
      created.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true
      })
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      created.webContents.on('will-navigate', (event) => event.preventDefault())
      created.webContents.on('will-redirect', (event) => event.preventDefault())
      const own = created.webContents
      contents = own
      created.on('closed', () => {
        if (contents === own) contents = null
      })
      return created
    }
  })
  const controller = new OverlayController({ window, schedule })

  const pushClient = (snapshot: ClientSnapshot) =>
    controller.setClientState({
      speechPhase: snapshot.speech.phase,
      requestProcessing: snapshot.request.phase === 'processing',
      gesture: snapshot.gesture,
      recognitionPaused: snapshot.recognitionPaused
    })
  pushClient(wiring.interaction.getSnapshot())
  const stops = [
    wiring.interaction.subscribe((event) => {
      if (event.type === 'state.changed') pushClient(event.snapshot)
    }),
    wiring.conversation.subscribeNotices((notice) => {
      if (notice.type === 'tool') controller.toolResult(notice.ok, notice.text)
      else if (notice.type === 'problem') controller.problem(notice.error.message)
    }),
    wiring.speech.subscribeNotices((notice) => {
      if (notice.type === 'problem') controller.problem(notice.error.message)
    }),
    wiring.gesture.subscribeProblems((error) => controller.problem(error.message)),
    wiring.gesture.subscribeClicks(() => controller.click()),
    registerOverlayIpc({
      ipc: ipcMain,
      getContents: () => contents,
      entryUrl: wiring.entryUrl,
      getState: () => window.getState(),
      setInteractive: (interactive) => window.setInteractive(interactive),
      stop: () => {
        if (window.hasStoppable()) wiring.stopConversation()
      }
    })
  ]
  return {
    controller,
    dispose() {
      for (const stop of stops) stop()
      controller.dispose()
    }
  }
}
