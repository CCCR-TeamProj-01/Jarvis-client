import type { Result, Unsubscribe } from '../../shared/contracts/common'
import type {
  ClientSnapshot,
  CommandReceipt,
  UiCommand,
  UiEvent
} from '../../shared/contracts/interaction'
import type { LocalExecutionOptions } from '../ports'

export type ActivationSource = 'voice' | 'gesture' | 'hotkey' | 'tray' | 'ui'

export interface InteractionPort {
  activateConversation(source: ActivationSource): Promise<Result<CommandReceipt>>
  dispatch(command: UiCommand, options?: LocalExecutionOptions): Promise<Result<CommandReceipt>>
  getSnapshot(): ClientSnapshot
  subscribe(listener: (event: UiEvent) => void): Unsubscribe
}
