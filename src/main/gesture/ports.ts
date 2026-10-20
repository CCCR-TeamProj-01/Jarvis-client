import type { Generation, Result, Unsubscribe } from '../../shared/contracts/common'
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
}
