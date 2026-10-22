import { DevRemoteSpeech } from './dev-remote-speech'
import type { RemoteSpeechPort } from './ports'
import type { AssistantPort } from '../../conversation/ports'
import { ServerAssistant } from '../../conversation/server-assistant'
import type { ServerClient } from '../../connection/server-client'
import { ServerSpeech } from './server-speech'
import { ServerSynthesizer } from './server-synthesis'
import { unavailableAssistant, unavailableRemoteSpeech } from './unavailable-remote-speech'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The client for server calls; null when there is no usable server. */
  api?: ServerClient | null
  /** Whether answers to spoken requests are to be read aloud (the device's setting). */
  speechOutputEnabled?(): boolean
}

/**
 * The stand-in needs an unpackaged app and an explicit JARVIS_DEV_SPEECH=1, and wins over a
 * server so that choosing it is always deliberate. With a server, typed and spoken input are both
 * answered by it.
 */
export function createRemoteSpeech({
  isPackaged,
  env,
  api = null,
  speechOutputEnabled
}: Selection): {
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
  if (api) {
    // One adapter holds both, because a spoken request and its answer are the same server request.
    const assistant = new ServerAssistant({
      client: api,
      synthesizer: new ServerSynthesizer(api),
      ...(speechOutputEnabled ? { speechEnabled: speechOutputEnabled } : {})
    })
    return { speech: new ServerSpeech(assistant), assistant }
  }
  return { speech: unavailableRemoteSpeech, assistant: unavailableAssistant }
}
