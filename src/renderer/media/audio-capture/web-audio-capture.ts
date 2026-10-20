import type { ClientError, Generation, Result } from '../../../shared/contracts/common'
import { sameGeneration } from '../../../shared/contracts/common'
import type {
  AudioCaptureStart,
  CompletedUtterance,
  PcmChunk,
  UtteranceRange
} from '../../../shared/contracts/speech'
import { CaptureSession } from './capture-session'

/** What the media controller needs from the audio side. */
export interface AudioCapture {
  start(stream: unknown, request: AudioCaptureStart): Promise<Result<void>>
  stop(generation: Generation): void
  clear(generation: Generation): Result<void>
  extract(range: UtteranceRange): Result<CompletedUtterance>
  dispose(): void
}

/** Collects the audio thread's 128-sample quanta into larger messages before posting them. */
const WORKLET_SOURCE = `
class JarvisPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(640)
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let read = 0
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.block.length - this.filled)
      this.block.set(channel.subarray(read, read + take), this.filled)
      this.filled += take
      read += take
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice())
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('jarvis-pcm', JarvisPcmProcessor)
`

const BUFFER_SECONDS = 30
const CHUNK_MS = 100

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

interface Active {
  session: CaptureSession
  context: AudioContext
  nodes: AudioNode[]
}

/**
 * Captures a MediaStream as 16 kHz mono PCM through an AudioWorklet. The audio graph ends in a
 * silent gain node: it keeps the worklet running without ever playing the microphone back.
 */
export class WebAudioCapture implements AudioCapture {
  private active: Active | null = null

  constructor(private readonly emit: (chunk: PcmChunk) => void) {}

  async start(stream: unknown, request: AudioCaptureStart): Promise<Result<void>> {
    this.teardown()
    const rate = request.format.sampleRateHz
    let context: AudioContext | null = null
    try {
      context = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' })
      // The browser resamples the device to the context rate; a different rate would shift every
      // timestamp VAD reports, so refuse rather than carry on.
      if (context.sampleRate !== rate) {
        await context.close()
        return failure('unsupported', '요청한 샘플레이트로 오디오를 수집할 수 없습니다.')
      }
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
      try {
        await context.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const session = new CaptureSession({
        generation: request.generation,
        format: request.format,
        bufferSeconds: BUFFER_SECONDS,
        chunkMs: CHUNK_MS,
        emit: this.emit
      })
      const source = context.createMediaStreamSource(stream as MediaStream)
      const worklet = new AudioWorkletNode(context, 'jarvis-pcm', { numberOfOutputs: 1 })
      const silence = context.createGain()
      silence.gain.value = 0
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => session.ingest(event.data)
      source.connect(worklet)
      worklet.connect(silence)
      silence.connect(context.destination)
      this.active = { session, context, nodes: [source, worklet, silence] }
      await context.resume()
      return { ok: true, value: undefined }
    } catch {
      this.teardown()
      void context?.close().catch(() => undefined)
      return failure('internal', '오디오 수집을 시작하지 못했습니다.')
    }
  }

  stop(generation: Generation): void {
    if (this.active && sameGeneration(this.active.session.generation, generation)) this.teardown()
  }

  clear(generation: Generation): Result<void> {
    if (!this.active || !sameGeneration(this.active.session.generation, generation))
      return failure('not_found', '해당 오디오 수집이 없습니다.')
    this.active.session.clear()
    return { ok: true, value: undefined }
  }

  extract(range: UtteranceRange): Result<CompletedUtterance> {
    if (!this.active) return failure('not_found', '오디오 수집이 진행 중이 아닙니다.')
    return this.active.session.extract(range)
  }

  dispose(): void {
    this.teardown()
  }

  private teardown(): void {
    const active = this.active
    this.active = null
    if (!active) return
    active.session.dispose()
    for (const node of active.nodes) node.disconnect()
    void active.context.close().catch(() => undefined)
  }
}
