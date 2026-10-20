import type { UiApi } from './ipc/ui-api'
import type { BootstrapMediaApi } from './ipc/media-api'

declare global {
  interface Window {
    jarvis: UiApi
    jarvisMedia: BootstrapMediaApi
  }
}
