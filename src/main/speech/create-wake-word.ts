import { utilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { modelPath } from '../models'
import type { AuthManager } from '../auth/auth-manager'
import type { InteractionManager } from '../interaction/interaction-manager'
import type { SensorManager } from '../sensors/sensor-manager'
import type { VoiceStack } from './create-voice'
import { UtilityProcessWake } from './wake-process'
import { WakeWordController } from './wake-word'

export function createWakeWord(options: {
  auth: AuthManager
  interaction: InteractionManager
  sensors: SensorManager
  voice: VoiceStack
  capturePreviousApp(): void
}): () => void {
  const schedule = (callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return () => clearTimeout(timer)
  }
  const detector = new UtilityProcessWake({
    spawn: () => {
      const child = utilityProcess.fork(join(__dirname, 'wake-worker.js'), [], {
        serviceName: 'jarvis-wake-word',
        stdio: 'ignore'
      })
      return {
        postMessage: (message) => child.postMessage(message),
        onMessage: (listener) => {
          child.on('message', listener)
        },
        onExit: (listener) => {
          child.on('exit', listener)
        },
        kill: () => {
          child.kill()
        }
      }
    },
    assets: () => {
      const platform =
        process.platform === 'darwin'
          ? 'osx-universal/libvosk.dylib'
          : process.platform === 'win32' && process.arch === 'x64'
            ? 'win-x86_64/libvosk.dll'
            : null
      if (!platform) return null
      const model = modelPath('vosk-model-small-ko-0.22')
      const library = modelPath(`vosk-native/${platform}`)
      return existsSync(join(model, 'am/final.mdl')) && existsSync(library)
        ? { modelPath: model, libraryPath: library }
        : null
    },
    schedule
  })
  const controller = new WakeWordController({
    detector,
    sensors: options.sensors,
    router: options.voice.router,
    createId: randomUUID,
    schedule,
    onState: (snapshot) => options.interaction.setWakeWordState(snapshot),
    onWake: (_event, continuation) => {
      options.capturePreviousApp()
      return options.voice.session.activate('voice', continuation)
    }
  })
  const sync = () => {
    const snapshot = options.interaction.getSnapshot()
    controller.setAllowed(
      snapshot.auth.phase === 'signed_in' &&
        !snapshot.recognitionPaused &&
        snapshot.speech.phase === 'idle' &&
        snapshot.request.phase === 'idle'
    )
  }
  const stopState = options.interaction.subscribe((event) => {
    if (event.type === 'state.changed') sync()
  })
  const stopAuth = options.auth.onGenerationChange(() => {
    controller.setEnabled(false)
    sync()
  })
  options.interaction.setWakeWordHandler((enabled) => controller.setEnabled(enabled))
  options.interaction.setWakeWordState({ enabled: false, phase: 'off' })
  sync()
  return () => {
    stopState()
    stopAuth()
    options.interaction.setWakeWordHandler(null)
    controller.dispose()
    detector.dispose()
  }
}
