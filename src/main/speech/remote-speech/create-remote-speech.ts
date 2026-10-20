import { DevRemoteSpeech } from './dev-remote-speech'
import type { RemoteSpeechPort } from './ports'
import type { AssistantPort } from '../../conversation/ports'
import { unavailableAssistant, unavailableRemoteSpeech } from './unavailable-remote-speech'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
}

/** The stand-in needs an unpackaged app and an explicit JARVIS_DEV_SPEECH=1. */
export function createRemoteSpeech({ isPackaged, env }: Selection): {
  speech: RemoteSpeechPort
  assistant: AssistantPort
} {
  if (!isPackaged && env.JARVIS_DEV_SPEECH === '1') {
    const turns = Number.parseInt(env.JARVIS_DEV_SPEECH_TURNS ?? '', 10)
    const server = new DevRemoteSpeech({
      endAfterTurns: Number.isFinite(turns) && turns > 0 ? turns : 2
    })
    return { speech: server, assistant: server }
  }
  return { speech: unavailableRemoteSpeech, assistant: unavailableAssistant }
}
