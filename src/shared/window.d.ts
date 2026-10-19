import type { BootstrapUiApi } from './ipc/ui-api'
import type { BootstrapMediaApi } from './ipc/media-api'

declare global {
  interface Window {
    jarvis: BootstrapUiApi
    jarvisMedia: BootstrapMediaApi
  }
}
