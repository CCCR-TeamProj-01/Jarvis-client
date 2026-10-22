import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Result } from '../../shared/contracts/common'
import { createDefaultServerClient } from '../connection/create-default-server-client'
import type { ServerClient } from '../connection/server-client'
import { AuthManager } from './auth-manager'
import { createAuthGateway } from './create-auth-gateway'
import type { ServerAuthConnection } from './create-auth-gateway'
import { deviceInfoFrom } from './device-info'
import { nodeCredentialFs } from './node-credential-fs'
import type { CredentialStorePort } from './ports'
import { SafeStorageCredentialStore } from './safe-storage-credential-store'
import { AccessTokenHolder } from './server-session'

const unavailableStore: CredentialStorePort = {
  load: async () => credentialUnavailable(),
  save: async () => credentialUnavailable(),
  clear: async () => credentialUnavailable()
}

function credentialUnavailable(): Result<never> {
  return {
    ok: false,
    error: {
      code: 'credential_unavailable',
      message: '이 기기에서는 로그인 정보를 안전하게 보관할 수 없습니다.'
    }
  }
}

function createCredentialStore(): CredentialStorePort {
  try {
    return new SafeStorageCredentialStore(
      safeStorage,
      nodeCredentialFs,
      join(app.getPath('userData'), 'auth-credential.bin')
    )
  } catch {
    return unavailableStore
  }
}

interface DefaultAuthOptions {
  /** The installation key; null until the local state has been initialised. */
  deviceKey(): string | null
}

/** The login state, and the client for every other server call (null without a usable server). */
export interface DefaultAuth {
  auth: AuthManager
  api: ServerClient | null
}

/** An access token this close to its end is renewed before a request rather than risked on it. */
const API_TOKEN_MARGIN_MS = 60_000

/** Production wiring. Tests construct AuthManager with in-memory ports instead. */
export function createDefaultAuth({ deviceKey }: DefaultAuthOptions): DefaultAuth {
  const nowUnixMs = () => Date.now()
  const tokens = new AccessTokenHolder()
  const resolution = createDefaultServerClient(() => tokens.get())
  // The reason names only what is wrong with the address, never a credential.
  if (resolution.status === 'invalid') console.warn(`JARVIS_SERVER_URL: ${resolution.reason}`)
  const server: ServerAuthConnection | null =
    resolution.status === 'ready'
      ? {
          client: resolution.client,
          tokens,
          device: () =>
            deviceInfoFrom({
              deviceKey: deviceKey(),
              hostname: hostname(),
              platform: process.platform,
              appVersion: app.getVersion()
            })
        }
      : null
  const auth = new AuthManager({
    gateway: createAuthGateway({
      isPackaged: app.isPackaged,
      env: process.env,
      nowUnixMs,
      server
    }),
    store: createCredentialStore(),
    sessionId: randomUUID(),
    nowUnixMs,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      timer.unref()
      return () => clearTimeout(timer)
    }
  })
  // Calls other than signing in go through a second client that keeps the access token fresh: it
  // renews shortly before the token ends and once more if the server refuses it. The client above
  // must not do this, because it is the one that performs the renewal.
  const renew = async () => (await auth.renewSession()).ok
  const api =
    resolution.status === 'ready'
      ? createDefaultServerClient(async () => {
          if (tokens.expiringSoon(nowUnixMs(), API_TOKEN_MARGIN_MS)) await auth.renewSession()
          return tokens.get()
        }, renew)
      : null
  return { auth, api: api?.status === 'ready' ? api.client : null }
}
