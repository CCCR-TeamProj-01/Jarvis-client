import { describe, expect, it, vi } from 'vitest'
import { InteractionManager } from '../../src/main/interaction/interaction-manager'
import type { ConversationHandlers } from '../../src/main/interaction/interaction-manager'
import type { AuthSnapshot } from '../../src/shared/contracts/auth'
import type { UiEvent } from '../../src/shared/contracts/interaction'
import { authGeneration, authUser } from '../fixtures/contracts'

const signedIn: AuthSnapshot = { phase: 'signed_in', generation: authGeneration, user: authUser }
const signedOut: AuthSnapshot = { phase: 'signed_out', generation: authGeneration, user: null }

function setup(auth: AuthSnapshot = signedIn) {
  const showWindow = vi.fn<() => void>()
  const manager = new InteractionManager({
    auth,
    accelerator: 'CommandOrControl+Shift+Space',
    now: () => 100,
    createId: () => 'command-1',
    showWindow,
    quit: vi.fn<() => void>()
  })
  const events: UiEvent[] = []
  manager.subscribe((event) => events.push(event))
  const handlers = {
    start: vi.fn<ConversationHandlers['start']>(async () => ({
      ok: true,
      value: { sessionId: 's', revision: 0 }
    })),
    submitText: vi.fn<ConversationHandlers['submitText']>(async () => ({
      ok: true,
      value: undefined
    })),
    stop: vi.fn<ConversationHandlers['stop']>(async () => ({ ok: true, value: undefined }))
  }
  return { manager, showWindow, events, handlers }
}

