import type { Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import type { PlaybackEvent, PlaybackRequest } from '../../shared/contracts/speech'
import type { AudioPlaybackPort } from '../../shared/ports/audio-playback'
import type { MediaBridge } from '../sensors/media-bridge'

const ACCEPT_TIMEOUT_MS = 10_000

/** Main's side of playback: the Media Renderer plays, and its events come back through the bridge. */
export class MediaAudioPlayback implements AudioPlaybackPort {
  private readonly listeners = new Set<(event: PlaybackEvent) => void>()
  private readonly unsubscribe: Unsubscribe

  constructor(private readonly bridge: Pick<MediaBridge, 'command' | 'subscribe'>) {
    this.unsubscribe = bridge.subscribe((event) => {
      if (event.type !== 'audio.playback') return
      for (const listener of [...this.listeners]) {
        try {
          listener(event.event)
        } catch {
          /* One observer cannot affect others. */
        }
      }
    })
  }

  play(request: PlaybackRequest): Promise<Result<void>> {
    return this.bridge.command({ type: 'audio.playback.start', request }, ACCEPT_TIMEOUT_MS)
  }

  stop(playbackId: string, generation: Generation): Promise<Result<void>> {
    return this.bridge.command(
      { type: 'audio.playback.stop', playbackId, generation },
      ACCEPT_TIMEOUT_MS
    )
  }

  subscribe(listener: (event: PlaybackEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }
}
