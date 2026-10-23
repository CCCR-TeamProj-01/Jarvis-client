import type { Result, Unsubscribe } from '../contracts/common'
import { resultSchema } from '../contracts/common'
import type { ClientSnapshot, CommandReceipt, UiCommand, UiEvent } from '../contracts/interaction'
import { ClientSnapshotSchema, CommandReceiptSchema } from '../contracts/interaction'
import type { AuthApi } from './auth-api'
import type { CalendarApi } from './calendar-api'
import type { CollectionApi } from './collection-api'
import type { DevicesApi } from './devices-api'
import type { GoogleConnectionApi } from './google-api'

/** The minimal API before IPC is connected. */
export interface BootstrapUiApi {
  readonly platform: string
}

export const UiCommandResponseSchema = resultSchema(CommandReceiptSchema)
export const UiSnapshotResponseSchema = resultSchema(ClientSnapshotSchema)

/** Currently implemented API; authentication methods are exposed after their handlers exist. */
export interface InteractionUiApi extends BootstrapUiApi {
  dispatch(command: UiCommand): Promise<Result<CommandReceipt>>
  getSnapshot(): Promise<Result<ClientSnapshot>>
  subscribe(listener: (event: UiEvent) => void): Unsubscribe
}

export interface UiApi extends InteractionUiApi {
  readonly auth: AuthApi
  readonly calendar: CalendarApi
  readonly google: GoogleConnectionApi
  readonly devices: DevicesApi
  readonly collection: CollectionApi
}
