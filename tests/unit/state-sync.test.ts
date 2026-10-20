import { describe, expect, it, vi } from 'vitest'
import { connectAppState } from '../../src/main/application/state-sync'
import type { ConversationNotice } from '../../src/main/conversation/ports'
import type { UiEvent } from '../../src/shared/contracts/interaction'

function setup() {
  const listeners = {
    generation: null as null | ((snapshot: unknown) => void),
    interaction: null as null | ((event: UiEvent) => void),
    conversation: null as null | ((snapshot: { phase: string }) => void),
    notices: null as null | ((notice: ConversationNotice) => void),
    speechNotices: null as null | ((notice: unknown) => void),
    gestureProblems: null as null | ((error: unknown) => void),
    speech: null as null | ((snapshot: unknown) => void),
    gesture: null as null | ((snapshot: unknown) => void),
    sensors: null as null | ((event: { type: string }) => void)
  }
  const unsubscribe = vi.fn<() => void>()
  const interaction = {
    setAuthSnapshot: vi.fn<(snapshot: unknown) => void>(),
    setSensors: vi.fn<(sensors: unknown) => void>(),
    setConversationHandlers: vi.fn<(handlers: unknown) => void>(),
    setGestureHandlers: vi.fn<(handlers: unknown) => void>(),
    setConversationState: vi.fn<(snapshot: unknown) => void>(),
    setSpeechState: vi.fn<(snapshot: unknown) => void>(),
    setGestureState: vi.fn<(snapshot: unknown) => void>(),
    publishNotice: vi.fn<(notice: unknown) => void>(),
    subscribe: (listener: (event: UiEvent) => void) => {
      listeners.interaction = listener
      return unsubscribe
    }
  }
  const sessionStop = vi.fn<() => Promise<void>>(async () => undefined)
  const speechPhase = { value: 'idle' }
  const voice = {
    session: {
      stop: sessionStop,
      activate: vi.fn<(source: string) => Promise<unknown>>(async () => ({ ok: true })),
      getSnapshot: () => ({ phase: speechPhase.value }),
      subscribe: (listener: (snapshot: unknown) => void) => {
        listeners.speech = listener
        return unsubscribe
      },
      subscribeNotices: (listener: (notice: unknown) => void) => {
        listeners.speechNotices = listener
        return unsubscribe
      }
    }
  }
  const conversation = {
    end: vi.fn<() => Promise<{ ok: true }>>(async () => ({ ok: true })),
    submit: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ ok: true })),
    subscribe: (listener: (snapshot: { phase: string }) => void) => {
      listeners.conversation = listener
      return unsubscribe
    },
    subscribeNotices: (listener: (notice: ConversationNotice) => void) => {
      listeners.notices = listener
      return unsubscribe
    }
  }
  const gesture = {
    stop: vi.fn<() => Promise<unknown>>(async () => ({ ok: true })),
    start: vi.fn<(settings: unknown) => Promise<unknown>>(async () => ({ ok: true })),
    subscribe: (listener: (snapshot: unknown) => void) => {
      listeners.gesture = listener
      return unsubscribe
    },
    subscribeProblems: (listener: (error: unknown) => void) => {
      listeners.gestureProblems = listener
      return unsubscribe
    }
  }
  const sensors = {
    revokeAll: vi.fn<(error: unknown) => Promise<void>>(async () => undefined),
    getSnapshots: () => [{ kind: 'camera' }],
    subscribe: (listener: (event: { type: string }) => void) => {
      listeners.sensors = listener
      return unsubscribe
    }
  }
  const tools = {
    executor: { resetForNewSession: vi.fn<() => void>() },
    restoreTracker: { clear: vi.fn<() => void>() }
  }
  const auth = {
    onGenerationChange: (listener: (snapshot: unknown) => void) => {
      listeners.generation = listener
      return unsubscribe
    }
  }
  const dispose = connectAppState({
    auth: auth as never,
    interaction: interaction as never,
    sensors: sensors as never,
    tools: tools as never,
    voice: voice as never,
    conversation: conversation as never,
    gesture: gesture as never
  })
  return {
    listeners,
    interaction,
    voice,
    conversation,
    gesture,
    sensors,
    tools,
    dispose,
    unsubscribe,
    speechPhase
  }
}

const state = (recognitionPaused: boolean): UiEvent =>
  ({ type: 'state.changed', snapshot: { recognitionPaused } }) as UiEvent

