import { describe, expect, it, vi } from 'vitest'
import { createCommandService } from '../../src/main/commands/create-command-service'
import { runWhileSignedIn } from '../../src/main/auth/run-while-signed-in'
import type { AuthManager } from '../../src/main/auth/auth-manager'
import type { CommandServiceOptions } from '../../src/main/commands/command-service'
import type { LocalFilesPort } from '../../src/main/settings/ports'
import { ServerClient } from '../../src/main/connection/server-client'
import type { AuthEvent, AuthSnapshot } from '../../src/shared/contracts/auth'

const api = new ServerClient({
  baseUrl: 'http://127.0.0.1:1/api/v1',
  fetch: fetch,
  accessToken: () => null
})
const base = {
  isPackaged: false,
  env: {},
  api,
  executor: { execute: vi.fn<CommandServiceOptions['executor']['execute']>() },
  files: {
    read: vi.fn<LocalFilesPort['read']>(),
    replace: vi.fn<LocalFilesPort['replace']>()
  },
  platform: 'darwin' as const
}

describe('createCommandService', () => {
  it('exists with a server', () => {
    expect(createCommandService(base)).not.toBeNull()
  })

  it('does not exist without a server', () => {
    expect(createCommandService({ ...base, api: null })).toBeNull()
  })

  it('does not exist for the development sign-in stand-in, which the server would not accept', () => {
    expect(createCommandService({ ...base, env: { JARVIS_DEV_AUTH: '1' } })).toBeNull()
  })

  it('ignores that switch in a packaged app', () => {
    expect(
      createCommandService({ ...base, isPackaged: true, env: { JARVIS_DEV_AUTH: '1' } })
    ).not.toBeNull()
  })

  it('is not affected by the speech stand-in', () => {
    expect(createCommandService({ ...base, env: { JARVIS_DEV_SPEECH: '1' } })).not.toBeNull()
  })
})

function fakeAuth(initial: AuthSnapshot) {
  let snapshot = initial
  const listeners = new Set<(event: AuthEvent) => void>()
  return {
    auth: {
      getSnapshot: () => snapshot,
      subscribe: (listener: (event: AuthEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    } as Pick<AuthManager, 'getSnapshot' | 'subscribe'>,
    change(next: AuthSnapshot) {
      snapshot = next
      for (const listener of listeners) listener({ type: 'auth.state_changed', snapshot: next })
    },
    listeners
  }
}

const fakeService = () => ({
  start: vi.fn<(userId: string) => void>(),
  stop: vi.fn<() => Promise<void>>(async () => undefined)
})

const generation = { sessionId: 's', revision: 1 }
const signedIn = (userId: string): AuthSnapshot => ({
  phase: 'signed_in',
  generation,
  user: { userId, loginId: userId }
})
const signedOut: AuthSnapshot = { phase: 'signed_out', generation, user: null }
const checking: AuthSnapshot = { phase: 'checking', generation, user: null }

describe('runWhileSignedIn', () => {
  it('starts for a user who is already signed in', () => {
    const { auth } = fakeAuth(signedIn('u1'))
    const service = fakeService()
    runWhileSignedIn(auth, service)
    expect(service.start).toHaveBeenCalledExactlyOnceWith('u1')
  })

  it('waits while the login is being checked or signed out', () => {
    for (const snapshot of [checking, signedOut]) {
      const { auth } = fakeAuth(snapshot)
      const service = fakeService()
      runWhileSignedIn(auth, service)
      expect(service.start).not.toHaveBeenCalled()
    }
  })

  it('starts when a user signs in, stops when they sign out, and follows an account switch', () => {
    const { auth, change } = fakeAuth(checking)
    const service = fakeService()
    runWhileSignedIn(auth, service)
    change(signedIn('u1'))
    expect(service.start).toHaveBeenLastCalledWith('u1')
    change(signedOut)
    expect(service.stop).toHaveBeenCalled()
    change(signedIn('u2'))
    expect(service.start).toHaveBeenLastCalledWith('u2')
  })

  it('stops and unsubscribes when released', () => {
    const { auth, listeners } = fakeAuth(signedIn('u1'))
    const service = fakeService()
    const release = runWhileSignedIn(auth, service)
    release()
    expect(service.stop).toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it('ignores events that are not state changes', () => {
    const { auth, listeners } = fakeAuth(checking)
    const service = fakeService()
    runWhileSignedIn(auth, service)
    for (const listener of listeners)
      listener({ type: 'auth.something_else' } as unknown as AuthEvent)
    expect(service.start).not.toHaveBeenCalled()
  })
})
