import type { IpcMain, WebContents } from 'electron'
import {
  GoogleCommandRequestSchema,
  GoogleConnectionEventSchema
} from '../../shared/contracts/google-connection'
import { GOOGLE_CHANNELS } from '../../shared/ipc/channels'
import { GoogleSnapshotResponseSchema } from '../../shared/ipc/google-api'
import type { GoogleConnectionPort } from '../google-connection/google-connection-service'
import { createCheckedIpc } from './checked-ipc'

interface GoogleIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getContents(): WebContents | null
  entryUrl: string
  google: GoogleConnectionPort
}

/** Only the main window may ask; the request, the answer and every pushed event are checked here. */
export function registerGoogleIpc({
  ipc,
  getContents,
  entryUrl,
  google
}: GoogleIpcOptions): () => void {
  const checked = createCheckedIpc({ ipc, getContents, entryUrl })
  checked.handle(
    GOOGLE_CHANNELS.command,
    GoogleCommandRequestSchema,
    GoogleSnapshotResponseSchema,
    (request) => google.command(request.action)
  )
  checked.handle(GOOGLE_CHANNELS.snapshot, null, GoogleSnapshotResponseSchema, () => ({
    ok: true,
    value: google.getSnapshot()
  }))
  checked.forward(GOOGLE_CHANNELS.event, GoogleConnectionEventSchema, (listener) =>
    google.subscribe(listener)
  )
  return checked.dispose
}
