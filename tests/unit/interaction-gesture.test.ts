import { describe, expect, it, vi } from 'vitest'
import { InteractionManager } from '../../src/main/interaction/interaction-manager'
import type { GestureHandlers } from '../../src/main/interaction/interaction-manager'
import type { AuthSnapshot } from '../../src/shared/contracts/auth'
import type { GestureSnapshot } from '../../src/shared/contracts/gesture'
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
    start: vi.fn<GestureHandlers['start']>(async () => ({ ok: true, value: undefined })),
    stop: vi.fn<GestureHandlers['stop']>(async () => ({ ok: true, value: undefined }))
  }
  return { manager, showWindow, events, handlers }
}

const tracking: GestureSnapshot = {
  phase: 'tracking',
  generation: { sessionId: 'gesture-1', revision: 1 },
  activeHandId: 'right',
  displayId: '1'
}

describe('gesture commands', () => {
  it('reports itself unsupported until gesture control is connected', async () => {
    const { manager } = setup()
    expect(await manager.dispatch({ type: 'gesture.start' })).toMatchObject({
      ok: false,
      error: { code: 'unsupported' }
    })
  })

  it('starts through the connected handler for a signed-in user', async () => {
    const { manager, handlers } = setup()
    manager.setGestureHandlers(handlers)
    expect(await manager.dispatch({ type: 'gesture.start' })).toMatchObject({ ok: true })
    expect(handlers.start).toHaveBeenCalledOnce()
  })

  it('does not start before sign-in and sends the user to the login screen', async () => {
    const { manager, handlers, showWindow } = setup(signedOut)
    manager.setGestureHandlers(handlers)
    expect(await manager.dispatch({ type: 'gesture.start' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(handlers.start).not.toHaveBeenCalled()
    expect(showWindow).toHaveBeenCalled()
  })

  it('does not start while recognition is paused', async () => {
    const { manager, handlers } = setup()
    manager.setGestureHandlers(handlers)
    await manager.dispatch({ type: 'recognition.pause' })
    expect(await manager.dispatch({ type: 'gesture.start' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(handlers.start).not.toHaveBeenCalled()
  })

  it('passes a refusal (such as a missing permission) back to the caller', async () => {
    const { manager, handlers } = setup()
    handlers.start.mockResolvedValueOnce({
      ok: false,
      error: { code: 'permission_denied', message: '손쉬운 사용 권한이 필요합니다.' }
    })
    manager.setGestureHandlers(handlers)
    expect(await manager.dispatch({ type: 'gesture.start' })).toMatchObject({
      ok: false,
      error: { code: 'permission_denied', message: '손쉬운 사용 권한이 필요합니다.' }
    })
  })

  it('stops without a sign-in and even when nothing is connected', async () => {
    const { manager, handlers } = setup(signedOut)
    expect(await manager.dispatch({ type: 'gesture.stop' })).toMatchObject({ ok: true })
    manager.setGestureHandlers(handlers)
    expect(await manager.dispatch({ type: 'gesture.stop' })).toMatchObject({ ok: true })
    expect(handlers.stop).toHaveBeenCalledOnce()
  })

  it('publishes the gesture state and does not change the revision for an identical one', () => {
    const { manager, events } = setup()
    manager.setGestureState(tracking)
    expect(manager.getSnapshot().gesture).toEqual(tracking)
    const revision = manager.getSnapshot().revision
    manager.setGestureState(tracking)
    expect(manager.getSnapshot().revision).toBe(revision)
    expect(events.filter((event) => event.type === 'state.changed')).toHaveLength(1)
  })

  it('forgets the gesture state when the user signs out', () => {
    const { manager } = setup()
    manager.setGestureState(tracking)
    manager.setAuthSnapshot(signedOut)
    expect(manager.getSnapshot().gesture.phase).toBe('off')
  })

  it('shows a problem notice as an error event', () => {
    const { manager, events } = setup()
    manager.publishNotice({
      type: 'problem',
      error: { code: 'permission_denied', message: '권한이 철회되었습니다.' }
    })
    expect(events).toContainEqual({
      type: 'client.error',
      error: { code: 'permission_denied', message: '권한이 철회되었습니다.' }
    })
  })
})
