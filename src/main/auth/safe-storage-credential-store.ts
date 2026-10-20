import { z } from 'zod'
import type { Result } from '../../shared/contracts/common'
import type { CredentialStorePort, SessionCredential } from './ports'

/** The subset of Electron's safeStorage this store needs. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  /** Linux only. `basic_text` stores the key in plaintext, so it does not count as protected. */
  getSelectedStorageBackend?(): string
}

export interface CredentialFileSystem {
  read(path: string): Promise<Buffer | null>
  write(path: string, data: Buffer): Promise<void>
  remove(path: string): Promise<void>
}

const StoredSchema = z.strictObject({ v: z.literal(1), opaque: z.string().min(1) })

const unavailable = (message: string): Result<never> => ({
  ok: false,
  error: { code: 'credential_unavailable', message }
})

/**
 * OS-protected credential storage. When protection is not available the store fails instead of
 * falling back to plaintext; the caller then reports that login persistence is unavailable.
 */
export class SafeStorageCredentialStore implements CredentialStorePort {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly files: CredentialFileSystem,
    private readonly filePath: string
  ) {}

  async load(): Promise<Result<SessionCredential | null>> {
    try {
      const data = await this.files.read(this.filePath)
      if (data === null) return { ok: true, value: null }
      if (!this.isProtected()) return unavailable(PROTECTION_MESSAGE)
      const parsed = StoredSchema.safeParse(JSON.parse(this.safeStorage.decryptString(data)))
      if (!parsed.success) return unavailable('저장된 로그인 정보를 읽을 수 없습니다.')
      return { ok: true, value: { opaque: parsed.data.opaque } }
    } catch {
      return unavailable('저장된 로그인 정보를 읽을 수 없습니다.')
    }
  }

  async save(credential: SessionCredential): Promise<Result<void>> {
    if (!this.isProtected()) return unavailable(PROTECTION_MESSAGE)
    try {
      const encrypted = this.safeStorage.encryptString(
        JSON.stringify({ v: 1, opaque: credential.opaque })
      )
      await this.files.write(this.filePath, encrypted)
      return { ok: true, value: undefined }
    } catch {
      return unavailable('로그인 정보를 안전하게 저장하지 못했습니다.')
    }
  }

  async clear(): Promise<Result<void>> {
    try {
      await this.files.remove(this.filePath)
      return { ok: true, value: undefined }
    } catch {
      return unavailable('저장된 로그인 정보를 삭제하지 못했습니다.')
    }
  }

  private isProtected(): boolean {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return false
      return this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
    } catch {
      return false
    }
  }
}

const PROTECTION_MESSAGE = '이 기기에서는 로그인 정보를 안전하게 보관할 수 없습니다.'
