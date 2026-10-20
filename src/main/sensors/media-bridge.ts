import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import type { SensorDevice, SensorKind } from '../../shared/contracts/sensors'
import type { MediaCommand, MediaCommandEnvelope, MediaEvent } from '../../shared/ipc/media-api'
import type { LocalExecutionOptions } from '../ports'
import type { SensorHardwareEvent, SensorHardwarePort } from './hardware'

interface MediaBridgeOptions {
  /** Deliver a command to the Media Renderer, creating it if needed. Resolves false if it cannot. */
  send(envelope: MediaCommandEnvelope): Promise<boolean>
  createId(): string
  /** Returns a cancel function. Injected so timeouts can be tested without real timers. */
  schedule(callback: () => void, delayMs: number): () => void
  timeoutMs?: { list: number; open: number; close: number }
}

const DEFAULT_TIMEOUTS = { list: 5_000, open: 15_000, close: 5_000 }

interface Pending {
  resolve(answer: MediaEvent | Result<never>): void
  cancel(): void
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Request/response over the one-way Media IPC: a command resolves when the event carrying its id
 * arrives. A command that gets no answer, whose window cannot be reached or whose renderer dies
 * resolves as unavailable instead of hanging a sensor start.
 */
export class MediaBridge {
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(event: MediaEvent) => void>()
  private readonly timeouts: { list: number; open: number; close: number }
  private disposed = false

  constructor(private readonly options: MediaBridgeOptions) {
    this.timeouts = options.timeoutMs ?? DEFAULT_TIMEOUTS
  }

  /** The validated event stream from the Media Renderer (called by the IPC layer). */
  handleEvent(event: MediaEvent): void {
    if (this.disposed) return
    if (event.type === 'media.command_result' || event.type === 'media.devices') {
      const pending = this.pending.get(event.commandId)
      if (!pending) return
      this.pending.delete(event.commandId)
      pending.cancel()
      pending.resolve(event)
      return
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        /* One observer cannot affect others. */
      }
    }
  }

  subscribe(listener: (event: MediaEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The renderer process went away: nothing it was asked to do will ever be answered. */
  rendererLost(): void {
    this.failPending(failure('unavailable', '미디어 처리 화면이 종료되었습니다.'))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.failPending(failure('cancelled', '미디어 연결을 종료했습니다.'))
    this.listeners.clear()
  }

  async listDevices(
    kind: SensorKind,
    options?: LocalExecutionOptions
  ): Promise<Result<SensorDevice[]>> {
    const event = await this.request({ type: 'devices.list', kind }, this.timeouts.list, options)
    if ('ok' in event) return event
    if (event.type !== 'media.devices')
      return failure('internal', '장치 목록 응답이 올바르지 않습니다.')
    return event.result
  }

  async command(
    command: MediaCommand,
    timeoutMs: number,
    options?: LocalExecutionOptions
  ): Promise<Result<void>> {
    const event = await this.request(command, timeoutMs, options)
    if ('ok' in event) return event
    if (event.type !== 'media.command_result')
      return failure('internal', '미디어 응답이 올바르지 않습니다.')
    return event.result.ok ? { ok: true, value: undefined } : event.result
  }

  private async request(
    command: MediaCommand,
    timeoutMs: number,
    options?: LocalExecutionOptions
  ): Promise<MediaEvent | Result<never>> {
    if (this.disposed) return failure('cancelled', '미디어 연결이 종료되었습니다.')
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const commandId = this.options.createId()
    const answer = new Promise<MediaEvent | Result<never>>((resolve) => {
      const cancel = this.options.schedule(() => {
        this.pending.delete(commandId)
        resolve(failure('unavailable', '미디어 응답을 받지 못했습니다.'))
      }, timeoutMs)
      this.pending.set(commandId, { resolve, cancel })
      options?.signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(commandId)) return
          cancel()
          resolve(failure('cancelled', '요청이 취소되었습니다.'))
        },
        { once: true }
      )
    })
    const delivered = await this.options.send({ commandId, command })
    if (!delivered) {
      const pending = this.pending.get(commandId)
      this.pending.delete(commandId)
      pending?.cancel()
      pending?.resolve(failure('unavailable', '미디어 처리 화면에 연결하지 못했습니다.'))
    }
    return answer
  }

  private failPending(error: Result<never>): void {
    for (const [commandId, pending] of [...this.pending]) {
      this.pending.delete(commandId)
      pending.cancel()
      pending.resolve(error)
    }
  }
}

/** Adapts the Media Renderer to the sensor layer's hardware port. */
export class MediaSensorHardware implements SensorHardwarePort {
  private readonly listeners = new Set<(event: SensorHardwareEvent) => void>()
  private readonly unsubscribe: Unsubscribe
  /** Streams currently open, so a renderer crash can revoke exactly those. */
  private readonly streams = new Map<string, SensorKind>()
  private readonly timeouts: { list: number; open: number; close: number }

  constructor(
    private readonly bridge: MediaBridge,
    timeoutMs: { list: number; open: number; close: number } = DEFAULT_TIMEOUTS
  ) {
    this.timeouts = timeoutMs
    this.unsubscribe = bridge.subscribe((event) => this.onEvent(event))
  }

  listDevices(kind: SensorKind, options?: LocalExecutionOptions) {
    return this.bridge.listDevices(kind, options)
  }

  async open(
    kind: SensorKind,
    request: { streamId: string; deviceId: string },
    options?: LocalExecutionOptions
  ): Promise<Result<void>> {
    const generation = { sessionId: request.streamId, revision: 0 }
    const command: MediaCommand =
      kind === 'camera'
        ? {
            type: 'camera.start',
            request: { generation, leaseId: request.streamId, deviceId: request.deviceId }
          }
        : {
            type: 'audio.capture.start',
            request: {
              generation,
              leaseId: request.streamId,
              deviceId: request.deviceId,
              format: { encoding: 'pcm_s16le', sampleRateHz: 16_000, channels: 1 }
            }
          }
    const result = await this.bridge.command(command, this.timeouts.open, options)
    if (result.ok) this.streams.set(request.streamId, kind)
    return result
  }

  async close(kind: SensorKind, streamId: string): Promise<Result<void>> {
    this.streams.delete(streamId)
    const generation = { sessionId: streamId, revision: 0 }
    return this.bridge.command(
      kind === 'camera'
        ? { type: 'camera.stop', generation }
        : { type: 'audio.capture.stop', generation },
      this.timeouts.close
    )
  }

  subscribe(listener: (event: SensorHardwareEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The renderer died: every open stream is gone with it. */
  rendererLost(): void {
    const lost = [...this.streams]
    this.streams.clear()
    for (const [streamId, kind] of lost)
      this.emit({
        type: 'stream_ended',
        kind,
        streamId,
        error: { code: 'device_unavailable', message: '미디어 처리 화면이 종료되었습니다.' }
      })
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private onEvent(event: MediaEvent): void {
    if (event.type === 'media.devices_changed')
      this.emit({ type: 'devices_changed', kind: event.kind, devices: event.devices })
    else if (
      (event.type === 'camera.state' || event.type === 'audio.capture.state') &&
      event.state === 'failed' &&
      event.error
    ) {
      const kind: SensorKind = event.type === 'camera.state' ? 'camera' : 'microphone'
      this.streams.delete(event.generation.sessionId)
      this.emit({
        type: 'stream_ended',
        kind,
        streamId: event.generation.sessionId,
        error: event.error
      })
    }
  }

  private emit(event: SensorHardwareEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        /* One observer cannot affect others. */
      }
    }
  }
}
