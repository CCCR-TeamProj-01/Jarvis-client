import type { Result } from '../../shared/contracts/common'
import type { DeviceSettings, LocalStateSnapshot } from './schema'

export type LocalFileName = 'installation.json' | 'device-settings.json' | 'command-journal.json'

/** Throw on I/O errors; only an absent document is represented by null. */
export interface LocalFilesPort {
  read(name: LocalFileName): Promise<string | null>
  /** Publish a complete document without replacing an existing installation/settings file. */
  create(name: LocalFileName, contents: string): Promise<'created' | 'exists'>
  /** Publish a complete replacement; failure must preserve the previous valid document. */
  replace(name: LocalFileName, contents: string): Promise<void>
}

/** Main internal API, deliberately absent from Preload/Renderer contracts. */
export interface LocalStatePort {
  initialize(): Promise<Result<LocalStateSnapshot>>
  /** Null until both documents have been read and validated. Returned values are copies. */
  getSnapshot(): LocalStateSnapshot | null
  /** A complete, strictly validated replacement. Publish only after persistence succeeds. */
  updateSettings(input: unknown): Promise<Result<DeviceSettings>>
  /** Reset device preferences only; never delete the installation key or credentials. */
  resetSettings(): Promise<Result<DeviceSettings>>
}
