import { describe, expect, it, vi } from 'vitest'
import { createAuthGateway } from '../../src/main/auth/create-auth-gateway'
import { DevAuthGateway } from '../../src/main/auth/dev-auth-gateway'
import { SafeStorageCredentialStore } from '../../src/main/auth/safe-storage-credential-store'
import type {
  CredentialFileSystem,
  SafeStorageLike
} from '../../src/main/auth/safe-storage-credential-store'
import { unavailableAuthGateway } from '../../src/main/auth/unavailable-auth-gateway'

function setup(overrides: Partial<SafeStorageLike> = {}) {
  const files = new Map<string, Buffer>()
  const fs: CredentialFileSystem = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, data) => {
      files.set(path, data)
    },
    remove: async (path) => {
      files.delete(path)
    }
  }
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    // A reversible stand-in; the point is that the file never holds the plain value.
    encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice(4), 'base64').toString(),
    ...overrides
  }
  return { files, store: new SafeStorageCredentialStore(safeStorage, fs, '/data/credential.bin') }
}

describe('SafeStorageCredentialStore', () => {
  it('round-trips a credential without storing it in plaintext', async () => {
    const { files, store } = setup()
    expect(await store.save({ opaque: 'secret-token' })).toEqual({ ok: true, value: undefined })
    expect(files.get('/data/credential.bin')!.toString()).not.toContain('secret-token')
    expect(await store.load()).toEqual({ ok: true, value: { opaque: 'secret-token' } })
  })

  it('loads null when nothing is stored and clears idempotently', async () => {
    const { store } = setup()
    expect(await store.load()).toEqual({ ok: true, value: null })
    await store.save({ opaque: 'x' })
    expect(await store.clear()).toEqual({ ok: true, value: undefined })
    expect(await store.clear()).toEqual({ ok: true, value: undefined })
    expect(await store.load()).toEqual({ ok: true, value: null })
  })

  it('refuses to save when OS encryption is unavailable instead of falling back to plaintext', async () => {
    const { files, store } = setup({ isEncryptionAvailable: () => false })
    expect(await store.save({ opaque: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'credential_unavailable' }
    })
    expect(files.size).toBe(0)
  })

  it('treats the Linux basic_text backend as unprotected', async () => {
    const { files, store } = setup({ getSelectedStorageBackend: () => 'basic_text' })
    expect(await store.save({ opaque: 'x' })).toMatchObject({ ok: false })
    expect(files.size).toBe(0)
    const protectedStore = setup({ getSelectedStorageBackend: () => 'gnome_libsecret' }).store
    expect(await protectedStore.save({ opaque: 'x' })).toMatchObject({ ok: true })
  })

  it('reports an unreadable or corrupt file instead of returning an empty credential', async () => {
    const { files, store } = setup()
    files.set('/data/credential.bin', Buffer.from('enc:not-json'))
    expect(await store.load()).toMatchObject({
      ok: false,
      error: { code: 'credential_unavailable' }
    })
    const failing = setup({
      decryptString: () => {
        throw new Error('bad key')
      }
    })
    await failing.store.save({ opaque: 'x' })
    expect(await failing.store.load()).toMatchObject({ ok: false })
  })

  it('reports a failed delete', async () => {
    const files: CredentialFileSystem = {
      read: async () => null,
      write: async () => undefined,
      remove: vi.fn<CredentialFileSystem['remove']>(async () => {
        throw new Error('EACCES')
      })
    }
    const store = new SafeStorageCredentialStore(
      { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: String },
      files,
      '/x'
    )
    expect(await store.clear()).toMatchObject({
      ok: false,
      error: { code: 'credential_unavailable' }
    })
  })
})

describe('createAuthGateway', () => {
  const nowUnixMs = () => 0
  it('uses the development gateway only when unpackaged and explicitly enabled', () => {
    expect(
      createAuthGateway({ isPackaged: false, env: { JARVIS_DEV_AUTH: '1' }, nowUnixMs })
    ).toBeInstanceOf(DevAuthGateway)
    expect(createAuthGateway({ isPackaged: false, env: {}, nowUnixMs })).toBe(
      unavailableAuthGateway
    )
    expect(
      createAuthGateway({ isPackaged: false, env: { JARVIS_DEV_AUTH: 'true' }, nowUnixMs })
    ).toBe(unavailableAuthGateway)
  })

  it('can never be enabled in a packaged build', () => {
    expect(createAuthGateway({ isPackaged: true, env: { JARVIS_DEV_AUTH: '1' }, nowUnixMs })).toBe(
      unavailableAuthGateway
    )
  })

  it('makes the fallback fail closed with a transient error', async () => {
    expect(await unavailableAuthGateway.signIn({ loginId: 'a', password: 'b' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(await unavailableAuthGateway.restore({ opaque: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
  })
})
