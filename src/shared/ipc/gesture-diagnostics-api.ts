import { resultSchema } from '../contracts/common'
import type { Result, Unsubscribe } from '../contracts/common'
import { DiagnosticsSnapshotSchema } from '../contracts/gesture-diagnostics'
import type {
  DiagnosticsCommandRequest,
  DiagnosticsEvent,
  DiagnosticsSnapshot
} from '../contracts/gesture-diagnostics'

export const DiagnosticsSnapshotResponseSchema = resultSchema(DiagnosticsSnapshotSchema)

/**
 * The recognition view's API. The window asks to start or stop it and is told the state and, while
 * it runs, every frame: the hands as the app sees them, their judgement, and the camera picture.
 * The camera, the tracking and the pictures are Main's and the Media Renderer's.
 */
export interface GestureDiagnosticsApi {
  command(request: DiagnosticsCommandRequest): Promise<Result<DiagnosticsSnapshot>>
  getSnapshot(): Promise<Result<DiagnosticsSnapshot>>
  subscribe(listener: (event: DiagnosticsEvent) => void): Unsubscribe
}
