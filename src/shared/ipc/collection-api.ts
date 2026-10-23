import { resultSchema } from '../contracts/common'
import type { Result, Unsubscribe } from '../contracts/common'
import { CollectionSnapshotSchema } from '../contracts/collection'
import type {
  CollectionCommandRequest,
  CollectionEvent,
  CollectionSnapshot
} from '../contracts/collection'

export const CollectionSnapshotResponseSchema = resultSchema(CollectionSnapshotSchema)

/**
 * The activity-collection settings API. The window asks to read them again or to turn one flag on
 * or off and is told the state; the server calls and the local stop are Main's. An action returns
 * when the server has answered, and every change also comes as a state event.
 */
export interface CollectionApi {
  command(request: CollectionCommandRequest): Promise<Result<CollectionSnapshot>>
  getSnapshot(): Promise<Result<CollectionSnapshot>>
  subscribe(listener: (event: CollectionEvent) => void): Unsubscribe
}
