import { describe, expect, it, vi } from 'vitest'
import { InteractionManager } from '../../src/main/interaction/interaction-manager'
import type { AuthSnapshot } from '../../src/shared/contracts/auth'
import type { UiCommand, UiEvent } from '../../src/shared/contracts/interaction'
import { newestSnapshot } from '../../src/renderer/ui/use-client-snapshot'
import { authGeneration, authUser, clientSnapshot } from '../fixtures/contracts'

function setup(
  auth: AuthSnapshot = { phase: 'signed_out', generation: authGeneration, user: null }
) {
  const showWindow = vi.fn<() => void>()
  const quit = vi.fn<() => void>()
  let nextId = 0
  const manager = new InteractionManager({
    auth,
    accelerator: 'CommandOrControl+Shift+Space',
    now: () => 100,
    createId: () => `command-${++nextId}`,
    showWindow,
    quit
  })
  return { manager, showWindow, quit }
}

describe('Main interaction state', () => {
  it('persists the actual native material and publishes changes without changing authentication', () => {
    const { manager } = setup()
    const receive = vi.fn<(event: UiEvent) => void>()
    manager.subscribe(receive)
    expect(manager.getSnapshot().application.windowMaterial).toBe('opaque')
    manager.setWindowMaterial('vibrancy')
    expect(manager.getSnapshot().application.windowMaterial).toBe('vibrancy')
    const revision = manager.getSnapshot().revision
    manager.setWindowMaterial('vibrancy')
    expect(manager.getSnapshot().revision).toBe(revision)
    expect(receive).toHaveBeenCalledOnce()
    expect(manager.getSnapshot().auth.phase).toBe('signed_out')
    manager.setWindowMaterial('opaque')
    expect(receive).toHaveBeenCalledTimes(2)
  })
  it('starts on login without enabling sensors or claiming an active feature', () => {
    const { manager } = setup()
    expect(manager.getSnapshot()).toMatchObject({
      auth: { phase: 'signed_out', user: null },
      screen: 'login',
      sensors: [],
      conversation: { phase: 'idle' },
      speech: { phase: 'idle' },
      gesture: { phase: 'off' },
      connection: 'offline'
    })
    const copy = manager.getSnapshot()
    copy.auth.generation.revision = 999
    expect(manager.getSnapshot().auth.generation).toEqual(authGeneration)
  })

  it.each(['ui', 'tray', 'hotkey', 'voice', 'gesture'] as const)(
    'routes unauthenticated %s activation to login',
    async (source) => {
      const { manager, showWindow } = setup()
      await manager.dispatch({ type: 'auth.open', screen: 'signup' })
      const result = await manager.activateConversation(source)
      expect(result).toMatchObject({ ok: false, error: { code: 'authentication_required' } })
      expect(manager.getSnapshot().screen).toBe('login')
      expect(manager.getSnapshot().gesture.phase).toBe('off')
      expect(showWindow).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    { type: 'settings.open' },
    { type: 'gesture.start' },
    { type: 'recognition.resume' },
    { type: 'conversation.submit_text', text: 'test' },
    { type: 'confirmation.respond', confirmationId: 'c-1', decision: 'approve' }
  ] satisfies UiCommand[])('blocks an unauthenticated command %j', async (command) => {
    const { manager } = setup({ phase: 'checking', generation: authGeneration, user: null })
    expect(await manager.dispatch(command)).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(manager.getSnapshot().screen).toBe('login')
  })

  it('allows pause, idle stop and exit without authentication', async () => {
    const { manager, quit } = setup()
    for (const type of ['recognition.pause', 'gesture.stop', 'conversation.stop'] as const)
      expect(await manager.dispatch({ type })).toMatchObject({ ok: true })
    expect(manager.getSnapshot().recognitionPaused).toBe(true)
    expect(await manager.dispatch({ type: 'app.quit' })).toMatchObject({ ok: true })
    expect(quit).toHaveBeenCalledOnce()
  })

  it('does not report an unimplemented feature as running even with a verified user', async () => {
    const { manager } = setup({ phase: 'signed_in', generation: authGeneration, user: authUser })
    expect(await manager.dispatch({ type: 'gesture.start' })).toMatchObject({
      ok: false,
      error: { code: 'unsupported' }
    })
    expect(manager.getSnapshot().gesture.phase).toBe('off')
    expect(await manager.dispatch({ type: 'auth.open', screen: 'login' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
  })

  it('keeps repeated subscriptions of the same callback independent and isolated', async () => {
    const { manager } = setup()
    const listener = vi.fn<(event: UiEvent) => void>((event) => {
      if (event.type === 'state.changed') event.snapshot.screen = 'hidden'
    })
    const first = manager.subscribe(listener)
    manager.subscribe(() => {
      throw new Error('Observer failed')
    })
    const second = manager.subscribe(listener)
    first()
    first()
    await manager.dispatch({ type: 'auth.open', screen: 'signup' })
    expect(listener).toHaveBeenCalledOnce()
    expect(manager.getSnapshot().screen).toBe('signup')
    second()
    await manager.dispatch({ type: 'auth.open', screen: 'login' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('retains registration failure in the snapshot for late subscribers', () => {
    const { manager } = setup()
    manager.setShortcutState({
      status: 'unavailable',
      accelerator: 'CommandOrControl+Shift+Space',
      error: { code: 'conflict', message: 'Shortcut unavailable' }
    })
    expect(manager.getSnapshot().application.shortcut).toMatchObject({
      status: 'unavailable',
      error: { code: 'conflict' }
    })
    expect(manager.getSnapshot().revision).toBe(1)
  })

  it('does not execute cancelled, expired or disposed commands', async () => {
    const { manager, quit } = setup()
    const controller = new AbortController()
    controller.abort()
    expect(
      await manager.dispatch({ type: 'app.quit' }, { signal: controller.signal })
    ).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(await manager.dispatch({ type: 'app.quit' }, { deadlineMs: 100 })).toMatchObject({
      ok: false,
      error: { code: 'expired' }
    })
    manager.dispose()
    manager.dispose()
    expect(await manager.dispatch({ type: 'app.quit' })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(quit).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer event with an older initial snapshot response', () => {
    const current = clientSnapshot({ revision: 4 })
    expect(newestSnapshot(current, clientSnapshot({ revision: 1 }))).toBe(current)
    expect(newestSnapshot(current, clientSnapshot({ revision: 5 })).revision).toBe(5)
  })
})
