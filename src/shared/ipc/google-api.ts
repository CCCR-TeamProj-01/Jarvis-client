import { resultSchema } from '../contracts/common'
import type { Result, Unsubscribe } from '../contracts/common'
import { GoogleConnectionSnapshotSchema } from '../contracts/google-connection'
import type {
  GoogleCommandRequest,
  GoogleConnectionEvent,
  GoogleConnectionSnapshot
} from '../contracts/google-connection'

export const GoogleSnapshotResponseSchema = resultSchema(GoogleConnectionSnapshotSchema)

/**
 * The Google Calendar connection API. The window asks for one of a few actions and is told the
 * state; the server calls, the browser and the waiting are Main's. An action returns as soon as
 * it has started, and what follows comes as state events.
 */
export interface GoogleConnectionApi {
  command(request: GoogleCommandRequest): Promise<Result<GoogleConnectionSnapshot>>
  getSnapshot(): Promise<Result<GoogleConnectionSnapshot>>
  subscribe(listener: (event: GoogleConnectionEvent) => void): Unsubscribe
}
