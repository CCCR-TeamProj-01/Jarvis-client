import type { IpcMain, WebContents } from 'electron'
import type { z } from 'zod'
import type { Unsubscribe } from '../../shared/contracts/common'
import { isTrustedUiSender } from './ui-ipc'

interface CheckedIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getContents(): WebContents | null
  entryUrl: string
}

const denied = {
  ok: false,
  error: { code: 'permission_denied', message: '허용되지 않은 화면의 요청입니다.' }
} as const
const invalid = {
  ok: false,
  error: { code: 'invalid_input', message: '요청 형식이 올바르지 않습니다.' }
} as const
const failed = {
  ok: false,
  error: { code: 'internal', message: '요청을 처리하지 못했습니다.' }
} as const

/**
 * The checks every main-window feature shares. A call is answered only to the main window's own
 * top frame, with exactly the arguments its schema describes, and what goes back (an answer or a
 * pushed event) must pass its schema too; anything else becomes a fixed error and no internals.
 */
export function createCheckedIpc({ ipc, getContents, entryUrl }: CheckedIpcOptions) {
  const channels: string[] = []
  const stops: Unsubscribe[] = []

  /** One call: sender, argument count, request shape and answer shape are all checked. */
  function handle<Request, Response>(
    channel: string,
    requestSchema: z.ZodType<Request> | null,
    responseSchema: z.ZodType<Response>,
    run: (request: Request) => Promise<unknown> | unknown
  ): void {
    channels.push(channel)
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedUiSender(event, getContents(), entryUrl)) return denied
      let request: Request | undefined
      if (requestSchema) {
        if (args.length !== 1) return invalid
        const parsed = requestSchema.safeParse(args[0])
        if (!parsed.success) return invalid
        request = parsed.data
      } else if (args.length !== 0) return invalid
      try {
        const response = responseSchema.safeParse(await run(request as Request))
        return response.success ? response.data : failed
      } catch {
        return failed
      }
    })
  }

  /** Sends what `subscribe` produces to the main window, when it is showing the entry page and the event is valid. */
  function forward<Event>(
    channel: string,
    schema: z.ZodType<Event>,
    subscribe: (listener: (event: unknown) => void) => Unsubscribe
  ): void {
    stops.push(
      subscribe((event) => {
        const parsed = schema.safeParse(event)
        if (!parsed.success) return
        const contents = getContents()
        if (!contents || contents.isDestroyed()) return
        try {
          if (contents.mainFrame.url === entryUrl) contents.send(channel, parsed.data)
        } catch {
          /* The frame may disappear while its window closes or reloads. */
        }
      })
    )
  }

  let disposed = false
  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const stop of stops) stop()
    for (const channel of channels) ipc.removeHandler(channel)
  }

  return { handle, forward, dispose }
}
