import type { UiApi } from './ipc/ui-api'
import type { MediaApi } from './ipc/media-api'
import type { OverlayApi } from './ipc/overlay-api'
import type { PopupApi } from './ipc/popup-api'

declare global {
  interface Window {
    jarvis: UiApi
    jarvisMedia: MediaApi
    jarvisOverlay: OverlayApi
    jarvisPopup: PopupApi
  }
}
