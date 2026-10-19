import type { Result, Unsubscribe } from '../contracts/common'
import type { ClientSnapshot, CommandReceipt, UiCommand, UiEvent } from '../contracts/interaction'

/** The API actually available in the initial app; do not expose unimplemented methods. */
export interface BootstrapUiApi {
  readonly platform: string
}

/** Implement the IPC handlers and sender validation before exposing this full API. */
export interface UiApi extends BootstrapUiApi {
  dispatch(command: UiCommand): Promise<Result<CommandReceipt>>
  getSnapshot(): Promise<Result<ClientSnapshot>>
  subscribe(listener: (event: UiEvent) => void): Unsubscribe
}
