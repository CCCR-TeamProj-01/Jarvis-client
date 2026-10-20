import type { AuthManager } from '../auth/auth-manager'
import type { ConversationManager } from '../conversation/conversation-manager'
import type { GestureController } from '../gesture/gesture-controller'
import type { InteractionManager } from '../interaction/interaction-manager'
import type { SensorManager } from '../sensors/sensor-manager'
import type { VoiceStack } from '../speech/create-voice'
import type { ToolStack } from '../tools/create-tools'
import { releaseAll } from './release-all'

interface StateSyncOptions {
  auth: AuthManager
  interaction: InteractionManager
  sensors: SensorManager
  tools: ToolStack
  voice: Pick<VoiceStack, 'session'>
  conversation: ConversationManager
  gesture: GestureController
}

/**
 * Connects the app's parts to Main's interaction state, which is what the window, the tray and the
 * overlay all read: commands go in through the handlers, and sensor, conversation, speech and
 * gesture state and the words for the user come out. Signing out or pausing recognition ends
 * everything that was running. Returns the function that disconnects it all.
 */
export function connectAppState({
  auth,
  interaction,
  sensors,
  tools,
  voice,
  conversation,
  gesture
}: StateSyncOptions): () => void {
  const speechSession = voice.session

  // Main's authentication state is the source for the snapshot the UI and every entry point see.
  // Any change of generation (sign-out, expiry re-check, account switch) also ends sensor use.
  const stopAuth = auth.onGenerationChange((snapshot) => {
    interaction.setAuthSnapshot(snapshot)
    // The previous user's tool history, pending work and "go back" target must not carry over.
    tools.executor.resetForNewSession()
    tools.restoreTracker.clear()
    // A conversation belongs to the user who started it.
    void speechSession.stop()
    void conversation.end()
    void gesture.stop()
    void sensors.revokeAll({
      code: 'authentication_required',
      message: '로그인 상태가 변경되어 센서를 해제했습니다.'
    })
  })
  const stopSensorSnapshots = sensors.subscribe((event) => {
    if (event.type === 'sensor.state_changed') interaction.setSensors(sensors.getSnapshots())
  })
  let recognitionWasPaused = false
  const stopPauseWatch = interaction.subscribe((event) => {
    if (event.type !== 'state.changed') return
    const paused = event.snapshot.recognitionPaused
    if (paused && !recognitionWasPaused) {
      void speechSession.stop()
      void conversation.end()
      void gesture.stop()
      void sensors.revokeAll({
        code: 'cancelled',
        message: '인식이 일시 중지되어 센서를 해제했습니다.'
      })
    }
    recognitionWasPaused = paused
  })

  // Commands, state and the words shown to the user all go through Main's interaction state.
  interaction.setConversationHandlers({
    // Starting means a conversation with the voice side attached (the call shortcut, tray, button).
    start: () => speechSession.activate('ui'),
    submitText: (text) => conversation.submit({ text, modality: 'text' }),
    stop: async () => {
      await speechSession.stop()
      return conversation.end()
    }
  })
  interaction.setGestureHandlers({
    start: () => gesture.start({ activeHand: 'auto_lock', displayId: 'primary' }),
    stop: () => gesture.stop()
  })
  const stops = [
    gesture.subscribe((snapshot) => interaction.setGestureState(snapshot)),
    gesture.subscribeProblems((error) => interaction.publishNotice({ type: 'problem', error })),
    conversation.subscribe((snapshot) => {
      interaction.setConversationState(snapshot)
      // Without a conversation there is nothing to listen for. A reply being worked on or spoken
      // is let finish (it may be the final one): the session ends on its own right after it.
      const phase = speechSession.getSnapshot().phase
      if (snapshot.phase === 'idle' && phase !== 'processing' && phase !== 'speaking')
        void speechSession.stop()
    }),
    speechSession.subscribe((snapshot) => interaction.setSpeechState(snapshot)),
    conversation.subscribeNotices((notice) => interaction.publishNotice(notice)),
    speechSession.subscribeNotices((notice) => interaction.publishNotice(notice))
  ]
  return releaseAll([
    stopAuth,
    stopSensorSnapshots,
    stopPauseWatch,
    ...stops,
    () => interaction.setConversationHandlers(null),
    () => interaction.setGestureHandlers(null)
  ])
}
