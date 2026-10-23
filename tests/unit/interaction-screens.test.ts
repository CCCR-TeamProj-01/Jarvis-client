import { describe, expect, it, vi } from 'vitest'
import { InteractionManager } from '../../src/main/interaction/interaction-manager'
import type { AuthSnapshot } from '../../src/shared/contracts/auth'
import { ClientSnapshotSchema, UiCommandSchema } from '../../src/shared/contracts/interaction'
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
  return { manager, showWindow }
}

describe('screens', () => {
  it('starts on the conversation when signed in and on the login screen otherwise', () => {
    expect(setup().manager.getSnapshot().screen).toBe('conversation')
    expect(setup(signedOut).manager.getSnapshot().screen).toBe('login')
  })

  it('moves between the tabs on command', async () => {
    const { manager } = setup()
    for (const screen of ['gesture', 'settings', 'conversation'] as const) {
      expect(await manager.dispatch({ type: 'screen.open', screen })).toMatchObject({ ok: true })
      expect(manager.getSnapshot().screen).toBe(screen)
    }
  })

  it('does not publish a change when the tab is already showing', async () => {
    const { manager } = setup()
    const revision = manager.getSnapshot().revision
    await manager.dispatch({ type: 'screen.open', screen: 'conversation' })
    expect(manager.getSnapshot().revision).toBe(revision)
  })

  it('does not open a tab before sign-in, and sends the user to the login screen', async () => {
    const { manager, showWindow } = setup(signedOut)
    expect(await manager.dispatch({ type: 'screen.open', screen: 'settings' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(manager.getSnapshot().screen).toBe('login')
    expect(showWindow).toHaveBeenCalled()
  })

  it('opens the settings tab and brings the window up when settings are opened (the tray)', async () => {
    const { manager, showWindow } = setup()
    expect(await manager.dispatch({ type: 'settings.open' })).toMatchObject({ ok: true })
    expect(manager.getSnapshot().screen).toBe('settings')
    expect(showWindow).toHaveBeenCalledOnce()
  })

  it('does not open settings before sign-in', async () => {
    const { manager } = setup(signedOut)
    expect(await manager.dispatch({ type: 'settings.open' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(manager.getSnapshot().screen).toBe('login')
  })

  it('goes back to the conversation after a sign-in from the login screen', () => {
    const { manager } = setup(signedOut)
    manager.setAuthSnapshot(signedIn)
    expect(manager.getSnapshot().screen).toBe('conversation')
  })

  it('goes back to the login screen on sign-out, from whatever tab was open', async () => {
    const { manager } = setup()
    await manager.dispatch({ type: 'screen.open', screen: 'settings' })
    manager.setAuthSnapshot(signedOut)
    expect(manager.getSnapshot().screen).toBe('login')
  })

  it('knows only the three tabs as a command', () => {
    expect(UiCommandSchema.safeParse({ type: 'screen.open', screen: 'gesture' }).success).toBe(true)
    for (const screen of ['login', 'signup', 'input', 'status', 'hidden'])
      expect(UiCommandSchema.safeParse({ type: 'screen.open', screen }).success).toBe(false)
  })

  it('refuses a signed-out snapshot that shows a tab', () => {
    const snapshot = setup(signedOut).manager.getSnapshot()
    expect(ClientSnapshotSchema.safeParse({ ...snapshot, screen: 'settings' }).success).toBe(false)
  })
})

describe('result lines', () => {
  it('carry who they are from', () => {
    const { manager } = setup()
    const events: unknown[] = []
    manager.subscribe((event) => events.push(event))
    manager.publishNotice({ type: 'user', requestId: 'r', text: '안녕', modality: 'text' })
    manager.publishNotice({ type: 'assistant', requestId: 'r', text: '반가워요' })
    manager.publishNotice({
      type: 'tool',
      requestId: 'r',
      executionId: 'e',
      text: '열었어요',
      ok: true,
      outcome: 'success'
    })
    expect(events).toEqual([
      { type: 'result.available', requestId: 'r', role: 'user', text: '안녕' },
      { type: 'result.available', requestId: 'r', role: 'assistant', text: '반가워요' },
      {
        type: 'result.available',
        requestId: 'r',
        role: 'tool',
        text: '열었어요',
        outcome: 'success'
      }
    ])
  })
})
