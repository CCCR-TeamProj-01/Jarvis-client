import type { IpcMain, IpcMainEvent, WebContents } from 'electron'
import { isTrustedSender } from './trusted-sender'
import { MediaEventSchema } from '../../shared/ipc/media-api'
import { MEDIA_CHANNELS } from '../../shared/ipc/channels'
import type { MediaBridge } from '../sensors/media-bridge'

interface MediaIpcOptions {
  ipc: Pick<IpcMain, 'on' | 'removeListener'>
  getContents(): WebContents | null
  entryUrl: string
  bridge: Pick<MediaBridge, 'handleEvent'>
}

/** Same trust rule as the UI IPC: the one media window, its top frame and its entry document. */
export const isTrustedMediaSender = isTrustedSender

/** Receives Media Renderer events; anything from another sender or in a wrong shape is dropped. */
export function registerMediaIpc({
  ipc,
  getContents,
  entryUrl,
  bridge
}: MediaIpcOptions): () => void {
  const listener = (event: IpcMainEvent, ...args: unknown[]) => {
    if (!isTrustedMediaSender(event, getContents(), entryUrl)) return
    if (args.length !== 1) return
    const parsed = MediaEventSchema.safeParse(args[0])
    if (parsed.success) bridge.handleEvent(parsed.data)
  }
  ipc.on(MEDIA_CHANNELS.event, listener)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    ipc.removeListener(MEDIA_CHANNELS.event, listener)
  }
}
