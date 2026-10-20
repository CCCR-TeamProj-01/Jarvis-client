import { DevRemoteSpeech } from './dev-remote-speech'
import type { RemoteSpeechPort } from './ports'
import { unavailableRemoteSpeech } from './unavailable-remote-speech'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
}

/** The stand-in needs an unpackaged app and an explicit JARVIS_DEV_SPEECH=1. */
export function createRemoteSpeech({ isPackaged, env }: Selection): RemoteSpeechPort {
  if (!isPackaged && env.JARVIS_DEV_SPEECH === '1') {
    const turns = Number.parseInt(env.JARVIS_DEV_SPEECH_TURNS ?? '', 10)
    return new DevRemoteSpeech({ endAfterTurns: Number.isFinite(turns) && turns > 0 ? turns : 2 })
  }
  return unavailableRemoteSpeech
}
