import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import type {
  ActiveHandPolicy,
  GestureSnapshot,
  HandTrackingEvent
} from '../../shared/contracts/gesture'
import type { LocalExecutionOptions } from '../ports'

export interface GestureControlPort {
  start(
    settings: { activeHand: ActiveHandPolicy; displayId: string },
    options?: LocalExecutionOptions
  ): Promise<Result<Generation>>
  /** Invalidate the generation before releasing inputs and sensor leases. */
  stop(): Promise<Result<void>>
  acceptTracking(event: HandTrackingEvent): void
  getSnapshot(): GestureSnapshot
  subscribe(listener: (snapshot: GestureSnapshot) => void): Unsubscribe
  /** The mode ended on its own (permission lost, engine stopped), with the reason to show. */
  subscribeProblems(listener: (error: ClientError) => void): Unsubscribe
}

/** Where hand observations come from, and the camera lease behind them. */
export interface HandTrackingSource {
  start(generation: Generation, options?: LocalExecutionOptions): Promise<Result<void>>
  stop(): Promise<void>
  subscribe(listener: (event: HandTrackingEvent) => void): Unsubscribe
}

/** macOS asks for Accessibility permission before a program may move the pointer. */
export interface InputPermissionPort {
  isGranted(): boolean
  /** Shows the system's permission request; the answer comes later and is read by `isGranted`. */
  request(): void
}
