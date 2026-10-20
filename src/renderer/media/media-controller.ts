import type { ClientError, Generation, Result } from '../../shared/contracts/common'
import { sameGeneration } from '../../shared/contracts/common'
import type { SensorDevice, SensorKind } from '../../shared/contracts/sensors'
import type { AudioCaptureStart } from '../../shared/contracts/speech'
import type { MediaApi, MediaCommandEnvelope } from '../../shared/ipc/media-api'
import type { AudioCapture } from './audio-capture/web-audio-capture'

/** The slice of browser media APIs this controller uses, so it can run against fakes. */
export interface TrackLike {
  stop(): void
  addEventListener(type: 'ended', listener: () => void): void
  removeEventListener(type: 'ended', listener: () => void): void
}
export interface StreamLike {
  getTracks(): TrackLike[]
}
export interface MediaDevicesLike {
  enumerateDevices(): Promise<{ kind: string; deviceId: string; label: string }[]>
  getUserMedia(constraints: {
    video?: { deviceId: { exact: string } }
    audio?: { deviceId: { exact: string }; channelCount: number }
  }): Promise<StreamLike>
  addEventListener(type: 'devicechange', listener: () => void): void
  removeEventListener(type: 'devicechange', listener: () => void): void
}

export type PermissionQuery = (
  kind: SensorKind
) => Promise<'granted' | 'denied' | 'prompt' | 'unknown'>

interface OpenStream {
  generation: Generation
  stream: StreamLike
  detach(): void
}

const BROWSER_KIND: Record<SensorKind, string> = { camera: 'videoinput', microphone: 'audioinput' }
const KINDS: readonly SensorKind[] = ['camera', 'microphone']

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/** Maps a getUserMedia rejection onto the error vocabulary shared with Main. */
export function describeMediaError(error: unknown): ClientError {
  const name = (error as { name?: string } | null)?.name
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { code: 'permission_denied', message: '카메라·마이크 사용 권한이 거부되었습니다.' }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { code: 'device_unavailable', message: '선택한 장치를 찾을 수 없습니다.' }
    case 'NotReadableError':
    case 'AbortError':
      return {
        code: 'device_unavailable',
        message: '장치를 사용할 수 없습니다. 다른 앱이 사용 중일 수 있어요.'
      }
    default:
      return { code: 'internal', message: '장치를 열지 못했습니다.' }
  }
}

/**
 * Runs inside the hidden Media Renderer. It owns the MediaStreams (they never leave this process),
 * executes Main's commands in order per sensor and reports lifecycle events. Frames and PCM are
 * added by the gesture and voice work; this layer only opens, holds and closes the devices.
 */
export class MediaController {
  private readonly open = new Map<SensorKind, OpenStream>()
  private readonly queues = new Map<SensorKind, Promise<void>>()
  private readonly known = new Map<SensorKind, string>()
  private readonly stop: () => void
  private readonly onDeviceChange = () => void this.refreshDevices()
  private disposed = false

  constructor(
    private readonly api: MediaApi,
    private readonly devices: MediaDevicesLike,
    private readonly queryPermission: PermissionQuery = async () => 'unknown',
    /** PCM capture on the open microphone stream; without it the stream is only held open. */
    private readonly audio: AudioCapture | null = null
  ) {
    this.stop = api.subscribeCommands((envelope) => this.receive(envelope))
    devices.addEventListener('devicechange', this.onDeviceChange)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.devices.removeEventListener('devicechange', this.onDeviceChange)
    for (const kind of KINDS) this.release(kind)
    this.audio?.dispose()
  }

  private receive({ commandId, command }: MediaCommandEnvelope): void {
    if (this.disposed) return
    const kind = this.kindOf(command)
    // Opening, closing and listing for one sensor run strictly in the order Main sent them.
    const run = async (): Promise<void> => {
      if (this.disposed) return
      await this.execute(commandId, command)
    }
    if (kind === null) {
      void run()
      return
    }
    const previous = this.queues.get(kind) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.queues.set(kind, next)
  }

  private kindOf(command: MediaCommandEnvelope['command']): SensorKind | null {
    switch (command.type) {
      case 'devices.list':
        return null
      case 'camera.start':
      case 'camera.stop':
        return 'camera'
      case 'audio.capture.start':
      case 'audio.capture.stop':
      case 'audio.buffer.clear':
      case 'audio.utterance.extract':
        return 'microphone'
      default:
        return null
    }
  }

  private async execute(
    commandId: string,
    command: MediaCommandEnvelope['command']
  ): Promise<void> {
    switch (command.type) {
      case 'devices.list': {
        const result = await this.list(command.kind)
        this.api.publish({ type: 'media.devices', commandId, result })
        return
      }
      case 'camera.start':
        return this.reply(commandId, await this.start('camera', command.request))
      case 'audio.capture.start':
        return this.reply(commandId, await this.start('microphone', command.request))
      case 'audio.buffer.clear':
        return this.reply(
          commandId,
          this.audio
            ? this.mapVoid(this.audio.clear(command.generation))
            : failure('unsupported', '오디오 수집을 지원하지 않습니다.')
        )
      case 'audio.utterance.extract': {
        const extracted = this.audio?.extract(command.range)
        if (!extracted)
          return this.reply(commandId, failure('unsupported', '오디오 수집을 지원하지 않습니다.'))
        // The audio goes out as its own event; the reply only says whether it could be produced.
        if (extracted.ok) this.api.publish({ type: 'audio.utterance', utterance: extracted.value })
        return this.reply(commandId, this.mapVoid(extracted))
      }
      case 'camera.stop':
        return this.reply(commandId, this.close('camera', command.generation))
      case 'audio.capture.stop':
        return this.reply(commandId, this.close('microphone', command.generation))
      default:
        // Playback arrives with the speech session work.
        return this.reply(
          commandId,
          failure('unsupported', '아직 지원하지 않는 미디어 명령입니다.')
        )
    }
  }

