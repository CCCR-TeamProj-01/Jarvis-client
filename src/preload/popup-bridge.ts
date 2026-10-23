import { z } from 'zod'
import { resultSchema } from '../shared/contracts/common'
import {
  RecommendationAnswerSchema,
  RecommendationCardSchema
} from '../shared/contracts/recommendation'
import { POPUP_CHANNELS } from '../shared/ipc/channels'
import type { PopupApi } from '../shared/ipc/popup-api'

type EventListener = (event: unknown, value: unknown) => void
interface PopupTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: EventListener): unknown
  removeListener(channel: string, listener: EventListener): unknown
  send(channel: string, ...args: unknown[]): void
}

const CardOrNone = RecommendationCardSchema.nullable()
const ReceiptSchema = resultSchema(z.undefined())

const unavailable = {
  ok: false,
  error: { code: 'unavailable', message: '답을 보내지 못했어요. 잠시 후 다시 시도해 주세요.' }
} as const

/**
 * Only the popup page loads this. The card arriving from Main is validated before the page sees it,
 * and the page can send just two fixed messages back.
 */
export function createPopupBridge(ipc: PopupTransport): PopupApi {
  return {
    async getState() {
      const parsed = CardOrNone.safeParse(await ipc.invoke(POPUP_CHANNELS.snapshot))
      return parsed.success ? parsed.data : null
    },
    subscribe(listener) {
      let active = true
      const receive: EventListener = (_event, value) => {
        if (!active) return
        const parsed = CardOrNone.safeParse(value)
        if (parsed.success) listener(parsed.data)
      }
      ipc.on(POPUP_CHANNELS.state, receive)
      return () => {
        if (!active) return
        active = false
        ipc.removeListener(POPUP_CHANNELS.state, receive)
      }
    },
    async respond(recommendationId, answer) {
      // Checked here too, so a page that was tampered with cannot send what Main would refuse.
      const checked = RecommendationAnswerSchema.safeParse(answer)
      if (typeof recommendationId !== 'string' || !checked.success)
        return { ok: false, error: { code: 'invalid_input', message: '올바르지 않은 요청이에요.' } }
      try {
        const parsed = ReceiptSchema.safeParse(
          await ipc.invoke(POPUP_CHANNELS.respond, recommendationId, checked.data)
        )
        return parsed.success ? parsed.data : unavailable
      } catch {
        return unavailable
      }
    },
    resize(heightPx) {
      if (Number.isFinite(heightPx)) ipc.send(POPUP_CHANNELS.resize, Math.round(heightPx))
    }
  }
}
