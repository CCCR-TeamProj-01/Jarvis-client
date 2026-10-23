import type { IpcMain, WebContents } from 'electron'
import {
  CollectionCommandRequestSchema,
  CollectionEventSchema
} from '../../shared/contracts/collection'
import { COLLECTION_CHANNELS } from '../../shared/ipc/channels'
import { CollectionSnapshotResponseSchema } from '../../shared/ipc/collection-api'
import type { CollectionSettingsPort } from '../collection/collection-settings-service'
import { createCheckedIpc } from './checked-ipc'

interface CollectionIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getContents(): WebContents | null
  entryUrl: string
  collection: CollectionSettingsPort
}

/** Only the main window may ask; the request, the answer and every pushed event are checked here. */
export function registerCollectionIpc({
  ipc,
  getContents,
  entryUrl,
  collection
}: CollectionIpcOptions): () => void {
  const checked = createCheckedIpc({ ipc, getContents, entryUrl })
  checked.handle(
    COLLECTION_CHANNELS.command,
    CollectionCommandRequestSchema,
    CollectionSnapshotResponseSchema,
    (request) => collection.command(request)
  )
  checked.handle(COLLECTION_CHANNELS.snapshot, null, CollectionSnapshotResponseSchema, () => ({
    ok: true,
    value: collection.getSnapshot()
  }))
  checked.forward(COLLECTION_CHANNELS.event, CollectionEventSchema, (listener) =>
    collection.subscribe(listener)
  )
  return checked.dispose
}
