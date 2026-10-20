/// <reference lib="webworker" />
import { HandLandmarker } from '@mediapipe/tasks-vision'
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url'
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url'
import { toHandObservations } from './landmarks'
import type { WorkerRequest, WorkerResponse } from './worker-protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope
const reply = (response: WorkerResponse) => scope.postMessage(response)

let landmarker: HandLandmarker | null = null
let lastTimestamp = -1

async function init(model: Uint8Array): Promise<void> {
  try {
    // The module build of the engine is the one a module worker can load.
    landmarker = await HandLandmarker.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      {
        baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2
      }
    )
    reply({ type: 'ready' })
  } catch (error) {
    reply({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  }
}

function detect(id: number, image: ImageBitmap, timestampMs: number): void {
  try {
    if (!landmarker) throw new Error('hand landmarker is not ready')
    // The engine requires strictly increasing timestamps in VIDEO mode.
    lastTimestamp = Math.max(Math.round(timestampMs), lastTimestamp + 1)
    const result = landmarker.detectForVideo(image, lastTimestamp)
    reply({ type: 'result', id, hands: toHandObservations(result) })
  } catch (error) {
    reply({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    image.close()
  }
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'init') void init(request.model)
  else detect(request.id, request.image, request.timestampMs)
}
