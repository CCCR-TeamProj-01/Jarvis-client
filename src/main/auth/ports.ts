import type {
  AuthUser,
  CheckLoginIdInput,
  CheckLoginIdResult,
  SignInInput,
  SignUpInput,
  SignUpResult
} from '../../shared/contracts/auth'
import type { Result } from '../../shared/contracts/common'
import type { LocalExecutionOptions } from '../ports'

/** Opaque adapter-owned recovery data. Never expose this value in UI snapshots or events. */
export interface SessionCredential {
  readonly opaque: string
}

/** Main-only session. The adapter maps its own token format and server expiry to this value. */
export interface AuthenticatedSession {
  user: AuthUser
  credential: SessionCredential
  expiresAtUnixMs: number
}

export interface AuthGatewayPort {
  checkLoginId(
    input: CheckLoginIdInput,
    options?: LocalExecutionOptions
  ): Promise<Result<CheckLoginIdResult>>
  signUp(input: SignUpInput, options?: LocalExecutionOptions): Promise<Result<SignUpResult>>
  signIn(input: SignInInput, options?: LocalExecutionOptions): Promise<Result<AuthenticatedSession>>
  restore(
    credential: SessionCredential,
    options?: LocalExecutionOptions
  ): Promise<Result<AuthenticatedSession>>
  /** Repeated revocation is safe; AuthManager blocks locally before making this request. */
  signOut(credential: SessionCredential, options?: LocalExecutionOptions): Promise<Result<void>>
}

/** No plaintext fallback. Failed load/save/clear must return an error, not success or an empty store. */
export interface CredentialStorePort {
  load(): Promise<Result<SessionCredential | null>>
  save(credential: SessionCredential): Promise<Result<void>>
  /** Idempotent; cleanup still runs after the triggering request is aborted. */
  clear(): Promise<Result<void>>
}
