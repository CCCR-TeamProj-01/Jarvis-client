import { z } from 'zod'
import type {
  CheckLoginIdInput,
  CheckLoginIdResult,
  SignInInput,
  SignUpInput,
  SignUpResult
} from '../../shared/contracts/auth'
import type { ClientError, Result } from '../../shared/contracts/common'
import { EmptyResponse } from '../connection/server-client'
import type { ServerClient, ServerResult } from '../connection/server-client'
import { clientError } from '../connection/server-errors'
import type { LocalExecutionOptions } from '../ports'
import type { DeviceInfo } from './device-info'
import type { AuthenticatedSession, AuthGatewayPort, SessionCredential } from './ports'
import { decodeSession, encodeSession } from './server-session'
import type { AccessTokenHolder, StoredSession } from './server-session'

export interface ServerAuthGatewayOptions {
  client: ServerClient
  /** The same holder the client reads its access token from. */
  tokens: AccessTokenHolder
  /** This machine as the server should know it, or why it cannot be described yet. */
  device(): Result<DeviceInfo>
  nowUnixMs(): number
}

/** An access token this close to its end is renewed before use rather than risked on a request. */
const ACCESS_MARGIN_MS = 60_000

const UserSchema = z.looseObject({ user_id: z.string().min(1), username: z.string().min(1) })
const TokensSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  access_expires_in: z.number().int().positive(),
  refresh_expires_in: z.number().int().positive()
})
const RegisterResponse = z.looseObject({ username: z.string().min(1) })
const LoginResponse = TokensSchema.extend({ session_id: z.string().min(1), user: UserSchema })
const RefreshResponse = TokensSchema
const MeResponse = z.looseObject({ user: UserSchema })

type Tokens = z.infer<typeof TokensSchema>

const failure = (error: ClientError): { ok: false; error: ClientError } => ({ ok: false, error })

/** The server's REST authentication behind the port the rest of the app already uses. */
export class ServerAuthGateway implements AuthGatewayPort {
  /** One refresh per refresh token at a time: a second caller waits for the first one's result. */
  private readonly refreshing = new Map<string, Promise<Result<StoredSession>>>()

  constructor(private readonly options: ServerAuthGatewayOptions) {}

  /**
   * PLACEHOLDER. The server has no endpoint for asking whether a login ID is free yet, so this
   * answers "available" for every ID without calling it. The real decision is made by the sign-up
   * itself (`USERNAME_TAKEN`). Replace this with the server call once the endpoint is defined
   * (see the REST API decisions in docs/delivery/validation.md).
   */
  async checkLoginId(
    input: CheckLoginIdInput,
    options?: LocalExecutionOptions
  ): Promise<Result<CheckLoginIdResult>> {
    if (options?.signal?.aborted) return failure(clientError('cancelled'))
    return { ok: true, value: { loginId: input.loginId, available: true } }
  }

  async signUp(input: SignUpInput, options?: LocalExecutionOptions): Promise<Result<SignUpResult>> {
    const result = await this.options.client.request({
      method: 'POST',
      path: '/auth/register',
      auth: 'none',
      body: { username: input.loginId, password: input.password },
      response: RegisterResponse,
      ...signalOf(options)
    })
    if (!result.ok) return failure(result.error)
    // The server stores the ID in its normal form (lower case); that is the one to show.
    return { ok: true, value: { loginId: result.value.username } }
  }

  async signIn(
    input: SignInInput,
    options?: LocalExecutionOptions
  ): Promise<Result<AuthenticatedSession>> {
    const device = this.options.device()
    if (!device.ok) return device
    const result = await this.options.client.request({
      method: 'POST',
      path: '/auth/login',
      auth: 'none',
      body: {
        username: input.loginId,
        password: input.password,
        device: {
          device_key: device.value.deviceKey,
          device_name: device.value.deviceName,
          platform: device.value.platform,
          client_version: device.value.clientVersion
        }
      },
      response: LoginResponse,
      ...signalOf(options)
    })
    if (!result.ok) return failure(result.error)
    const stored = this.stored(
      { sessionId: result.value.session_id, deviceKey: device.value.deviceKey },
      { userId: result.value.user.user_id, loginId: result.value.user.username },
      result.value
    )
    this.options.tokens.set(stored.accessToken)
    return this.session(stored)
  }

  async restore(
    credential: SessionCredential,
    options?: LocalExecutionOptions
  ): Promise<Result<AuthenticatedSession>> {
    const device = this.options.device()
    if (!device.ok) return device
    const stored = decodeSession(credential)
    // A session issued to another installation (or a damaged one) is not this device's session.
    if (stored === null || stored.deviceKey !== device.value.deviceKey) {
      this.options.tokens.clear()
      return failure(clientError('session_expired'))
    }

    let current = stored
    let renewed = false
    if (this.accessExpiring(current)) {
      const refreshed = await this.refresh(current, options)
      if (!refreshed.ok) return this.rejected(refreshed)
      current = refreshed.value
      renewed = true
    }

    this.options.tokens.set(current.accessToken)
    // A renewal already proves the session to the server. Asking again would risk losing the new
    // token pair to a failed second request, since the old refresh token is gone by now.
    if (renewed) return this.session(current)

    const me = await this.me(options)
    if (me.ok)
      return this.session({
        ...current,
        userId: me.value.user.user_id,
        loginId: me.value.user.username
      })
    // The stored access token may have been revoked on the server although its time is not up.
    if (me.error.code === 'session_expired') {
      const refreshed = await this.refresh(current, options)
      if (!refreshed.ok) return this.rejected(refreshed)
      this.options.tokens.set(refreshed.value.accessToken)
      return this.session(refreshed.value)
    }
    this.options.tokens.clear()
    return failure(me.error)
  }