  private reply(commandId: string, result: Result<null>): void {
    this.api.publish({ type: 'media.command_result', commandId, result })
  }

  private async list(kind: SensorKind): Promise<Result<SensorDevice[]>> {
    try {
      const found = (await this.devices.enumerateDevices()).filter(
        (device) => device.kind === BROWSER_KIND[kind] && device.deviceId !== ''
      )
      const devices = found.map<SensorDevice>((device) => ({
        kind,
        deviceId: device.deviceId,
        ...(device.label ? { label: device.label } : {})
      }))
      this.known.set(kind, JSON.stringify(devices))
      return { ok: true, value: devices }
    } catch {
      return failure('device_unavailable', '장치 목록을 가져오지 못했습니다.')
    }
  }

  private mapVoid(result: Result<unknown>): Result<null> {
    return result.ok ? { ok: true, value: null } : result
  }

  private async start(
    kind: SensorKind,
    request: { generation: Generation; deviceId?: string; format?: AudioCaptureStart['format'] }
  ): Promise<Result<null>> {
    if (request.deviceId === undefined) return failure('invalid_input', '장치를 지정해야 합니다.')
    // A new start replaces whatever this sensor still held.
    this.release(kind)
    try {
      const constraints =
        kind === 'camera'
          ? { video: { deviceId: { exact: request.deviceId } } }
          : { audio: { deviceId: { exact: request.deviceId }, channelCount: 1 } }
      const stream = await this.devices.getUserMedia(constraints)
      if (this.disposed) {
        for (const track of stream.getTracks()) track.stop()
        return failure('cancelled', '미디어 컨트롤러가 종료되었습니다.')
      }
      if (kind === 'microphone' && this.audio) {
        const capturing = await this.audio.start(stream, request as AudioCaptureStart)
        if (!capturing.ok || this.disposed) {
          for (const track of stream.getTracks()) track.stop()
          this.audio.stop(request.generation)
          return capturing.ok
            ? failure('cancelled', '미디어 컨트롤러가 종료되었습니다.')
            : capturing
        }
      }
      this.attach(kind, request.generation, stream)
      this.publishState(kind, request.generation, 'started')
      return { ok: true, value: null }
    } catch (error) {
      return { ok: false, error: describeMediaError(error) }
    }
  }

  private attach(kind: SensorKind, generation: Generation, stream: StreamLike): void {
    const tracks = stream.getTracks()
    const ended = () => void this.onTrackEnded(kind, generation)
    for (const track of tracks) track.addEventListener('ended', ended)
    this.open.set(kind, {
      generation,
      stream,
      detach: () => {
        for (const track of tracks) track.removeEventListener('ended', ended)
      }
    })
  }

  private close(kind: SensorKind, generation: Generation): Result<null> {
    const current = this.open.get(kind)
    // A stop for an older stream must not close the one that replaced it.
    if (current && sameGeneration(current.generation, generation)) {
      this.release(kind)
      this.publishState(kind, generation, 'stopped')
    }
    return { ok: true, value: null }
  }

  private release(kind: SensorKind): void {
    const current = this.open.get(kind)
    if (!current) return
    this.open.delete(kind)
    // Captured audio must not outlive the stream it came from.
    if (kind === 'microphone') this.audio?.stop(current.generation)
    current.detach()
    for (const track of current.stream.getTracks()) track.stop()
  }

  private async onTrackEnded(kind: SensorKind, generation: Generation): Promise<void> {
    const current = this.open.get(kind)
    if (!current || !sameGeneration(current.generation, generation)) return
    this.release(kind)
    const permission = await this.queryPermission(kind).catch(() => 'unknown' as const)
    const error: ClientError =
      permission === 'denied'
        ? { code: 'permission_denied', message: '카메라·마이크 권한이 철회되었습니다.' }
        : { code: 'device_unavailable', message: '장치 연결이 끊어졌습니다.' }
    this.publishState(kind, generation, 'failed', error)
  }

  private publishState(
    kind: SensorKind,
    generation: Generation,
    state: 'started' | 'stopped' | 'failed',
    error?: ClientError
  ): void {
    this.api.publish(
      kind === 'camera'
        ? { type: 'camera.state', generation, state, ...(error ? { error } : {}) }
        : { type: 'audio.capture.state', generation, state, ...(error ? { error } : {}) }
    )
  }

  private async refreshDevices(): Promise<void> {
    for (const kind of KINDS) {
      const before = this.known.get(kind)
      const result = await this.list(kind)
      if (!result.ok || this.disposed) continue
      if (before !== undefined && before !== this.known.get(kind))
        this.api.publish({ type: 'media.devices_changed', kind, devices: result.value })
    }
  }
}
