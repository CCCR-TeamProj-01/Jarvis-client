import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { AuthManager } from '../../src/main/auth/auth-manager'
import { DEV_ACCOUNT, DevAuthGateway } from '../../src/main/auth/dev-auth-gateway'
import { MemoryCredentialStore } from '../../src/main/auth/memory-credential-store'
import { InteractionManager } from '../../src/main/interaction/interaction-manager'
import { registerAuthIpc } from '../../src/main/ipc/auth-ipc'
import { createUiBridge } from '../../src/preload/ui-bridge'
import type { AuthEvent } from '../../src/shared/contracts/auth'
import type { UiEvent } from '../../src/shared/contracts/interaction'
import type { Generation } from '../../src/shared/contracts/common'
import { AUTH_CHANNELS } from '../../src/shared/ipc/channels'

const entryUrl = 'file:///jarvis/ui/index.html'

function setup() {
  const listeners = new Set<(event: unknown, value: unknown) => void>()
  const send = vi.fn<(channel: string, value: unknown) => void>((channel, value) => {
    if (channel === AUTH_CHANNELS.event)
      for (const listener of [...listeners]) listener({ native: true }, structuredClone(value))
  })
  const contents = {
    mainFrame: { url: entryUrl },
    isDestroyed: () => false,
    send
  } as unknown as WebContents
  const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc = {
    handle: vi.fn<IpcMain['handle']>((channel, handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn<IpcMain['removeHandler']>((channel) => {
      handlers.delete(channel)
    })
  }
  const auth = new AuthManager({
    gateway: new DevAuthGateway({ nowUnixMs: () => 1_000, sessionLifetimeMs: 60_000 }),
    store: new MemoryCredentialStore(),
    sessionId: 'run-1',
    nowUnixMs: () => 1_000,
    schedule: () => () => undefined
  })
  const showWindow = vi.fn<() => void>()
  const interaction = new InteractionManager({
    auth: auth.getSnapshot(),
    accelerator: 'CommandOrControl+Shift+Space',
    createId: () => 'command-1',
    now: () => 100,
    showWindow,
    quit: vi.fn<() => void>()
  })
  auth.onGenerationChange((snapshot) => interaction.setAuthSnapshot(snapshot))
  const dispose = registerAuthIpc({ ipc, getContents: () => contents, entryUrl, auth })
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(
    async (channel, ...args) => structuredClone(await handlers.get(channel)!(event, ...args))
  )
  const api = createUiBridge(
    {
      invoke,
      on: (_channel, listener) => {
        listeners.add(listener)
      },
      removeListener: (_channel, listener) => {
        listeners.delete(listener)
      }
    },
    'darwin'
  ).auth
  return { api, auth, interaction, handlers, ipc, dispose, invoke, event, contents, showWindow }
}

const ids = (context: { generation: Generation }) => ({ requestId: 'req-1', ...context })

describe('authentication IPC', () => {
  it('signs up and signs in end to end, with Main alone deciding the state', async () => {
    const { api, auth, interaction } = setup()
    await auth.start()
    const snapshot = await api.getSnapshot()
    expect(snapshot).toMatchObject({ ok: true, value: { phase: 'signed_out' } })
    if (!snapshot.ok) return
    const context = ids({ generation: snapshot.value.generation })

    expect(await api.checkLoginId({ ...context, input: { loginId: 'alice' } })).toEqual({
      ok: true,
      value: { loginId: 'alice', available: true }
    })
    expect(await api.signUp({ ...context, input: { loginId: 'alice', password: 'pw' } })).toEqual({
      ok: true,
      value: { loginId: 'alice' }
    })
    const result = await api.signIn({ ...context, input: { loginId: 'alice', password: 'pw' } })
    expect(result).toMatchObject({
      ok: true,
      value: { snapshot: { phase: 'signed_in', user: { loginId: 'alice' } } }
    })
    expect(interaction.getSnapshot().auth.phase).toBe('signed_in')
    expect(interaction.getSnapshot().screen).toBe('status')
  })

  it('pushes validated state changes and errors to subscribers', async () => {
    const { api, auth } = setup()
    const received: AuthEvent[] = []
    const unsubscribe = api.subscribe((event) => received.push(event))
    await auth.start()
    expect(received.map((event) => event.type)).toEqual(['auth.state_changed'])
    unsubscribe()
    await auth.signOut()
    await auth.start()
    expect(received).toHaveLength(1)
  })

  it('rejects malformed requests before they reach Main', async () => {
    const { api, auth, invoke } = setup()
    await auth.start()
    const generation = auth.getSnapshot().generation
    const bad = [
      { requestId: '', generation, input: { loginId: 'a', password: 'b' } },
      { requestId: 'r', generation, input: { loginId: '  ', password: 'b' } },
      { requestId: 'r', generation, input: { loginId: 'a', password: '' } },
      // The confirmation field must never cross the boundary.
      {
        requestId: 'r',
        generation,
        input: { loginId: 'a', password: 'b', passwordConfirmation: 'b' }
      }
    ]
    for (const request of bad)
      expect(await api.signIn(request as never)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects malformed requests that bypass the Preload bridge', async () => {
    const { handlers, event, auth } = setup()
    await auth.start()
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
    expect(await call(AUTH_CHANNELS.signIn, { requestId: 'r' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    expect(await call(AUTH_CHANNELS.signIn)).toMatchObject({ ok: false })
    expect(await call(AUTH_CHANNELS.snapshot, 'extra')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    expect(auth.isSignedIn()).toBe(false)
  })

  it('denies foreign windows, subframes and other documents', async () => {
    const { handlers, contents, auth } = setup()
    await auth.start()
    const generation = auth.getSnapshot().generation
    const request = {
      requestId: 'r',
      generation,
      input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    }
    const handler = handlers.get(AUTH_CHANNELS.signIn)!
    const foreign = { sender: {}, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent
    const subframe = {
      sender: contents,
      senderFrame: { url: entryUrl }
    } as unknown as IpcMainInvokeEvent
    const other = {
      sender: contents,
      senderFrame: { ...contents.mainFrame, url: 'https://evil.example/' }
    } as unknown as IpcMainInvokeEvent
    for (const event of [foreign, subframe, other])
      expect(await handler(event, request)).toMatchObject({
        ok: false,
        error: { code: 'permission_denied' }
      })
    expect(auth.isSignedIn()).toBe(false)
  })

  it('removes every handler and stops events on dispose', async () => {
    const { handlers, dispose, ipc, auth, contents } = setup()
    dispose()
    dispose()
    expect(handlers.size).toBe(0)
    expect(ipc.removeHandler).toHaveBeenCalledTimes(Object.keys(AUTH_CHANNELS).length - 1)
    await auth.start()
    expect(contents.send).not.toHaveBeenCalled()
  })
})

describe('entry-point enforcement', () => {
  it('blocks protected commands until Main reports signed_in, and again after sign-out', async () => {
    const { auth, interaction, showWindow } = setup()
    await auth.start()
    expect(await interaction.dispatch({ type: 'conversation.start' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(await interaction.activateConversation('hotkey')).toMatchObject({ ok: false })
    expect(showWindow).toHaveBeenCalled()

    await auth.signIn({
      requestId: 'r',
      generation: auth.getSnapshot().generation,
      input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    })
    expect(await interaction.dispatch({ type: 'conversation.start' })).toMatchObject({
      ok: false,
      error: { code: 'unsupported' }
    })

    await auth.signOut()
    expect(interaction.getSnapshot()).toMatchObject({
      auth: { phase: 'signed_out' },
      screen: 'login'
    })
    expect(await interaction.dispatch({ type: 'conversation.start' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
  })

  it('always allows stopping and quitting without authentication', async () => {
    const { interaction } = setup()
    for (const command of [
      { type: 'conversation.stop' },
      { type: 'gesture.stop' },
      { type: 'recognition.pause' },
      { type: 'app.quit' }
    ] as const)
      expect(await interaction.dispatch(command)).toMatchObject({ ok: true })
  })

  it('drops the previous account state when leaving signed_in', async () => {
    const { auth, interaction } = setup()
    await auth.start()
    await auth.signIn({
      requestId: 'r',
      generation: auth.getSnapshot().generation,
      input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    })
    expect(interaction.getSnapshot().auth.user?.loginId).toBe(DEV_ACCOUNT.loginId)
    await auth.signOut()
    const snapshot = interaction.getSnapshot()
    expect(snapshot.auth.user).toBeNull()
    expect(snapshot).toMatchObject({
      conversation: { phase: 'idle' },
      request: { phase: 'idle' },
      speech: { phase: 'idle' },
      gesture: { phase: 'off' },
      sensors: []
    })
  })

  it('keeps the signup screen when the session ends on it', async () => {
    const { auth, interaction } = setup()
    await auth.start()
    await interaction.dispatch({ type: 'auth.open', screen: 'signup' })
    await auth.handleSessionRejected({ code: 'session_expired', message: '만료' })
    expect(interaction.getSnapshot().screen).toBe('signup')
  })

  it('resumes recognition only for a signed-in user and sends others to sign-in', async () => {
    const { auth, interaction, showWindow } = setup()
    await auth.start()
    await interaction.dispatch({ type: 'recognition.pause' })
    expect(await interaction.dispatch({ type: 'recognition.resume' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(interaction.getSnapshot().recognitionPaused).toBe(true)
    expect(showWindow).toHaveBeenCalled()

    await auth.signIn({
      requestId: 'r',
      generation: auth.getSnapshot().generation,
      input: { loginId: DEV_ACCOUNT.loginId, password: DEV_ACCOUNT.password }
    })
    expect(await interaction.dispatch({ type: 'recognition.resume' })).toMatchObject({ ok: true })
    expect(interaction.getSnapshot().recognitionPaused).toBe(false)
  })

  it('publishes sensor snapshots only when they change', async () => {
    const { auth, interaction } = setup()
    await auth.start()
    const listener = vi.fn<(event: UiEvent) => void>()
    interaction.subscribe(listener)
    const sensors = [
      { kind: 'camera', permission: 'granted', state: 'idle', leaseCount: 0 },
      { kind: 'microphone', permission: 'granted', state: 'idle', leaseCount: 0 }
    ] as const
    interaction.setSensors([...sensors])
    interaction.setSensors([...sensors])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(interaction.getSnapshot().sensors).toEqual(sensors)
  })
})
