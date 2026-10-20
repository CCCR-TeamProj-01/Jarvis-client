import type { Result } from '../../shared/contracts/common'
import type { CredentialStorePort, SessionCredential } from './ports'

/** Process-local store for tests. It is not durable and never writes to disk. */
export class MemoryCredentialStore implements CredentialStorePort {
  constructor(private credential: SessionCredential | null = null) {}

  async load(): Promise<Result<SessionCredential | null>> {
    return { ok: true, value: this.credential }
  }

  async save(credential: SessionCredential): Promise<Result<void>> {
    this.credential = credential
    return { ok: true, value: undefined }
  }

  async clear(): Promise<Result<void>> {
    this.credential = null
    return { ok: true, value: undefined }
  }
}
