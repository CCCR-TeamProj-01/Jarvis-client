import { app, utilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceActivityDetectorPort } from '../../inference/ports'
import type { SensorStack } from '../sensors/create-sensors'
import type { SensorGate } from '../sensors/hardware'
import { AudioInputRouter } from './audio-input'
import { UtilityProcessVad } from './vad-process'
import type { VadProcess } from './vad-process'
import { MediaAudioPlayback } from './playback'
import { createRemoteSpeech } from './remote-speech/create-remote-speech'
import { SpeechSessionController } from './session/speech-session'
import { VoiceInput } from './voice-input'

export interface VoiceStack {
  router: AudioInputRouter
  vad: VoiceActivityDetectorPort & { dispose(): void }
  input: VoiceInput
  playback: MediaAudioPlayback
  session: SpeechSessionController
}

export const VAD_MODEL_FILE = 'silero_vad.onnx'

/** Models are fetched into resources/models in development and shipped under resources/ in builds. */
export function modelPath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'models', file)
    : join(app.getAppPath(), 'resources', 'models', file)
}

const schedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

function spawnVadProcess(): VadProcess {
  // The worker is bundled next to the main entry (see electron.vite.config.ts).
  const child = utilityProcess.fork(join(__dirname, 'vad-worker.js'), [], {
    serviceName: 'jarvis-vad',
    stdio: 'ignore'
  })
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', listener)
    },
    onExit: (listener) => {
      child.on('exit', (code) => listener(code))
    },
    kill: () => child.kill()
  }
}

export function createVoiceStack(sensors: SensorStack, gate: SensorGate): VoiceStack {
  const router = new AudioInputRouter({ bridge: sensors.bridge, schedule })
  const vad = new UtilityProcessVad({
    spawn: spawnVadProcess,
    modelPath: () => modelPath(VAD_MODEL_FILE),
    schedule,
    // A missing model is a setup problem to name clearly, not a mysterious worker failure.
    modelAvailable: () => existsSync(modelPath(VAD_MODEL_FILE))
  })
  const input = new VoiceInput({
    sensors: sensors.sensors,
    router,
    vad,
    clock: { now: () => performance.now() },
    schedule
  })
  const playback = new MediaAudioPlayback(sensors.bridge)
  const session = new SpeechSessionController({
    gate,
    voice: input,
    remote: createRemoteSpeech({ isPackaged: app.isPackaged, env: process.env }),
    playback,
    clock: { now: () => performance.now() },
    createId: randomUUID,
    schedule
  })
  return { router, vad, input, playback, session }
}
