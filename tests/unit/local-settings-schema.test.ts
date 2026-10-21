import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEVICE_SETTINGS,
  DeviceSettingsSchema,
  InstallationDocumentSchema,
  SettingsDocumentSchema
} from '../../src/main/settings/schema'

describe('Main-only local documents', () => {
  it('accepts the existing speech-output default and an explicit opt-out', () => {
    expect(DeviceSettingsSchema.parse(DEFAULT_DEVICE_SETTINGS)).toEqual({
      speechOutputEnabled: true
    })
    expect(
      SettingsDocumentSchema.parse({ version: 1, settings: { speechOutputEnabled: false } })
    ).toEqual({ version: 1, settings: { speechOutputEnabled: false } })
  })

  it('rejects coercion, incomplete preferences and account/credential fields', () => {
    for (const value of [
      {},
      { speechOutputEnabled: 'false' },
      { speechOutputEnabled: true, timezone: 'Asia/Seoul' },
      { speechOutputEnabled: true, activity_collection_enabled: true },
      { speechOutputEnabled: true, token: 'secret' }
    ])
      expect(DeviceSettingsSchema.safeParse(value).success).toBe(false)
  })

  it('does not accept an invalid identity or silently accept a future document version', () => {
    expect(
      InstallationDocumentSchema.safeParse({ version: 1, deviceKey: 'hardware-id' }).success
    ).toBe(false)
    expect(
      InstallationDocumentSchema.safeParse({
        version: 2,
        deviceKey: '8fd24879-90bd-4cf0-bccd-170bed601d3f'
      }).success
    ).toBe(false)
    expect(
      SettingsDocumentSchema.safeParse({ version: 2, settings: DEFAULT_DEVICE_SETTINGS }).success
    ).toBe(false)
  })
})
