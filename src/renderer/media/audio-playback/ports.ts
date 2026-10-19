import type { Generation, Result, Unsubscribe } from '../../../shared/contracts/common'
import type { PlaybackEvent, PlaybackRequest } from '../../../shared/contracts/speech'

export interface AudioPlaybackPort {
  /** Resolves when accepted; started/ended/failed events report actual playback. */
  play(request: PlaybackRequest): Promise<Result<void>>
  stop(playbackId: string, generation: Generation): Promise<Result<void>>
  subscribe(listener: (event: PlaybackEvent) => void): Unsubscribe
}
