import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'

/**
 * A message is trusted only when it comes from the one expected window, its top frame, and the
 * document Main loaded into it. Anything else (another window, a frame, a navigated page) is
 * ignored without an answer.
 */
export function isTrustedSender(
  event: Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
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
