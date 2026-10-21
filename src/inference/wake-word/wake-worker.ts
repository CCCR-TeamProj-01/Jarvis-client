import { WakeWorkerRequestSchema } from './protocol'
import type { WakeWorkerMessage } from './protocol'
import { VoskNative } from './vosk-native'
import { WakeEngine } from './wake-engine'

interface ParentPort {
  postMessage(message: WakeWorkerMessage): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort
const send = (message: WakeWorkerMessage) => parent?.postMessage(message)
let native: VoskNative | null = null
let engine: WakeEngine | null = null
parent?.on('message', ({ data }) => {
  const parsed = WakeWorkerRequestSchema.safeParse(data)
  if (!parsed.success)
    return send({
      type: 'error',
      error: { code: 'invalid_input', message: '호출어 입력 형식이 올바르지 않습니다.' }
    })
  const request = parsed.data
  try {
    switch (request.type) {
      case 'init':
        if (native) throw new Error('already initialised')
        native = new VoskNative(request.libraryPath, request.modelPath)
        engine = new WakeEngine(native)
        return send({ type: 'ready' })
      case 'start':
        if (!engine) throw new Error('not ready')
        return engine.start(request.generation)
      case 'pcm': {
        if (!engine) throw new Error('not ready')
        const event = engine.push(request.chunk)
        send({
          type: 'consumed',
          generation: request.chunk.generation,
          sequence: request.chunk.sequence
        })
        if (event) send({ type: 'event', event })
        return
      }
      case 'stop':
        return engine?.stop()
    }
  } catch {
    engine?.stop()
    send({
      type: 'error',
      error: {
        code: 'unavailable',
        message: '호출어 모델을 실행하지 못했습니다. 모델 설치와 실행 환경을 확인해 주세요.'
      }
    })
  }
})
