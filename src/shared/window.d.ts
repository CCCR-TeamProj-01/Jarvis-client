import type { UiApi } from './ipc/ui-api'
import type { MediaApi } from './ipc/media-api'

declare global {
  interface Window {
    jarvis: UiApi
    jarvisMedia: MediaApi
  }
}
