import type {
  AuthEvent,
  AuthRequestContext,
  AuthSnapshot,
  AuthUser,
  CheckLoginIdRequest,
  CheckLoginIdResult,
  SignInRequest,
  SignInResult,
  SignUpRequest,
  SignUpResult
} from '../../shared/contracts/auth'
import { AuthSnapshotSchema, AuthUserSchema } from '../../shared/contracts/auth'
import { sameGeneration } from '../../shared/contracts/common'
import type { ClientError, Generation, Result, Unsubscribe } from '../../shared/contracts/common'
import type {
  AuthGatewayPort,
  AuthenticatedSession,
  CredentialStorePort,
  SessionCredential
} from './ports'

/** The server explicitly rejected the credential. Anything else is treated as a transient failure. */
const INVALID_CREDENTIAL_CODES: ReadonlySet<ClientError['code']> = new Set([
  'session_expired',
  'invalid_credentials',
  'authentication_required'
])

/** setTimeout cannot represent delays beyond a signed 32-bit integer. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

export interface AuthManagerOptions {
  gateway: AuthGatewayPort
  store: CredentialStorePort
  /** Stable for one app run; every authentication change advances the revision. */
  sessionId: string
  nowUnixMs(): number
  /** Returns a cancel function. Injected so expiry can be tested without real timers. */
  schedule(callback: () => void, delayMs: number): () => void
}

/** What other Main subsystems may depend on without seeing credentials or the gateway. */
export interface AuthPort {
  getSnapshot(): AuthSnapshot
  subscribe(listener: (event: AuthEvent) => void): Unsubscribe
  checkLoginId(request: CheckLoginIdRequest): Promise<Result<CheckLoginIdResult>>
  signUp(request: SignUpRequest): Promise<Result<SignUpResult>>
  signIn(request: SignInRequest): Promise<Result<SignInResult>>
  restore(request: AuthRequestContext): Promise<Result<SignInResult>>
  signOut(request?: AuthRequestContext): Promise<Result<void>>
}

interface Operation {
  readonly abort: AbortController
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Main-owned authentication state. Every phase change advances the generation, aborts the
 * in-flight operation and notifies invalidation listeners, so late results never apply to a
 * newer state. Local blocking never waits for the server.
 */
export class AuthManager implements AuthPort {
  private snapshot: AuthSnapshot
  /** Main-only. Survives `checking` so a transient failure can be retried without re-entering a password. */
  private recoveryCredential: SessionCredential | null = null
  private operation: Operation | null = null
  /** Overlapping read-only duplicate checks. A generation change aborts them all. */
  private readonly lookups = new Set<AbortController>()
  private cancelExpiry: (() => void) | null = null
  private renewal: Promise<Result<void>> | null = null
  private disposed = false
  private readonly listeners = new Set<(event: AuthEvent) => void>()
  private readonly invalidationListeners = new Set<(snapshot: AuthSnapshot) => void>()

  constructor(private readonly options: AuthManagerOptions) {
    this.snapshot = AuthSnapshotSchema.parse({
      phase: 'checking',
      generation: { sessionId: options.sessionId, revision: 0 },
      user: null
    })
  }

  getSnapshot(): AuthSnapshot {
    return structuredClone(this.snapshot)
  }

  isSignedIn(): boolean {
    return this.snapshot.phase === 'signed_in'
  }

  /** Entry points call this immediately before starting a protected action. */
  requireSignedIn(): Result<AuthUser> {
    return this.snapshot.phase === 'signed_in'
      ? { ok: true, value: structuredClone(this.snapshot.user) }
      : failure('authentication_required', '로그인이 필요합니다.')
  }

