/**
 * Runs inside an Electron utilityProcess so model inference never blocks Main and a crash here
 * cannot take the app down. Talks to Main only through the validated messages in protocol.ts.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { ClientError } from '../../shared/contracts/common'
import { VAD_SAMPLE_RATE_HZ, VadWorkerRequestSchema } from './protocol'
import type { VadWorkerMessage } from './protocol'
import { SileroSegmenter } from './silero-segmenter'
import type { SherpaModule } from './silero-segmenter'
import { VadEngine } from './vad-engine'
import type { VadPolicy } from './vad-policy'

interface ParentPort {
  postMessage(message: VadWorkerMessage): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
const send = (message: VadWorkerMessage) => parentPort?.postMessage(message)
const fail = (error: ClientError) => send({ type: 'error', error })

let sherpa: SherpaModule | null = null
let modelPath: string | null = null
let engine: VadEngine | null = null

function createEngine(policy: VadPolicy): VadEngine {
  if (!sherpa || !modelPath) throw new Error('worker is not initialised')
  return new VadEngine({
    segmenter: new SileroSegmenter(sherpa, modelPath, policy, VAD_SAMPLE_RATE_HZ),
    policy,
    sampleRateHz: VAD_SAMPLE_RATE_HZ,
    createId: randomUUID
  })
}

function toFloat(audio: Uint8Array): Float32Array {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const out = new Float32Array(audio.byteLength >> 1)
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

parentPort?.on('message', ({ data }) => {
  const parsed = VadWorkerRequestSchema.safeParse(data)
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'VAD 요청 형식이 올바르지 않습니다.' })
  const request = parsed.data
  try {
    switch (request.type) {
      case 'init':
        modelPath = request.modelPath
        // The native module is loaded once, here, so a load failure is reported to Main.
        sherpa = createRequire(__filename)('sherpa-onnx-node') as SherpaModule
        return send({ type: 'ready' })
      case 'start':
        engine = createEngine(request.policy)
        return engine.start(request.generation, request.firstSample)
      case 'pcm': {
        if (!engine?.active) return
        for (const event of engine.push(request.startSample, toFloat(request.audio)))
          send({ type: 'event', event })
        return
      }
      case 'stop':
        engine?.stop()
        engine = null
        return
    }
  } catch {
    fail({ code: 'internal', message: 'VAD 처리 중 오류가 발생했습니다.' })
  }
})
