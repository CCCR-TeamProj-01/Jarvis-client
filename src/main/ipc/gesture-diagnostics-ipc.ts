import type { IpcMain, WebContents } from 'electron'
import {
  DiagnosticsCommandRequestSchema,
  DiagnosticsEventSchema
} from '../../shared/contracts/gesture-diagnostics'
import { GESTURE_DIAGNOSTICS_CHANNELS } from '../../shared/ipc/channels'
import { DiagnosticsSnapshotResponseSchema } from '../../shared/ipc/gesture-diagnostics-api'
import type { GestureDiagnosticsPort } from '../gesture/gesture-diagnostics'
import { createCheckedIpc } from './checked-ipc'

interface GestureDiagnosticsIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getContents(): WebContents | null
  entryUrl: string
  diagnostics: GestureDiagnosticsPort
}

/** Only the main window may ask; the request, the answer and every pushed frame are checked here. */
export function registerGestureDiagnosticsIpc({
  ipc,
  getContents,
  entryUrl,
  diagnostics
}: GestureDiagnosticsIpcOptions): () => void {
  const checked = createCheckedIpc({ ipc, getContents, entryUrl })
  checked.handle(
    GESTURE_DIAGNOSTICS_CHANNELS.command,
    DiagnosticsCommandRequestSchema,
    DiagnosticsSnapshotResponseSchema,
    (request) => diagnostics.command(request)
  )
  checked.handle(
    GESTURE_DIAGNOSTICS_CHANNELS.snapshot,
    null,
    DiagnosticsSnapshotResponseSchema,
    () => ({ ok: true, value: diagnostics.getSnapshot() })
  )
  checked.forward(GESTURE_DIAGNOSTICS_CHANNELS.event, DiagnosticsEventSchema, (listener) =>
    diagnostics.subscribe(listener)
  )
  return checked.dispose
}
