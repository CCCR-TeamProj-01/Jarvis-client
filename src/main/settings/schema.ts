import { z } from 'zod'

/** Main-only settings. Account preferences and credentials never belong in this document. */
export const DeviceSettingsSchema = z.strictObject({
  speechOutputEnabled: z.boolean()
})
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>

export const DEFAULT_DEVICE_SETTINGS: Readonly<DeviceSettings> = Object.freeze({
  speechOutputEnabled: true
})

export const InstallationDocumentSchema = z.strictObject({
  version: z.literal(1),
  deviceKey: z.uuid()
})

export const SettingsDocumentSchema = z.strictObject({
  version: z.literal(1),
  settings: DeviceSettingsSchema
})

export interface LocalStateSnapshot {
  deviceKey: string
  settings: DeviceSettings
}
