import { OverlayStateSchema } from '../shared/contracts/overlay'
import { OVERLAY_CHANNELS } from '../shared/ipc/channels'
import type { OverlayApi } from '../shared/ipc/overlay-api'

type EventListener = (event: unknown, value: unknown) => void
interface OverlayTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: EventListener): unknown
  removeListener(channel: string, listener: EventListener): unknown
  send(channel: string, ...args: unknown[]): void
}

/**
 * Only the overlay page loads this. State arriving from Main is validated before the page sees it,
 * and the page can send just two fixed messages back.
 */
export function createOverlayBridge(ipc: OverlayTransport): OverlayApi {
  return {
    async getState() {
      const parsed = OverlayStateSchema.safeParse(await ipc.invoke(OVERLAY_CHANNELS.snapshot))
      return parsed.success ? parsed.data : { revision: 0, voice: null, gesture: null }
    },
    subscribe(listener) {
      let active = true
      const receive: EventListener = (_event, value) => {
        if (!active) return
        const parsed = OverlayStateSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      }
      ipc.on(OVERLAY_CHANNELS.state, receive)
      return () => {
        if (!active) return
        active = false
        ipc.removeListener(OVERLAY_CHANNELS.state, receive)
      }
    },
    setInteractive(interactive) {
      ipc.send(OVERLAY_CHANNELS.interactive, interactive === true)
    },
    stop() {
      ipc.send(OVERLAY_CHANNELS.stop)
    }
  }
}