  subscribe(listener: (event: AuthEvent) => void): Unsubscribe {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Called on every generation change (including leaving `signed_in`). Subsystems cancel work and
   * drop per-account state when the generation they captured is no longer current.
   */
  onGenerationChange(listener: (snapshot: AuthSnapshot) => void): Unsubscribe {
    if (this.disposed) return () => undefined
    this.invalidationListeners.add(listener)
    return () => {
      this.invalidationListeners.delete(listener)
    }
  }

  /** Startup: restore a stored credential. Nothing is signed in until the server confirms it. */
  async start(): Promise<void> {
    if (this.disposed || this.snapshot.phase !== 'checking' || this.operation) return
    await this.runRestore()
  }

  async checkLoginId(request: CheckLoginIdRequest): Promise<Result<CheckLoginIdResult>> {
    const rejected = this.rejectUnlessCurrent(request, { allowSignedIn: false })
    if (rejected) return rejected
    const lookup = new AbortController()
    this.lookups.add(lookup)
    const generation = this.snapshot.generation
    const result = await this.options.gateway.checkLoginId(request.input, {
      signal: lookup.signal
    })
    this.lookups.delete(lookup)
    if (
      this.disposed ||
      lookup.signal.aborted ||
      !sameGeneration(generation, this.snapshot.generation)
    )
      return this.stale()
    if (!result.ok) return result
    // A response for another login ID must never be applied to this request.
    if (result.value.loginId !== request.input.loginId)
      return failure('conflict', '확인 결과가 요청과 일치하지 않습니다.')
    return result
  }

  async signUp(request: SignUpRequest): Promise<Result<SignUpResult>> {
    const rejected = this.rejectUnlessCurrent(request, { allowSignedIn: false })
    if (rejected) return rejected
    const operation = this.begin()
    if (!operation) return this.busy()
    const generation = this.snapshot.generation
    const result = await this.options.gateway.signUp(request.input, {
      signal: operation.abort.signal
    })
    this.end(operation)
    if (!this.stillCurrent(generation, operation)) return this.stale()
    return result
  }

  async signIn(request: SignInRequest): Promise<Result<SignInResult>> {
    const rejected = this.rejectUnlessCurrent(request, { allowSignedIn: false })
    if (rejected) return rejected
    const operation = this.begin()
    if (!operation) return this.busy()
    const generation = this.snapshot.generation
    const result = await this.options.gateway.signIn(request.input, {
      signal: operation.abort.signal
    })
    if (!this.stillCurrent(generation, operation)) {
      this.end(operation)
      return this.stale()
    }
    if (!result.ok) {
      this.end(operation)
      return result
    }
    return this.completeSignedIn(operation, generation, result.value, null)
  }

  async restore(request: AuthRequestContext): Promise<Result<SignInResult>> {
    const rejected = this.rejectUnlessCurrent(request, { allowSignedIn: false })
    if (rejected) return rejected
    if (this.snapshot.phase !== 'checking')
      return failure('conflict', '복구할 로그인 정보가 없습니다.')
    return this.runRestore()
  }

  /**
   * Block first, then clean up. The generation check is skipped on purpose: a stale UI must still
   * be able to sign out. Remote revocation is best-effort and never awaited.
   */
  async signOut(_request?: AuthRequestContext): Promise<Result<void>> {
    const credential = this.recoveryCredential
    this.recoveryCredential = null
    if (this.snapshot.phase !== 'signed_out' || this.operation) this.advance('signed_out', null)
    if (credential) this.revokeRemotely(credential)
    const cleared = await this.options.store.clear()
    if (!cleared.ok) {
      this.emitError(null, cleared.error)
      return cleared
    }
    return { ok: true, value: undefined }
  }

  /**
   * Keeps a signed-in session going: renews the access token through the gateway and keeps the
   * rotated credential. It changes neither the phase nor the generation, so nothing the user is
   * doing is interrupted. Callers that arrive while a renewal runs share its result.
   */
  renewSession(): Promise<Result<void>> {
    if (this.renewal) return this.renewal
    const running = this.runRenewal().finally(() => {
      this.renewal = null
    })
    this.renewal = running
    return running
  }

  private async runRenewal(): Promise<Result<void>> {
    const credential = this.recoveryCredential
    if (this.disposed || this.snapshot.phase !== 'signed_in' || credential === null)
      return failure('authentication_required', '로그인이 필요합니다.')
    const user = this.snapshot.user
    const generation = this.snapshot.generation
    // No cancellation is passed on: once a renewal was sent, its answer has to be received.
    const renewed = await this.options.gateway.restore(credential)
    if (this.disposed || !sameGeneration(generation, this.snapshot.generation)) return this.stale()
    if (!renewed.ok) {
      // Only a session the server has ended signs the user out; a passing failure changes nothing.
      if (INVALID_CREDENTIAL_CODES.has(renewed.error.code))
        await this.handleSessionRejected(renewed.error)
      return renewed
    }
    if (renewed.value.user.userId !== user.userId) {
      // A different account answering for this session is never accepted.
      await this.handleSessionRejected({
        code: 'session_expired',
        message: '로그인 정보가 올바르지 않습니다. 다시 로그인해 주세요.'
      })
      return failure('session_expired', '로그인 정보가 올바르지 않습니다.')
    }
    if (renewed.value.credential.opaque !== credential.opaque) {
      const saved = await this.options.store.save(renewed.value.credential)
      if (this.disposed || !sameGeneration(generation, this.snapshot.generation)) {
        // Signed out while saving: the credential must not outlive the session.
        void this.options.store.clear()
        return this.stale()
      }
      if (!saved.ok) {
        // The old stored credential is no longer valid, so the next start has to sign in again.
        void this.options.store.clear()
        this.emitError(null, { code: 'credential_unavailable', message: saved.error.message })
      }
    }
    this.recoveryCredential = renewed.value.credential
    this.scheduleExpiry(renewed.value.expiresAtUnixMs)
    return { ok: true, value: undefined }
  }

  /** The server rejected the session mid-use (for example during a later authenticated request). */
  async handleSessionRejected(error: ClientError): Promise<void> {
    if (this.disposed || this.snapshot.phase === 'signed_out') return
    this.recoveryCredential = null
    this.advance('signed_out', null)
    this.emitError(null, error)
    const cleared = await this.options.store.clear()
    if (!cleared.ok) this.emitError(null, cleared.error)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelExpiry?.()
    this.cancelExpiry = null
    this.operation?.abort.abort()
    this.operation = null
    for (const lookup of this.lookups) lookup.abort()
    this.lookups.clear()
    this.listeners.clear()
    this.invalidationListeners.clear()
  }

  // --- restore ---------------------------------------------------------------------------------

  private async runRestore(): Promise<Result<SignInResult>> {
    const operation = this.begin()
    if (!operation) return this.busy()
    const generation = this.snapshot.generation

    let credential = this.recoveryCredential
    if (!credential) {
      const loaded = await this.options.store.load()
      if (!this.stillCurrent(generation, operation)) {
        this.end(operation)
        return this.stale()
      }
      if (!loaded.ok) {
        // An unreadable store cannot be used to sign in. Let the user sign in again.
        this.end(operation)
        this.advance('signed_out', null)
        this.emitError(null, loaded.error)
        return loaded
      }
      if (loaded.value === null) {
        this.end(operation)
        this.advance('signed_out', null)
        return failure('authentication_required', '저장된 로그인 정보가 없습니다.')
      }
      credential = loaded.value
    }

    const restored = await this.options.gateway.restore(credential, {
      signal: operation.abort.signal
    })
    if (!this.stillCurrent(generation, operation)) {
      this.end(operation)
      return this.stale()
    }
    if (restored.ok) return this.completeSignedIn(operation, generation, restored.value, credential)

    this.end(operation)
    if (INVALID_CREDENTIAL_CODES.has(restored.error.code)) {
      this.recoveryCredential = null
      this.advance('signed_out', null)
      this.emitError(null, restored.error)
      const cleared = await this.options.store.clear()
      if (!cleared.ok) this.emitError(null, cleared.error)
      return restored
    }
    // Transient failure: keep the stored credential, stay blocked and allow a retry.
    this.recoveryCredential = credential
    this.emitError(null, restored.error)
    return restored
  }

  // --- shared completion -----------------------------------------------------------------------

  /**
   * Persist the recovery credential first, then publish `signed_in`. A sign-out that races with
   * the save makes the operation stale, and the just-saved credential is removed again.
   */
  private async completeSignedIn(
    operation: Operation,
    generation: Generation,
    session: AuthenticatedSession,
    previousCredential: SessionCredential | null
  ): Promise<Result<SignInResult>> {
    const user = AuthUserSchema.safeParse(session.user)
    if (
      !user.success ||
      !Number.isFinite(session.expiresAtUnixMs) ||
      session.expiresAtUnixMs <= this.options.nowUnixMs()
    ) {
      this.end(operation)
      return failure('internal', '로그인 정보가 올바르지 않습니다.')
    }

    let persistence: SignInResult['persistence'] = { status: 'stored' }
    if (previousCredential === null || previousCredential.opaque !== session.credential.opaque) {
      const saved = await this.options.store.save(session.credential)
      if (!saved.ok) {
        // Never leave another account's credential behind when this one could not be saved.
        void this.options.store.clear()
        persistence = {
          status: 'unavailable',
          error: { code: 'credential_unavailable', message: saved.error.message }
        }
        this.emitError(null, persistence.error)
      }
    }

    if (!this.stillCurrent(generation, operation)) {
      this.end(operation)
      void this.options.store.clear()
      return this.stale()
    }
    this.end(operation)
    this.recoveryCredential = session.credential
    this.advance('signed_in', user.data)
    this.scheduleExpiry(session.expiresAtUnixMs)
    const snapshot = AuthSnapshotSchema.parse(this.snapshot)
    if (snapshot.phase !== 'signed_in') return this.stale()
    return { ok: true, value: { snapshot: structuredClone(snapshot), persistence } }
  }

  /** At expiry the session must be verified again before protected features may continue. */
  private scheduleExpiry(expiresAtUnixMs: number): void {
    this.cancelExpiry?.()
    const generation = this.snapshot.generation
    const delay = Math.min(
      Math.max(0, expiresAtUnixMs - this.options.nowUnixMs()),
      MAX_TIMER_DELAY_MS
    )
    this.cancelExpiry = this.options.schedule(() => {
      if (this.disposed || !sameGeneration(generation, this.snapshot.generation)) return
      // Chunked delay: an expiry further away than one timer can hold re-arms itself.
      if (expiresAtUnixMs > this.options.nowUnixMs()) {
        this.scheduleExpiry(expiresAtUnixMs)
        return
      }
      this.advance('checking', null)
      void this.runRestore()
    }, delay)
  }

  // --- generation / operation bookkeeping ------------------------------------------------------

  private advance(phase: AuthSnapshot['phase'], user: AuthUser | null): void {
    if (this.disposed) return
    this.cancelExpiry?.()
    this.cancelExpiry = null
    this.operation?.abort.abort()
    this.operation = null
    for (const lookup of this.lookups) lookup.abort()
    this.lookups.clear()
    this.snapshot = AuthSnapshotSchema.parse({
      phase,
      generation: {
        sessionId: this.options.sessionId,
        revision: this.snapshot.generation.revision + 1
      },
      user
    })
    for (const listener of [...this.invalidationListeners]) {
      try {
        listener(this.getSnapshot())
      } catch {
        /* A subsystem failing to clean up must not keep the user signed in. */
      }
    }
    this.emit({ type: 'auth.state_changed', snapshot: this.getSnapshot() })
  }

  private begin(): Operation | null {
    if (this.operation) return null
    this.operation = { abort: new AbortController() }
    return this.operation
  }

  private end(operation: Operation): void {
    if (this.operation === operation) this.operation = null
  }

  private stillCurrent(generation: Generation, operation: Operation): boolean {
    return (
      !this.disposed &&
      !operation.abort.signal.aborted &&
      sameGeneration(generation, this.snapshot.generation)
    )
  }

  private rejectUnlessCurrent(
    request: AuthRequestContext,
    { allowSignedIn }: { allowSignedIn: boolean }
  ): Result<never> | null {
    if (this.disposed) return failure('cancelled', '요청이 취소되었습니다.')
    if (!sameGeneration(request.generation, this.snapshot.generation)) return this.stale()
    if (!allowSignedIn && this.snapshot.phase === 'signed_in')
      return failure('conflict', '이미 로그인되어 있습니다.')
    return null
  }

  private revokeRemotely(credential: SessionCredential): void {
    try {
      void this.options.gateway.signOut(credential).catch(() => undefined)
    } catch {
      /* Remote revocation is best-effort; the local block is already in place. */
    }
  }

  private stale(): Result<never> {
    return failure('conflict', '로그인 상태가 변경되었습니다. 다시 시도해 주세요.')
  }

  private busy(): Result<never> {
    return failure('conflict', '이미 처리 중인 로그인 요청이 있습니다.')
  }

  private emitError(requestId: string | null, error: ClientError): void {
    this.emit({ type: 'auth.error', generation: this.snapshot.generation, requestId, error })
  }

  private emit(event: AuthEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(event))
      } catch {
        /* Observers cannot prevent state transitions or other observers. */
      }
    }
  }
}
