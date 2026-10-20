import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Result } from '../../shared/contracts/common'
import { AuthManager } from './auth-manager'
import { createAuthGateway } from './create-auth-gateway'
import { nodeCredentialFs } from './node-credential-fs'
import type { CredentialStorePort } from './ports'
import { SafeStorageCredentialStore } from './safe-storage-credential-store'

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

/** Production wiring. Tests construct AuthManager with in-memory ports instead. */
export function createDefaultAuth(): AuthManager {
  const nowUnixMs = () => Date.now()
  return new AuthManager({
    gateway: createAuthGateway({ isPackaged: app.isPackaged, env: process.env, nowUnixMs }),
    store: createCredentialStore(),
    sessionId: randomUUID(),
    nowUnixMs,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      timer.unref()
      return () => clearTimeout(timer)
    }
  })
}
