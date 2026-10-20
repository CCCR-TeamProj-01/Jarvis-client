import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { EMPTY_OVERLAY } from '../../shared/contracts/overlay'
import type { OverlayState } from '../../shared/contracts/overlay'
import { OVERLAY_CHANNELS } from '../../shared/ipc/channels'
import { isTrustedSender } from './trusted-sender'

interface OverlayIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>
  getContents(): WebContents | null
  entryUrl: string
  getState(): OverlayState
  /** The pointer is over a stop button (or has left it). */
  setInteractive(interactive: boolean): void
  stop(): void
}

/** Serves the overlay page its state and takes its two messages, from that page only. */
export function registerOverlayIpc(options: OverlayIpcOptions): () => void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    isTrustedSender(event, options.getContents(), options.entryUrl)
  options.ipc.handle(OVERLAY_CHANNELS.snapshot, (event) =>
    trusted(event) ? options.getState() : EMPTY_OVERLAY
  )
  const onInteractive = (event: IpcMainEvent, ...args: unknown[]) => {
    if (!trusted(event) || args.length !== 1 || typeof args[0] !== 'boolean') return
    options.setInteractive(args[0])
  }
  const onStop = (event: IpcMainEvent, ...args: unknown[]) => {
    if (!trusted(event) || args.length !== 0) return
    options.stop()
  }
  options.ipc.on(OVERLAY_CHANNELS.interactive, onInteractive)
  options.ipc.on(OVERLAY_CHANNELS.stop, onStop)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    options.ipc.removeHandler(OVERLAY_CHANNELS.snapshot)
    options.ipc.removeListener(OVERLAY_CHANNELS.interactive, onInteractive)
    options.ipc.removeListener(OVERLAY_CHANNELS.stop, onStop)
  }
}