describe('connectAppState', () => {
  it('ends everything the previous user had when the sign-in changes', () => {
    const t = setup()
    t.listeners.generation?.({ phase: 'signed_out' })
    expect(t.interaction.setAuthSnapshot).toHaveBeenCalledWith({ phase: 'signed_out' })
    expect(t.tools.executor.resetForNewSession).toHaveBeenCalledOnce()
    expect(t.tools.restoreTracker.clear).toHaveBeenCalledOnce()
    expect(t.voice.session.stop).toHaveBeenCalled()
    expect(t.conversation.end).toHaveBeenCalled()
    expect(t.gesture.stop).toHaveBeenCalled()
    expect(t.sensors.revokeAll).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'authentication_required' })
    )
  })

  it('ends them when recognition becomes paused, once per pause', () => {
    const t = setup()
    t.listeners.interaction?.(state(false))
    expect(t.sensors.revokeAll).not.toHaveBeenCalled()
    t.listeners.interaction?.(state(true))
    t.listeners.interaction?.(state(true))
    expect(t.sensors.revokeAll).toHaveBeenCalledOnce()
    expect(t.sensors.revokeAll).toHaveBeenCalledWith(expect.objectContaining({ code: 'cancelled' }))
    expect(t.gesture.stop).toHaveBeenCalledOnce()
    t.listeners.interaction?.(state(false))
    t.listeners.interaction?.(state(true))
    expect(t.sensors.revokeAll).toHaveBeenCalledTimes(2)
  })

  it('passes sensor changes on but ignores other sensor events', () => {
    const t = setup()
    t.listeners.sensors?.({ type: 'sensor.devices_changed' })
    expect(t.interaction.setSensors).not.toHaveBeenCalled()
    t.listeners.sensors?.({ type: 'sensor.state_changed' })
    expect(t.interaction.setSensors).toHaveBeenCalledWith([{ kind: 'camera' }])
  })

  it('connects the conversation, speech and gesture state and the notices', () => {
    const t = setup()
    t.listeners.conversation?.({ phase: 'active' })
    t.listeners.speech?.({ phase: 'listening' })
    t.listeners.gesture?.({ phase: 'tracking' })
    t.listeners.notices?.({ type: 'problem', error: { code: 'internal', message: 'x' } })
    t.listeners.speechNotices?.({ type: 'problem' })
    t.listeners.gestureProblems?.({ code: 'permission_denied', message: 'y' })
    expect(t.interaction.setConversationState).toHaveBeenCalledWith({ phase: 'active' })
    expect(t.interaction.setSpeechState).toHaveBeenCalledWith({ phase: 'listening' })
    expect(t.interaction.setGestureState).toHaveBeenCalledWith({ phase: 'tracking' })
    expect(t.interaction.publishNotice).toHaveBeenCalledTimes(3)
    expect(t.interaction.publishNotice).toHaveBeenCalledWith({
      type: 'problem',
      error: { code: 'permission_denied', message: 'y' }
    })
  })

  it('stops the voice session when the conversation is gone, unless a reply is still being delivered', () => {
    const t = setup()
    t.listeners.conversation?.({ phase: 'idle' })
    expect(t.voice.session.stop).toHaveBeenCalledOnce()
    t.speechPhase.value = 'speaking'
    t.listeners.conversation?.({ phase: 'idle' })
    t.speechPhase.value = 'processing'
    t.listeners.conversation?.({ phase: 'idle' })
    t.listeners.conversation?.({ phase: 'active' })
    expect(t.voice.session.stop).toHaveBeenCalledOnce()
  })

  it('wires the commands: a conversation with voice, typed text, and the gesture mode', async () => {
    const t = setup()
    const conversationHandlers = t.interaction.setConversationHandlers.mock.calls[0]?.[0] as {
      start(): Promise<unknown>
      submitText(text: string): Promise<unknown>
      stop(): Promise<unknown>
    }
    await conversationHandlers.start()
    await conversationHandlers.submitText('안녕')
    await conversationHandlers.stop()
    expect(t.voice.session.activate).toHaveBeenCalledWith('ui')
    expect(t.conversation.submit).toHaveBeenCalledWith({ text: '안녕', modality: 'text' })
    expect(t.voice.session.stop).toHaveBeenCalled()
    expect(t.conversation.end).toHaveBeenCalled()
    const gestureHandlers = t.interaction.setGestureHandlers.mock.calls[0]?.[0] as {
      start(): Promise<unknown>
      stop(): Promise<unknown>
    }
    await gestureHandlers.start()
    expect(t.gesture.start).toHaveBeenCalledWith({ activeHand: 'auto_lock', displayId: 'primary' })
  })

  it('disconnects everything and removes the command handlers', () => {
    const t = setup()
    t.dispose()
    expect(t.unsubscribe).toHaveBeenCalledTimes(9)
    expect(t.interaction.setConversationHandlers).toHaveBeenLastCalledWith(null)
    expect(t.interaction.setGestureHandlers).toHaveBeenLastCalledWith(null)
  })
})
