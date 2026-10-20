import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { InteractionPort } from '../interaction/ports'
import { UiCommandSchema, UiEventSchema } from '../../shared/contracts/interaction'
import { UI_CHANNELS } from '../../shared/ipc/channels'
import { UiCommandResponseSchema, UiSnapshotResponseSchema } from '../../shared/ipc/ui-api'

interface UiIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getContents(): WebContents | null
  entryUrl: string
  interaction: InteractionPort
}

/** Identity, top-frame and exact entry URL must all match; other windows and subframes are denied. */
export function isTrustedUiSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  contents: WebContents | null,
  entryUrl: string
): boolean {
  try {
    return (
      contents !== null &&
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame !== null &&
      event.senderFrame === contents.mainFrame &&
      event.senderFrame.url === entryUrl
    )
  } catch {
    return false
  }
}

export function registerUiIpc({
  ipc,
  getContents,
  entryUrl,
  interaction
}: UiIpcOptions): () => void {
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

  ipc.handle(UI_CHANNELS.command, async (event, ...args: unknown[]) => {
    if (!isTrustedUiSender(event, getContents(), entryUrl)) return denied
    if (args.length !== 1) return invalid
    const command = UiCommandSchema.safeParse(args[0])
    if (!command.success) return invalid
    try {
      return UiCommandResponseSchema.parse(await interaction.dispatch(command.data))
    } catch {
      return failed
    }
  })
  ipc.handle(UI_CHANNELS.snapshot, (event, ...args: unknown[]) => {
    if (!isTrustedUiSender(event, getContents(), entryUrl)) return denied
    if (args.length !== 0) return invalid
    try {
      return UiSnapshotResponseSchema.parse({ ok: true, value: interaction.getSnapshot() })
    } catch {
      return failed
    }
  })
  const unsubscribe = interaction.subscribe((event) => {
    const parsed = UiEventSchema.safeParse(event)
    if (!parsed.success) return
    const contents = getContents()
    if (!contents || contents.isDestroyed()) return
    try {
      if (contents.mainFrame.url === entryUrl) contents.send(UI_CHANNELS.event, parsed.data)
    } catch {
      /* The frame may disappear while its window closes or reloads. */
    }
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    ipc.removeHandler(UI_CHANNELS.command)
    ipc.removeHandler(UI_CHANNELS.snapshot)
  }
}
