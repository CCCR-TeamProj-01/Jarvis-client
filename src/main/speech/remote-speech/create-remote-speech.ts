import { DevRemoteSpeech } from './dev-remote-speech'
import type { RemoteSpeechPort } from './ports'
import type { AssistantPort } from '../../conversation/ports'
import { ServerAssistant } from '../../conversation/server-assistant'
import type { ServerClient } from '../../connection/server-client'
import { unavailableAssistant, unavailableRemoteSpeech } from './unavailable-remote-speech'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The client for server calls; null when there is no usable server. */
  api?: ServerClient | null
}

/**
 * The stand-in needs an unpackaged app and an explicit JARVIS_DEV_SPEECH=1, and wins over a
 * server so that choosing it is always deliberate. With a server, typed input is answered by it;
 * recognising speech there is not connected yet, so the speech side stays unreachable.
 */
export function createRemoteSpeech({ isPackaged, env, api = null }: Selection): {
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
  if (api)
    return { speech: unavailableRemoteSpeech, assistant: new ServerAssistant({ client: api }) }
  return { speech: unavailableRemoteSpeech, assistant: unavailableAssistant }
}
