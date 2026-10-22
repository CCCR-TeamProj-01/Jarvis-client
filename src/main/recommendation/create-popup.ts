import { BrowserWindow, ipcMain, screen } from 'electron'
import type { WebContents } from 'electron'
import type { Result } from '../../shared/contracts/common'
import type { ClientSnapshot, UiCommand, UiEvent } from '../../shared/contracts/interaction'
import type { CommandReceipt } from '../../shared/contracts/interaction'
import { registerPopupIpc } from '../ipc/popup-ipc'
import { PopupWindow, POPUP_WIDTH_PX } from './popup-window'

interface PopupWiring {
  entryUrl: string
  preloadPath: string
  interaction: {
    getSnapshot(): ClientSnapshot
    subscribe(listener: (event: UiEvent) => void): () => void
    dispatch(command: UiCommand): Promise<Result<CommandReceipt>>
  }
}

/** The card to show for a snapshot: only a signed-in user is offered anything. */
function cardOf(snapshot: ClientSnapshot) {
  return snapshot.auth.phase === 'signed_in' ? (snapshot.recommendation ?? null) : null
}

/**
 * Builds the recommendation popup and connects it to the app's own state. It watches the same
 * snapshot the main window gets, and the only thing it can do is send the user's answer back
 * through the same command the window would use.
 */
export function createRecommendationPopup(wiring: PopupWiring): { dispose(): void } {
  let contents: WebContents | null = null
  const popup = new PopupWindow({
    entryUrl: wiring.entryUrl,
    workArea: () => screen.getPrimaryDisplay().workArea,
    create: () => {
      const created = new BrowserWindow({
        show: false,
        width: POPUP_WIDTH_PX,
        height: 220,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        fullscreenable: false,
        title: 'Jarvis 추천',
        // On macOS a panel is shown without making the app the active one, so a recommendation
        // never takes the keyboard from the app the user is working in; clicking it still works.
        ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
        // The first click on a popup that was shown without focus must press the button.
        acceptFirstMouse: true,
        webPreferences: {
          preload: wiring.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false
        }
      })
      created.setAlwaysOnTop(true, 'floating')
      created.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
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

  popup.apply(cardOf(wiring.interaction.getSnapshot()))
  const stops = [
    wiring.interaction.subscribe((event) => {
      if (event.type === 'state.changed') popup.apply(cardOf(event.snapshot))
    }),
    registerPopupIpc({
      ipc: ipcMain,
      getContents: () => contents,
      entryUrl: wiring.entryUrl,
      getState: () => popup.getState(),
      respond: async (recommendationId, response) => {
        const answered = await wiring.interaction.dispatch({
          type: 'recommendation.respond',
          recommendationId,
          response
        })
        return answered.ok ? { ok: true, value: undefined } : answered
      },
      resize: (heightPx) => popup.setHeight(heightPx)
    })
  ]
  return {
    dispose() {
      for (const stop of stops) stop()
      popup.dispose()
    }
  }
}