describe('conversation commands', () => {
  it('reports itself unsupported until a conversation is connected', async () => {
    const { manager } = setup()
    expect(await manager.dispatch({ type: 'conversation.start' })).toMatchObject({
      ok: false,
      error: { code: 'unsupported' }
    })
  })

  it('starts through the connected handler for a signed-in user', async () => {
    const { manager, handlers } = setup()
    manager.setConversationHandlers(handlers)
    expect(await manager.dispatch({ type: 'conversation.start' })).toMatchObject({ ok: true })
    expect(handlers.start).toHaveBeenCalledOnce()
  })

  it('does not start before sign-in and sends the user to the login screen', async () => {
    const { manager, handlers, showWindow } = setup(signedOut)
    manager.setConversationHandlers(handlers)
    expect(await manager.dispatch({ type: 'conversation.start' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(handlers.start).not.toHaveBeenCalled()
    expect(showWindow).toHaveBeenCalled()
  })

  it('passes a refusal from the conversation back to the caller', async () => {
    const { manager, handlers } = setup()
    handlers.start.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: '인식이 일시 중지되어 있습니다.' }
    })
    manager.setConversationHandlers(handlers)
    expect(await manager.dispatch({ type: 'conversation.start' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
  })

  it('always lets the user stop, even signed out or with nothing connected', async () => {
    const { manager, handlers } = setup(signedOut)
    expect(await manager.dispatch({ type: 'conversation.stop' })).toMatchObject({ ok: true })
    manager.setConversationHandlers(handlers)
    expect(await manager.dispatch({ type: 'conversation.stop' })).toMatchObject({ ok: true })
    expect(handlers.stop).toHaveBeenCalledOnce()
  })

  it('stops reaching a disconnected conversation', async () => {
    const { manager, handlers } = setup()
    manager.setConversationHandlers(handlers)
    manager.setConversationHandlers(null)
    expect(await manager.dispatch({ type: 'conversation.start' })).toMatchObject({ ok: false })
    expect(handlers.start).not.toHaveBeenCalled()
  })
})

describe('typed messages', () => {
  it('sends text to the conversation for a signed-in user', async () => {
    const { manager, handlers } = setup()
    manager.setConversationHandlers(handlers)
    expect(
      await manager.dispatch({ type: 'conversation.submit_text', text: '안녕' })
    ).toMatchObject({
      ok: true
    })
    expect(handlers.submitText).toHaveBeenCalledWith('안녕')
  })

  it('does not accept text before sign-in', async () => {
    const { manager, handlers, showWindow } = setup(signedOut)
    manager.setConversationHandlers(handlers)
    expect(
      await manager.dispatch({ type: 'conversation.submit_text', text: '안녕' })
    ).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(handlers.submitText).not.toHaveBeenCalled()
    expect(showWindow).toHaveBeenCalled()
  })

  it('reports a refusal and is unsupported until a conversation is connected', async () => {
    const unconnected = setup()
    expect(
      await unconnected.manager.dispatch({ type: 'conversation.submit_text', text: 'x' })
    ).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    const { manager, handlers } = setup()
    handlers.submitText.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: '이전 요청을 처리하고 있어요.' }
    })
    manager.setConversationHandlers(handlers)
    expect(await manager.dispatch({ type: 'conversation.submit_text', text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
  })
})

describe('conversation and speech state', () => {
  const generation = { sessionId: 's', revision: 3 }

  it('takes the conversation and request views from the conversation, not from speech', () => {
    const { manager } = setup()
    manager.setSpeechState({ phase: 'listening', generation })
    expect(manager.getSnapshot()).toMatchObject({
      speech: { phase: 'listening' },
      conversation: { phase: 'idle', generation: null },
      request: { phase: 'idle' }
    })
    manager.setConversationState({
      phase: 'active',
      conversationId: 'conv-1',
      version: 4,
      request: { requestId: 'req-1', phase: 'processing' }
    })
    expect(manager.getSnapshot()).toMatchObject({
      speech: { phase: 'listening' },
      conversation: { phase: 'active', generation: { sessionId: 'conv-1', revision: 4 } },
      request: { requestId: 'req-1', phase: 'processing' }
    })
    manager.setConversationState({
      phase: 'idle',
      conversationId: null,
      version: 5,
      request: { requestId: null, phase: 'idle' }
    })
    expect(manager.getSnapshot()).toMatchObject({
      conversation: { phase: 'idle', generation: null },
      request: { phase: 'idle' }
    })
  })

  it('allows a text-only conversation with no voice session', () => {
    const { manager } = setup()
    manager.setConversationState({
      phase: 'active',
      conversationId: 'conv-1',
      version: 1,
      request: { requestId: null, phase: 'idle' }
    })
    expect(manager.getSnapshot()).toMatchObject({
      conversation: { phase: 'active' },
      speech: { phase: 'idle', generation: null }
    })
  })

  it('turns notices into UI events without putting them in the state', () => {
    const { manager, events } = setup()
    const revision = manager.getSnapshot().revision
    manager.publishNotice({ type: 'user', requestId: 'r', text: '안녕', modality: 'text' })
    manager.publishNotice({ type: 'assistant', requestId: 'r', text: '반가워요' })
    manager.publishNotice({ type: 'problem', error: { code: 'unavailable', message: '실패' } })
    expect(events).toEqual([
      { type: 'result.available', requestId: 'r', text: '나: 안녕' },
      { type: 'result.available', requestId: 'r', text: '자비스: 반가워요' },
      { type: 'client.error', error: { code: 'unavailable', message: '실패' } }
    ])
    expect(manager.getSnapshot().revision).toBe(revision)
  })

  it('clears both the conversation and speech when the user signs out', () => {
    const { manager } = setup()
    manager.setSpeechState({ phase: 'listening', generation })
    manager.setConversationState({
      phase: 'active',
      conversationId: 'conv-1',
      version: 1,
      request: { requestId: null, phase: 'idle' }
    })
    manager.setAuthSnapshot({ ...signedOut, generation: { ...authGeneration, revision: 9 } })
    expect(manager.getSnapshot()).toMatchObject({
      speech: { phase: 'idle' },
      conversation: { phase: 'idle' },
      screen: 'login'
    })
  })

  it('ignores updates after disposal', () => {
    const { manager, events } = setup()
    manager.dispose()
    manager.setSpeechState({ phase: 'listening', generation })
    manager.publishNotice({ type: 'assistant', requestId: 'r', text: 'x' })
    expect(events).toEqual([])
  })
})