  async signOut(
    credential: SessionCredential,
    options?: LocalExecutionOptions
  ): Promise<Result<void>> {
    const stored = decodeSession(credential)
    // Nothing this adapter issued, so there is no server session to end.
    if (stored === null) {
      this.options.tokens.clear()
      return { ok: true, value: undefined }
    }
    let current = stored
    if (this.accessExpiring(current)) {
      const refreshed = await this.refresh(current, options)
      if (!refreshed.ok) {
        this.options.tokens.clear()
        // A session the server no longer knows is already ended.
        return refreshed.error.code === 'session_expired'
          ? { ok: true, value: undefined }
          : failure(refreshed.error)
      }
      current = refreshed.value
    }
    this.options.tokens.set(current.accessToken)
    const result = await this.options.client.request({
      method: 'POST',
      path: '/auth/logout',
      response: EmptyResponse,
      ...signalOf(options)
    })
    this.options.tokens.clear()
    if (result.ok || result.error.code === 'session_expired') return { ok: true, value: undefined }
    return failure(result.error)
  }

  // --- internals -------------------------------------------------------------------------------

  private accessExpiring(session: StoredSession): boolean {
    return session.accessExpiresAtUnixMs - ACCESS_MARGIN_MS <= this.options.nowUnixMs()
  }

  private stored(
    session: Pick<StoredSession, 'sessionId' | 'deviceKey'>,
    user: Pick<StoredSession, 'userId' | 'loginId'>,
    tokens: Tokens
  ): StoredSession {
    const now = this.options.nowUnixMs()
    return {
      v: 1,
      sessionId: session.sessionId,
      deviceKey: session.deviceKey,
      userId: user.userId,
      loginId: user.loginId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresAtUnixMs: now + tokens.access_expires_in * 1000,
      refreshExpiresAtUnixMs: now + tokens.refresh_expires_in * 1000
    }
  }

  /**
   * The session as the rest of the app sees it. It ends when the refresh token does: the access
   * token is renewed behind the scenes and must not make the app re-check the login every hour.
   */
  private session(stored: StoredSession): Result<AuthenticatedSession> {
    return {
      ok: true,
      value: {
        user: { userId: stored.userId, loginId: stored.loginId },
        credential: encodeSession(stored),
        expiresAtUnixMs: stored.refreshExpiresAtUnixMs
      }
    }
  }

  private async me(options?: LocalExecutionOptions) {
    return this.options.client.request({
      method: 'GET',
      path: '/auth/me',
      response: MeResponse,
      ...signalOf(options)
    })
  }

  private rejected(result: { ok: false; error: ClientError }): { ok: false; error: ClientError } {
    this.options.tokens.clear()
    return result
  }

  /**
   * Exchanges a refresh token for a new pair. The server retires the old token the moment it
   * accepts the request, so a request that may have been accepted must never be repeated with it.
   * The caller's cancellation is not passed on for the same reason: once sent, the new pair has to
   * be received, or the session is lost.
   */
  private refresh(
    session: StoredSession,
    options?: LocalExecutionOptions
  ): Promise<Result<StoredSession>> {
    if (options?.signal?.aborted) return Promise.resolve(failure(clientError('cancelled')))
    const existing = this.refreshing.get(session.refreshToken)
    if (existing) return existing
    const started = this.exchange(session).finally(() => {
      this.refreshing.delete(session.refreshToken)
    })
    this.refreshing.set(session.refreshToken, started)
    return started
  }

  private async exchange(session: StoredSession): Promise<Result<StoredSession>> {
    const result = await this.options.client.request({
      method: 'POST',
      path: '/auth/refresh',
      auth: 'none',
      body: { refresh_token: session.refreshToken },
      response: RefreshResponse
    })
    if (result.ok)
      return {
        ok: true,
        value: this.stored(session, session, result.value)
      }
    return failure(this.refreshFailure(result))
  }

  /**
   * Which failures leave the stored session usable. Only a failure before the request was sent is
   * safe to try again with the same token. If the server answered with success but the answer was
   * lost or unreadable, or no answer came back at all, the token may already be retired and the
   * user has to sign in again.
   */
  private refreshFailure(result: Extract<ServerResult<unknown>, { ok: false }>): ClientError {
    const { detail } = result
    if (detail.delivery === 'not_sent') return clientError('unavailable')
    if (detail.delivery === 'no_response') return clientError('session_expired')
    if (detail.status !== undefined && detail.status >= 200 && detail.status < 300)
      return clientError('session_expired')
    return result.error
  }
}

const signalOf = (options?: LocalExecutionOptions) =>
  options?.signal ? { signal: options.signal } : {}
