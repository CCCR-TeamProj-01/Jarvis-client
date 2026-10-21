import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalState } from '../../src/main/settings/local-state'
import { NodeLocalFiles } from '../../src/main/settings/node-local-files'
import { AuthManager } from '../../src/main/auth/auth-manager'
import { DevAuthGateway } from '../../src/main/auth/dev-auth-gateway'
import { SafeStorageCredentialStore } from '../../src/main/auth/safe-storage-credential-store'
import { nodeCredentialFs } from '../../src/main/auth/node-credential-fs'

const directories: string[] = []
async function directory() {
  const path = await fs.mkdtemp(join(tmpdir(), 'jarvis-local-state-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))
  )
})

describe('atomic local documents on disk', () => {
  it('treats a missing installation beside existing settings as data loss, not a new install', async () => {
    const path = await directory()
    await new LocalState(new NodeLocalFiles(path)).initialize()
    const preferences = await fs.readFile(join(path, 'device-settings.json'), 'utf8')
    await fs.unlink(join(path, 'installation.json'))
    expect(await new LocalState(new NodeLocalFiles(path)).initialize()).toMatchObject({ ok: false })
    expect(await fs.readdir(path)).toEqual(['device-settings.json'])
    expect(await fs.readFile(join(path, 'device-settings.json'), 'utf8')).toBe(preferences)
  })

  it('converges across independent initializers and restores preferences after a fresh instance', async () => {
    const path = join(await directory(), 'profile')
    const states = Array.from({ length: 16 }, () => new LocalState(new NodeLocalFiles(path)))
    const results = await Promise.all(states.map((state) => state.initialize()))
    const keys = results.map((r) => {
      if (!r.ok) throw new Error(r.error.code)
      return r.value.deviceKey
    })
    expect(new Set(keys).size).toBe(1)
    await states[0].updateSettings({ speechOutputEnabled: false })
    const restored = new LocalState(new NodeLocalFiles(path))
    expect(await restored.initialize()).toEqual({
      ok: true,
      value: { deviceKey: keys[0], settings: { speechOutputEnabled: false } }
    })
    expect((await fs.readdir(path)).sort()).toEqual(['device-settings.json', 'installation.json'])
  })

  it.skipIf(process.platform === 'win32')('uses owner-only file permissions on POSIX', async () => {
    const path = await directory()
    expect(await new LocalState(new NodeLocalFiles(path)).initialize()).toMatchObject({ ok: true })
    for (const name of ['installation.json', 'device-settings.json'])
      expect((await fs.stat(join(path, name))).mode & 0o777).toBe(0o600)
  })

  it('never replaces an existing identity with another initializer’s candidate', async () => {
    const path = await directory()
    const files = new NodeLocalFiles(path)
    expect(await files.create('installation.json', 'complete-winner')).toBe('created')
    expect(await files.create('installation.json', 'another-candidate')).toBe('exists')
    expect(await files.read('installation.json')).toBe('complete-winner')
    expect(await fs.readdir(path)).toEqual(['installation.json'])
  })

  it('preserves old settings and the key when publication fails after writing the temporary file', async () => {
    const path = await directory()
    await new LocalState(new NodeLocalFiles(path)).initialize()
    const before = await fs.readFile(join(path, 'device-settings.json'), 'utf8')
    const keyBefore = await fs.readFile(join(path, 'installation.json'), 'utf8')
    const files = new NodeLocalFiles(path, {
      ...fs,
      rename: async () => {
        throw new Error('publish failed')
      }
    })
    const state = new LocalState(files)
    await state.initialize()
    expect(await state.updateSettings({ speechOutputEnabled: false })).toMatchObject({ ok: false })
    expect(await fs.readFile(join(path, 'device-settings.json'), 'utf8')).toBe(before)
    expect(await fs.readFile(join(path, 'installation.json'), 'utf8')).toBe(keyBefore)
    expect(state.getSnapshot()?.settings.speechOutputEnabled).toBe(true)
    expect((await fs.readdir(path)).some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(await new LocalState(new NodeLocalFiles(path)).initialize()).toMatchObject({
      ok: true,
      value: { settings: { speechOutputEnabled: true } }
    })
  })

  it('does not publish a candidate on an initial publication failure', async () => {
    const path = await directory()
    const files = new NodeLocalFiles(path, {
      ...fs,
      link: async () => {
        throw new Error('publish failed')
      }
    })
    const state = new LocalState(files)
    expect(await state.initialize()).toMatchObject({ ok: false })
    expect(state.getSnapshot()).toBeNull()
    expect(await fs.readdir(path)).toEqual([])
  })

  it('does not truncate a destination when writing its temporary file fails', async () => {
    const path = await directory()
    await new LocalState(new NodeLocalFiles(path)).initialize()
    const files = new NodeLocalFiles(path, {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        handle.writeFile = async () => {
          throw new Error('disk full')
        }
        return handle
      }
    })
    const state = new LocalState(files)
    const before = await fs.readFile(join(path, 'device-settings.json'), 'utf8')
    expect(await state.updateSettings({ speechOutputEnabled: false })).toMatchObject({ ok: false })
    expect(await fs.readFile(join(path, 'device-settings.json'), 'utf8')).toBe(before)
    expect((await fs.readdir(path)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('keeps identity/settings separate from credentials across sign-out and account changes', async () => {
    const path = await directory()
    const state = new LocalState(new NodeLocalFiles(path))
    await state.initialize()
    await state.updateSettings({ speechOutputEnabled: false })
    const key = state.getSnapshot()!.deviceKey
    const credentialPath = join(path, 'auth-credential.bin')
    const auth = new AuthManager({
      gateway: new DevAuthGateway({ nowUnixMs: Date.now, latencyMs: 0 }),
      store: new SafeStorageCredentialStore(
        {
          isEncryptionAvailable: () => true,
          encryptString: (value) => Buffer.from(`encrypted:${value}`),
          decryptString: (value) => value.toString().slice('encrypted:'.length)
        },
        nodeCredentialFs,
        credentialPath
      ),
      sessionId: randomUUID(),
      nowUnixMs: Date.now,
      schedule: () => () => undefined
    })
    await auth.start()
    const result = await auth.signIn({
      requestId: 'login-1',
      generation: auth.getSnapshot().generation,
      input: { loginId: 'demo', password: 'demo1234' }
    })
    expect(result.ok).toBe(true)
    expect(await fs.readFile(credentialPath, 'utf8')).toContain('encrypted:')
    await auth.signOut()
    await expect(fs.access(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(state.getSnapshot()).toEqual({
      deviceKey: key,
      settings: { speechOutputEnabled: false }
    })
    await state.resetSettings()
    expect(state.getSnapshot()?.deviceKey).toBe(key)
    expect(
      await auth.signUp({
        requestId: 'signup-2',
        generation: auth.getSnapshot().generation,
        input: { loginId: 'second', password: 'another' }
      })
    ).toMatchObject({ ok: true })
    expect(
      await auth.signIn({
        requestId: 'login-2',
        generation: auth.getSnapshot().generation,
        input: { loginId: 'second', password: 'another' }
      })
    ).toMatchObject({ ok: true })
    expect(await new LocalState(new NodeLocalFiles(path)).initialize()).toMatchObject({
      ok: true,
      value: { deviceKey: key }
    })
    auth.dispose()
  })
})
