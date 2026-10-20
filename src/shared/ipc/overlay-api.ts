import type { Unsubscribe } from '../contracts/common'
import type { OverlayState } from '../contracts/overlay'

/** The overlay page gets the state to draw and can ask for two things; it has no other channel. */
export interface OverlayApi {
  getState(): Promise<OverlayState>
  subscribe(listener: (state: OverlayState) => void): Unsubscribe
  /** The pointer is over a button: let it receive mouse input, or hand input back to the desktop. */
  setInteractive(interactive: boolean): void
  /** The stop button of a speaking pill was pressed. */
  stop(): void
}
