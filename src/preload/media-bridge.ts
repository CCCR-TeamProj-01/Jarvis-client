import { MediaCommandEnvelopeSchema, MediaEventSchema } from '../shared/ipc/media-api'
import type { MediaApi } from '../shared/ipc/media-api'
import { MEDIA_CHANNELS } from '../shared/ipc/channels'

type EventListener = (event: unknown, value: unknown) => void
interface MediaTransport {
  on(channel: string, listener: EventListener): unknown
  removeListener(channel: string, listener: EventListener): unknown
  send(channel: string, ...args: unknown[]): void
}

/**
 * Only the Media Renderer loads this bridge. It forwards validated commands from Main and
 * publishes validated events back; it exposes no generic send/invoke surface.
 */
export function createMediaBridge(ipc: MediaTransport, platform: string): MediaApi {
  return {
    platform,
    subscribeCommands(listener) {
      let active = true
      const receive: EventListener = (_event, value) => {
        if (!active) return
        const parsed = MediaCommandEnvelopeSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      }
      ipc.on(MEDIA_CHANNELS.command, receive)
      return () => {
        if (!active) return
        active = false
        ipc.removeListener(MEDIA_CHANNELS.command, receive)
      }
    },
    publish(event) {
      const parsed = MediaEventSchema.safeParse(event)
      if (parsed.success) ipc.send(MEDIA_CHANNELS.event, parsed.data)
    }
  }
}
