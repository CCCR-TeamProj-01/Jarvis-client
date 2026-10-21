import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { Result } from '../../shared/contracts/common'
import type { LocalFilesPort, LocalStatePort } from './ports'
import {
  DEFAULT_DEVICE_SETTINGS,
  DeviceSettingsSchema,
  InstallationDocumentSchema,
  SettingsDocumentSchema
} from './schema'
import type { DeviceSettings, LocalStateSnapshot } from './schema'

const unavailable = (): Result<never> => ({
  ok: false,
  error: {
    code: 'unavailable',
    message: '기기 정보를 읽거나 저장하지 못했습니다. 앱을 종료한 뒤 저장 파일을 확인해 주세요.'
  }
})

/** No coercion, silent recovery or migration of an unknown document. Never expose raw file data. */
function decode<S extends z.ZodType>(contents: string, schema: S): Result<z.infer<S>> {
  try {
    const document: unknown = JSON.parse(contents)
    if (
      document !== null &&
      typeof document === 'object' &&
      'version' in document &&
      document.version !== 1
    )
      return {
        ok: false,
        error: {
          code: 'unsupported',
          message: '지원하지 않는 기기 저장 형식입니다. 앱 버전을 확인해 주세요.'
        }
      }
    const parsed = schema.safeParse(document)
    return parsed.success ? { ok: true, value: parsed.data } : unavailable()
  } catch {
    return unavailable()
  }
}

/** One Main-owned queue: initialization, updates and reset never race within the running app. */
export class LocalState implements LocalStatePort {
  private snapshot: LocalStateSnapshot | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly files: LocalFilesPort,
    private readonly createKey: () => string = randomUUID
  ) {}

  getSnapshot(): LocalStateSnapshot | null {
    return structuredClone(this.snapshot)
  }

  initialize(): Promise<Result<LocalStateSnapshot>> {
    return this.enqueue(() => this.load())
  }

  updateSettings(input: unknown): Promise<Result<DeviceSettings>> {
    // Parse before enqueueing so the caller cannot change an already-accepted update in flight.
    const settings = DeviceSettingsSchema.safeParse(input)
    if (!settings.success)
      return Promise.resolve({
        ok: false,
        error: { code: 'invalid_input', message: '기기 설정 형식이 올바르지 않습니다.' }
      })
    return this.enqueue(async () => {
      const loaded = await this.load()
      if (!loaded.ok) return loaded
      try {
        await this.files.replace(
          'device-settings.json',
          JSON.stringify({ version: 1, settings: settings.data })
        )
        this.snapshot = { deviceKey: loaded.value.deviceKey, settings: settings.data }
        return { ok: true, value: structuredClone(settings.data) }
      } catch {
        return unavailable()
      }
    })
  }

  resetSettings(): Promise<Result<DeviceSettings>> {
    return this.updateSettings(DEFAULT_DEVICE_SETTINGS)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async load(): Promise<Result<LocalStateSnapshot>> {
    if (this.snapshot) return { ok: true, value: structuredClone(this.snapshot) }
    try {
      let installation = await this.files.read('installation.json')
      let preferences = await this.files.read('device-settings.json')
      if (installation === null && preferences !== null) {
        // Another initializer may have published both files after our first read.
        installation = await this.files.read('installation.json')
        // Existing preferences mean this is not a fresh installation. Do not silently re-key it.
        if (installation === null) return unavailable()
      }
      if (installation === null) {
        const generated = InstallationDocumentSchema.safeParse({
          version: 1,
          deviceKey: this.createKey()
        })
        if (!generated.success) return unavailable()
        await this.files.create('installation.json', JSON.stringify(generated.data))
        // Read the winner, even when a different store instance initialized at the same time.
        installation = await this.files.read('installation.json')
      }
      if (installation === null) return unavailable()
      const identity = decode(installation, InstallationDocumentSchema)
      if (!identity.ok) return identity

      if (preferences === null) {
        await this.files.create(
          'device-settings.json',
          JSON.stringify({ version: 1, settings: DEFAULT_DEVICE_SETTINGS })
        )
        preferences = await this.files.read('device-settings.json')
      }
      if (preferences === null) return unavailable()
      const settings = decode(preferences, SettingsDocumentSchema)
      if (!settings.ok) return settings

      this.snapshot = { deviceKey: identity.value.deviceKey, settings: settings.value.settings }
      return { ok: true, value: structuredClone(this.snapshot) }
    } catch {
      return unavailable()
    }
  }
}
