import type { AuthPort } from '../auth/auth-manager'
import type { ConversationPort } from '../conversation/ports'
import { startHandSelfTest } from '../gesture/dev-hand-selftest'
import type { HandTrackingService } from '../gesture/hand-tracking'
import { startSensorSelfTest } from '../sensors/dev-selftest'
import type { SensorManager } from '../sensors/sensor-manager'
import { startSpeechSelfTest, startVoiceSelfTest } from '../speech/dev-voice-selftest'
import type { VoiceStack } from '../speech/create-voice'
import type { SpeechSessionPort } from '../speech/session/ports'
import { startToolSelfTest } from '../tools/dev-tool-selftest'
import type { ToolStack } from '../tools/create-tools'
import { releaseAll } from './release-all'

/** `0` (or `forever`) keeps tracking until sign-out or quit; otherwise the number of seconds. */
export function parseHandSelfTestSeconds(value: string): number {
  if (value === 'forever') return 0
  const seconds = Number.parseInt(value, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 5
}

interface SelfTestOptions {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  auth: Pick<AuthPort, 'subscribe'>
  sensors: SensorManager
  voice: { input: VoiceStack['input']; session: SpeechSessionPort }
  conversation: ConversationPort
  handTracking: HandTrackingService
  tools: ToolStack
}

/**
 * Development-only checks that exercise the real stack without a consumer feature, each switched on
 * by its own environment variable. Nothing here runs in a packaged app.
 */
export function startDevSelfTests(options: SelfTestOptions): () => void {
  if (options.isPackaged) return () => undefined
  const { env, auth } = options
  const releases: (() => void)[] = []
  if (env.JARVIS_SENSOR_SELFTEST === '1') releases.push(startSensorSelfTest(auth, options.sensors))
  if (env.JARVIS_SPEECH_SELFTEST === '1')
    releases.push(startSpeechSelfTest(auth, options.voice.session, options.conversation))
  if (env.JARVIS_VOICE_SELFTEST)
    releases.push(
      startVoiceSelfTest(
        Math.max(1, Number.parseInt(env.JARVIS_VOICE_SELFTEST, 10) || 1),
        auth,
        options.voice.input
      )
    )
  if (env.JARVIS_HAND_SELFTEST)
    releases.push(
      startHandSelfTest(
        parseHandSelfTestSeconds(env.JARVIS_HAND_SELFTEST),
        auth,
        options.handTracking
      )
    )
  if (env.JARVIS_TOOL_SELFTEST)
    releases.push(startToolSelfTest(env.JARVIS_TOOL_SELFTEST, auth, options.tools))
  return releaseAll(releases)
}
