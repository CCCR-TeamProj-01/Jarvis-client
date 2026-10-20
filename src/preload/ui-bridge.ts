import type { Result } from '../shared/contracts/common'
import { UiCommandSchema, UiEventSchema } from '../shared/contracts/interaction'
import { UI_CHANNELS } from '../shared/ipc/channels'
import { UiCommandResponseSchema, UiSnapshotResponseSchema } from '../shared/ipc/ui-api'
import type { InteractionUiApi } from '../shared/ipc/ui-api'

type EventListener = (event: unknown, value: unknown) => void
interface UiTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: EventListener): unknown
  removeListener(channel: string, listener: EventListener): unknown
}

export function createUiBridge(ipc: UiTransport, platform: string): InteractionUiApi {
  async function invoke<T>(
    channel: string,
    decode: (value: unknown) => Result<T>,
    ...args: unknown[]
  ): Promise<Result<T>> {
    try {
      return decode(await ipc.invoke(channel, ...args))
    } catch {
      return {
        ok: false,
        error: { code: 'unavailable', message: '앱과 연결하지 못했습니다. 다시 시도해 주세요.' }
      }
    }
  }
  return {
    platform,
    dispatch(command) {
      const parsed = UiCommandSchema.safeParse(command)
      if (!parsed.success)
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid_input', message: '요청 형식이 올바르지 않습니다.' }
        })
      return invoke(
        UI_CHANNELS.command,
        (value) => UiCommandResponseSchema.parse(value),
        parsed.data
      )
    },
    getSnapshot: () =>
      invoke(UI_CHANNELS.snapshot, (value) => UiSnapshotResponseSchema.parse(value)),
    subscribe(listener) {
      let active = true
      const receive: EventListener = (_event, value) => {
        if (!active) return
        const parsed = UiEventSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      }
      ipc.on(UI_CHANNELS.event, receive)
      return () => {
        if (!active) return
        active = false
        ipc.removeListener(UI_CHANNELS.event, receive)
      }
    }
  }
}
