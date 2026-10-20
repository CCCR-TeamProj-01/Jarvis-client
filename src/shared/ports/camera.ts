import type { Generation, Result, Unsubscribe } from '../contracts/common'
import type { CameraStart } from '../ipc/media-api'

/** Browser-only resource. Never send this object through Electron IPC to Main. */
export interface CameraFrame {
  generation: Generation
  sequence: number
  capturedAtMs: number
  image: ImageBitmap
}

export interface CameraSourcePort {
  start(request: CameraStart): Promise<Result<void>>
  stop(generation: Generation): Promise<Result<void>>
  /** Each consumer owns its bitmap and must close it or transfer it to its inference worker. */
  subscribeFrames(listener: (frame: CameraFrame) => void): Unsubscribe
}
