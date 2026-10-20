import type { ClientError, Generation, Result, Unsubscribe } from '../../../shared/contracts/common'
import { sameGeneration } from '../../../shared/contracts/common'
import type { PlaybackEvent, PlaybackRequest } from '../../../shared/contracts/speech'
import type { AudioPlaybackPort } from './ports'

/** The slice of HTMLAudioElement used here, so playback can be tested without a browser. */
export interface AudioLike {
  src: string
  play(): Promise<void>
  pause(): void
  addEventListener(type: 'playing' | 'ended' | 'error', listener: () => void): void
  removeEventListener(type: 'playing' | 'ended' | 'error', listener: () => void): void
}

interface ElementPlaybackOptions {
  createAudio(): AudioLike
  /** Turn the received bytes into something an audio element can load, and release it later. */
  createUrl(bytes: Uint8Array, mimeType: string): string
  revokeUrl(url: string): void
}

interface Active {
  playbackId: string
  generation: Generation
  audio: AudioLike
  url: string
  detach(): void
  started: boolean
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Plays one response at a time. Accepting a request is separate from actually playing it: the
 * result of `play` only says it was accepted, and started/ended/stopped/failed events report what
 * really happened. A new request stops the previous one, and nothing is kept after playback.
 */
export class ElementAudioPlayback implements AudioPlaybackPort {
  private active: Active | null = null
  private readonly listeners = new Set<(event: PlaybackEvent) => void>()

  constructor(private readonly options: ElementPlaybackOptions) {}

  async play(request: PlaybackRequest): Promise<Result<void>> {
    if (this.active) this.finish(this.active, 'stopped')
    let url: string
    let audio: AudioLike
    try {
      url = this.options.createUrl(request.audio, request.mimeType)
      audio = this.options.createAudio()
    } catch {
      return failure('internal', '재생을 준비하지 못했습니다.')
    }
    const identity = { playbackId: request.playbackId, generation: request.generation }
    const active: Active = { ...identity, audio, url, detach: () => undefined, started: false }
    const onPlaying = () => {
      if (this.active !== active || active.started) return
      active.started = true
      this.emit({ type: 'playback.started', ...identity })
    }
    const onEnded = () => this.finish(active, 'ended')
    const onError = () =>
      this.finish(active, 'failed', {
        code: 'unsupported',
        message: '응답 오디오를 재생할 수 없습니다.'
      })
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    active.detach = () => {
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
    this.active = active
    audio.src = url
    // Start without waiting: the caller learns the real outcome from events.
    audio.play().catch(() =>
      this.finish(active, 'failed', {
        code: 'unavailable',
        message: '응답 오디오 재생이 허용되지 않았습니다.'
      })
    )
    return { ok: true, value: undefined }
  }

  async stop(playbackId: string, generation: Generation): Promise<Result<void>> {
    const active = this.active
    // Stopping something that already ended, or belongs to another session, is a harmless no-op.
    if (active && active.playbackId === playbackId && sameGeneration(active.generation, generation))
      this.finish(active, 'stopped')
    return { ok: true, value: undefined }
  }

  subscribe(listener: (event: PlaybackEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.active) this.finish(this.active, 'stopped')
    this.listeners.clear()
  }

  private finish(
    active: Active,
    outcome: 'ended' | 'stopped' | 'failed',
    error?: ClientError
  ): void {
    if (this.active !== active) return
    this.active = null
    active.detach()
    try {
      active.audio.pause()
    } catch {
      /* The element may already be gone. */
    }
    this.options.revokeUrl(active.url)
    const identity = { playbackId: active.playbackId, generation: active.generation }
    if (outcome === 'failed' && error) this.emit({ type: 'playback.failed', ...identity, error })
    else
      this.emit({ type: outcome === 'ended' ? 'playback.ended' : 'playback.stopped', ...identity })
  }

  private emit(event: PlaybackEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        /* One observer cannot affect others. */
      }
    }
  }
}
