import type { CameraFrame } from '../../renderer/media/camera/ports'
import type { Generation, Result } from '../../shared/contracts/common'
import type { HandTrackingFrame } from '../../shared/contracts/gesture'

export interface HandTrackerPort {
  /** Consumes and closes the bitmap after inference, including failures. */
  detect(frame: CameraFrame): Promise<Result<HandTrackingFrame>>
  reset(generation: Generation): void
  dispose(): Promise<void>
}
