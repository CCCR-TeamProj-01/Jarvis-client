import { describe, expect, it, vi } from 'vitest'
import { LocalState } from '../../src/main/settings/local-state'
import type { LocalFileName, LocalFilesPort } from '../../src/main/settings/ports'

const KEY = '8fd24879-90bd-4cf0-bccd-170bed601d3f'
const identity = JSON.stringify({ version: 1, deviceKey: KEY })
const preferences = (enabled: boolean) =>
  JSON.stringify({ version: 1, settings: { speechOutputEnabled: enabled } })

function setup() {
  const data = new Map<LocalFileName, string>()
  const files: LocalFilesPort = {
    read: vi.fn<LocalFilesPort['read']>(async (name) => data.get(name) ?? null),
    create: vi.fn<LocalFilesPort['create']>(async (name, contents) => {
      if (data.has(name)) return 'exists' as const
      data.set(name, contents)
      return 'created' as const
    }),
    replace: vi.fn<LocalFilesPort['replace']>(async (name, contents) => {
      data.set(name, contents)
    })
  }
  const createKey = vi.fn<() => string>(() => KEY)
  return { data, files, createKey, state: new LocalState(files, createKey) }
}

describe('LocalState', () => {
  it('does not issue a new identity when only the installation file has been lost', async () => {
    const { data, state, createKey, files } = setup()
    data.set('device-settings.json', preferences(false))
    expect(await state.initialize()).toMatchObject({ ok: false })
    expect(await state.resetSettings()).toMatchObject({ ok: false })
    expect(createKey).not.toHaveBeenCalled()
    expect(files.create).not.toHaveBeenCalled()
    expect(data.get('device-settings.json')).toBe(preferences(false))
  })

  it('coalesces concurrent initialization and returns independent snapshots', async () => {
    const { state, createKey } = setup()
    expect(state.getSnapshot()).toBeNull()
    const results = await Promise.all(Array.from({ length: 10 }, () => state.initialize()))
    expect(createKey).toHaveBeenCalledOnce()
    expect(results.every((r) => r.ok && r.value.deviceKey === KEY)).toBe(true)
    const first = results[0]
    if (!first.ok) throw new Error('setup failed')
    first.value.settings.speechOutputEnabled = false
    expect(state.getSnapshot()?.settings.speechOutputEnabled).toBe(true)
    const copy = state.getSnapshot()!
    copy.deviceKey = 'tampered'
    expect(state.getSnapshot()?.deviceKey).toBe(KEY)
  })

  it('reads a competing initializer’s complete key instead of exposing its own candidate', async () => {
    const { data, files, state } = setup()
    const winner = '1eb420b0-1835-4dbb-a083-f319ca682a64'
    vi.mocked(files.create).mockImplementation(async (name, contents) => {
      data.set(
        name,
        name === 'installation.json' ? JSON.stringify({ version: 1, deviceKey: winner }) : contents
      )
      return 'exists'
    })
    expect(await state.initialize()).toMatchObject({ ok: true, value: { deviceKey: winner } })
  })

  it('rejects a generated invalid key before any document is created', async () => {
    const { data, files } = setup()
    expect(await new LocalState(files, () => 'bad').initialize()).toMatchObject({ ok: false })
    expect(data.size).toBe(0)
  })

  it.each([
    'not-json',
    '{}',
    JSON.stringify({ version: 1, deviceKey: 'bad' }),
    JSON.stringify({ version: 1, deviceKey: KEY, userId: 'other' })
  ])('preserves a corrupt installation document (%s)', async (contents) => {
    const { data, files, state, createKey } = setup()
    data.set('installation.json', contents)
    expect(await state.initialize()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(await state.resetSettings()).toMatchObject({ ok: false })
    expect(state.getSnapshot()).toBeNull()
    expect(data.get('installation.json')).toBe(contents)
    expect(files.create).not.toHaveBeenCalled()
    expect(createKey).not.toHaveBeenCalled()
  })

  it.each(['installation.json', 'device-settings.json'] as const)(
    'preserves unsupported %s versions even on reset',
    async (name) => {
      const { data, state } = setup()
      data.set('installation.json', identity)
      data.set(
        name,
        JSON.stringify({ version: 2, deviceKey: KEY, settings: { speechOutputEnabled: false } })
      )
      const before = new Map(data)
      expect(await state.initialize()).toMatchObject({ ok: false, error: { code: 'unsupported' } })
      expect(await state.resetSettings()).toMatchObject({
        ok: false,
        error: { code: 'unsupported' }
      })
      expect(data).toEqual(before)
    }
  )

  it('preserves corrupt settings and its valid identity rather than silently restoring defaults', async () => {
    const { data, state } = setup()
    data.set('installation.json', identity)
    data.set('device-settings.json', '{broken')
    expect(await state.initialize()).toMatchObject({ ok: false })
    expect(data.get('device-settings.json')).toBe('{broken')
    data.set('device-settings.json', preferences(false))
    expect(await state.initialize()).toMatchObject({
      ok: true,
      value: { deviceKey: KEY, settings: { speechOutputEnabled: false } }
    })
  })

  it('does not turn read failures into a new installation and sanitizes the error', async () => {
    const { state, files, createKey } = setup()
    vi.mocked(files.read).mockRejectedValue(new Error('secret-file-path/token'))
    const result = await state.initialize()
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(JSON.stringify(result)).not.toContain('secret-file-path')
    expect(createKey).not.toHaveBeenCalled()
    expect(files.create).not.toHaveBeenCalled()
  })

  it('never publishes an unpersisted key and can retry after a write failure', async () => {
    const { state, files } = setup()
    vi.mocked(files.create).mockRejectedValueOnce(new Error('disk full'))
    expect(await state.initialize()).toMatchObject({ ok: false })
    expect(state.getSnapshot()).toBeNull()
    expect(await state.initialize()).toMatchObject({ ok: true, value: { deviceKey: KEY } })
  })

  it('keeps a persisted key when the separate settings initialization fails', async () => {
    const { data, files, state, createKey } = setup()
    vi.mocked(files.create).mockImplementation(async (name, contents) => {
      if (name === 'device-settings.json') throw new Error('disk full')
      data.set(name, contents)
      return 'created'
    })
    expect(await state.initialize()).toMatchObject({ ok: false })
    expect(data.get('installation.json')).toBe(identity)
    expect(state.getSnapshot()).toBeNull()
    expect(await state.initialize()).toMatchObject({ ok: false })
    expect(createKey).toHaveBeenCalledOnce()
  })

  it('rejects incomplete, coerced, identity and account updates without touching disk', async () => {
    const { state, files } = setup()
    for (const input of [
      null,
      {},
      { speechOutputEnabled: 'false' },
      { speechOutputEnabled: false, deviceKey: KEY },
      { speechOutputEnabled: true, timezone: 'Asia/Seoul' },
      { speechOutputEnabled: true, activity_collection_enabled: true },
      { speechOutputEnabled: true, password: 'secret' }
    ]) {
      expect(await state.updateSettings(input)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    }
    expect(files.read).not.toHaveBeenCalled()
    expect(files.replace).not.toHaveBeenCalled()
  })

  it('serializes reset after an in-flight save and publishes only persisted values', async () => {
    const { state, files, data } = setup()
    await state.initialize()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(files.replace).mockImplementationOnce(async (name, contents) => {
      await blocked
      data.set(name, contents)
    })
    const input = { speechOutputEnabled: false }
    const saved = state.updateSettings(input)
    input.speechOutputEnabled = true
    const reset = state.resetSettings()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(files.replace).toHaveBeenCalledTimes(1)
    expect(state.getSnapshot()?.settings.speechOutputEnabled).toBe(true)
    release()
    expect(await saved).toEqual({ ok: true, value: { speechOutputEnabled: false } })
    expect(await reset).toEqual({ ok: true, value: { speechOutputEnabled: true } })
    expect(data.get('installation.json')).toBe(identity)
    expect(data.get('device-settings.json')).toBe(preferences(true))
  })

  it('retains the previous memory/disk value on save failure, then allows another update', async () => {
    const { state, files, data } = setup()
    await state.initialize()
    vi.mocked(files.replace).mockRejectedValueOnce(new Error('disk full'))
    expect(await state.updateSettings({ speechOutputEnabled: false })).toMatchObject({ ok: false })
    expect(state.getSnapshot()?.settings.speechOutputEnabled).toBe(true)
    expect(data.get('device-settings.json')).toBe(preferences(true))
    expect(await state.updateSettings({ speechOutputEnabled: false })).toMatchObject({ ok: true })
    expect(state.getSnapshot()?.settings.speechOutputEnabled).toBe(false)
  })
})
