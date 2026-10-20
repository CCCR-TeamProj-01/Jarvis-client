import type { HandObservation } from '../../../shared/contracts/gesture'

export type WorkerRequest =
  | { type: 'init'; model: Uint8Array }
  | { type: 'detect'; id: number; image: ImageBitmap; timestampMs: number }

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'failed'; message: string }
  | { type: 'result'; id: number; hands: HandObservation[] }
  | { type: 'error'; id: number; message: string }
