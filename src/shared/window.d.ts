import type { InteractionUiApi } from './ipc/ui-api'
import type { BootstrapMediaApi } from './ipc/media-api'

declare global {
  interface Window {
    jarvis: InteractionUiApi
    jarvisMedia: BootstrapMediaApi
  }
}
