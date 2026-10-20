import type {
  MediaDevicesLike,
  StreamLike,
  TrackLike
} from '../../src/renderer/media/media-controller'

export class FakeTrack implements TrackLike {
  stopped = false
  private listeners = new Set<() => void>()
  stop() {
    this.stopped = true
  }
  addEventListener(_type: 'ended', listener: () => void) {
    this.listeners.add(listener)
  }
  removeEventListener(_type: 'ended', listener: () => void) {
    this.listeners.delete(listener)
  }
  end() {
    for (const listener of [...this.listeners]) listener()
  }
  get listenerCount() {
    return this.listeners.size
  }
}

export class FakeDevices implements MediaDevicesLike {
  list = [
    { kind: 'videoinput', deviceId: 'cam-0', label: 'Built-in' },
    { kind: 'videoinput', deviceId: 'cam-1', label: '' },
    { kind: 'audioinput', deviceId: 'mic-0', label: 'Mic' },
    { kind: 'audiooutput', deviceId: 'spk-0', label: 'Speaker' },
    { kind: 'audioinput', deviceId: '', label: '' }
  ]
  tracks: FakeTrack[] = []
  requests: unknown[] = []
  failWith: { name: string } | null = null
  hold: Promise<void> | null = null
  private deviceChange = new Set<() => void>()
  async enumerateDevices() {
    return this.list.map((device) => ({ ...device }))
  }
  async getUserMedia(constraints: unknown): Promise<StreamLike> {
    this.requests.push(constraints)
    if (this.hold) await this.hold
    if (this.failWith) throw this.failWith
    const track = new FakeTrack()
    this.tracks.push(track)
    return { getTracks: () => [track] }
  }
  addEventListener(_type: 'devicechange', listener: () => void) {
    this.deviceChange.add(listener)
  }
  removeEventListener(_type: 'devicechange', listener: () => void) {
    this.deviceChange.delete(listener)
  }
  plug() {
    for (const listener of [...this.deviceChange]) listener()
  }
  get deviceChangeListeners() {
    return this.deviceChange.size
  }
}
