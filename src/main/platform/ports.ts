import type { Generation, Result } from '../../shared/contracts/common'
import type { DesktopPoint, DisplayBounds, InputObservation } from '../../shared/contracts/gesture'
import type {
  AppDescriptor,
  AppObservation,
  FolderAlias,
  FolderObservation,
  TaskSwitchObservation,
  UrlObservation,
  WindowReference
} from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'

export interface InputExecutionOptions extends LocalExecutionOptions {
  generation: Generation
  sequence: number
  deadlineMs: number
}

export interface PointerInputPort {
  getDisplays(): Promise<Result<DisplayBounds[]>>
  /** Keep only the latest pending move; never replay a backlog after cancellation. */
  moveTo(point: DesktopPoint, options: InputExecutionOptions): Promise<Result<InputObservation>>
  click(options: InputExecutionOptions): Promise<Result<InputObservation>>
  /** These cleanup paths must work even when the triggering operation's signal was aborted. */
  releaseOwnedInputs(): Promise<Result<void>>
  cancelGeneration(generation: Generation): Promise<Result<void>>
}

export interface AppControlPort {
  list(options?: LocalExecutionOptions): Promise<Result<AppDescriptor[]>>
  launch(appId: string, options?: LocalExecutionOptions): Promise<Result<AppObservation>>
  activate(appId: string, options?: LocalExecutionOptions): Promise<Result<AppObservation>>
  getForegroundWindow(): Promise<Result<WindowReference | null>>
  restore(target: WindowReference, options?: LocalExecutionOptions): Promise<Result<AppObservation>>
  switchRecentTask(options: InputExecutionOptions): Promise<Result<TaskSwitchObservation>>
  /** Reports browser handoff, not successful page loading. */
  openUrl(url: string, options?: LocalExecutionOptions): Promise<Result<UrlObservation>>
}

export interface FolderOpenPort {
  /** Reports the handoff to the file manager, not that a window opened. */
  open(alias: FolderAlias, options?: LocalExecutionOptions): Promise<Result<FolderObservation>>
}
