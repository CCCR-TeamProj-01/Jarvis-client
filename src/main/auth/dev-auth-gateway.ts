import type {
  CheckLoginIdInput,
  CheckLoginIdResult,
  SignInInput,
  SignUpInput,
  SignUpResult
} from '../../shared/contracts/auth'
import type { ClientError, Result } from '../../shared/contracts/common'
import type { LocalExecutionOptions } from '../ports'
import type { AuthenticatedSession, AuthGatewayPort, SessionCredential } from './ports'

/**
 * Development stand-in for the server. It is only selected explicitly (see create-auth-gateway.ts)
 * and must never be reachable from a packaged build. Accounts live in memory; the seeded account
 * survives restarts, accounts created at runtime do not.
 */
export const DEV_ACCOUNT = {
  loginId: 'demo',
  password: 'demo1234',
  userId: 'dev-user-demo'
} as const

export interface DevAuthGatewayOptions {
  nowUnixMs(): number
  sessionLifetimeMs?: number
  /** Artificial latency for exercising progress and late-response handling. */
  latencyMs?: number
  /** Awaited before each call; lets tests hold a request open deterministically. */
  gate?(operation: DevOperation): Promise<void>
  /** Make the next call of an operation fail with this error. */
  failNext?: Partial<Record<DevOperation, ClientError>>
}

export type DevOperation = 'checkLoginId' | 'signUp' | 'signIn' | 'restore' | 'signOut'

interface Account {
  userId: string
  password: string
}

export class DevAuthGateway implements AuthGatewayPort {
  private readonly accounts = new Map<string, Account>([
    [DEV_ACCOUNT.loginId, { userId: DEV_ACCOUNT.userId, password: DEV_ACCOUNT.password }]
  ])
  private readonly lifetimeMs: number
  private nextUserNumber = 1
  readonly calls: DevOperation[] = []

  constructor(private readonly options: DevAuthGatewayOptions) {
    this.lifetimeMs = options.sessionLifetimeMs ?? 60 * 60 * 1000
  }

  async checkLoginId(
    input: CheckLoginIdInput,
    execution?: LocalExecutionOptions
  ): Promise<Result<CheckLoginIdResult>> {
    const early = await this.enter('checkLoginId', execution)
    if (early) return early
    return {
      ok: true,
      value: { loginId: input.loginId, available: !this.accounts.has(input.loginId) }
    }
  }

  async signUp(
    input: SignUpInput,
    execution?: LocalExecutionOptions
  ): Promise<Result<SignUpResult>> {
    const early = await this.enter('signUp', execution)
    if (early) return early
    // The final uniqueness decision is made here, regardless of any earlier availability check.
    if (this.accounts.has(input.loginId))
      return {
        ok: false,
        error: { code: 'login_id_taken', message: '이미 사용 중인 아이디입니다.' }
      }
    this.accounts.set(input.loginId, {
      userId: `dev-user-${this.nextUserNumber++}`,
      password: input.password
    })
    return { ok: true, value: { loginId: input.loginId } }
  }

  async signIn(
    input: SignInInput,
    execution?: LocalExecutionOptions
  ): Promise<Result<AuthenticatedSession>> {
    const early = await this.enter('signIn', execution)
    if (early) return early
    const account = this.accounts.get(input.loginId)
    if (!account || account.password !== input.password)
      return {
        ok: false,
        error: { code: 'invalid_credentials', message: '아이디 또는 비밀번호가 올바르지 않습니다.' }
      }
    return { ok: true, value: this.session(input.loginId, account.userId) }
  }

  async restore(
    credential: SessionCredential,
    execution?: LocalExecutionOptions
  ): Promise<Result<AuthenticatedSession>> {
    const early = await this.enter('restore', execution)
    if (early) return early
    const userId = credential.opaque.startsWith('dev-session:')
      ? credential.opaque.slice('dev-session:'.length)
      : null
    for (const [loginId, account] of this.accounts)
      if (account.userId === userId)
        return { ok: true, value: this.session(loginId, account.userId) }
    return {
      ok: false,
      error: {
        code: 'session_expired',
        message: '로그인 정보가 만료되었습니다. 다시 로그인해 주세요.'
      }
    }
  }

  async signOut(
    _credential: SessionCredential,
    execution?: LocalExecutionOptions
  ): Promise<Result<void>> {
    const early = await this.enter('signOut', execution)
    if (early) return early
    return { ok: true, value: undefined }
  }

  private session(loginId: string, userId: string): AuthenticatedSession {
    return {
      user: { userId, loginId },
      credential: { opaque: `dev-session:${userId}` },
      expiresAtUnixMs: this.options.nowUnixMs() + this.lifetimeMs
    }
  }

  private async enter(
    operation: DevOperation,
    execution?: LocalExecutionOptions
  ): Promise<Result<never> | null> {
    this.calls.push(operation)
    if (this.options.latencyMs) await sleep(this.options.latencyMs, execution?.signal)
    await this.options.gate?.(operation)
    if (execution?.signal?.aborted)
      return { ok: false, error: { code: 'cancelled', message: '요청이 취소되었습니다.' } }
    const injected = this.options.failNext?.[operation]
    if (injected) {
      delete this.options.failNext?.[operation]
      return { ok: false, error: injected }
    }
    return null
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}
