import { z } from 'zod'
import type { ClientError } from '../../shared/contracts/common'
import { classifyServerError, clientError } from './server-errors'
import { ServerClock } from './server-clock'

/**
 * Whether the request reached the server. A failed refresh-token exchange depends on it:
 * `not_sent` can simply be tried again, `no_response` may already have been processed.
 */
export type Delivery = 'not_sent' | 'no_response' | 'responded'

export interface ServerErrorDetail {
  delivery: Delivery
  status?: number
  /** The server's own error code, kept for logic only; never shown to the user. */
  serverCode?: string
  requestId?: string
  retryAfterMs?: number
}

export type ServerResult<T> =
  | { ok: true; value: T; status: number }
  | { ok: false; error: ClientError; detail: ServerErrorDetail }

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** For a call whose success carries no body (204). */
export const EmptyResponse = z.undefined()

export interface ServerRequest<T> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** A fixed path such as `/auth/login`. IDs inside it must already be encoded. */
  path: string
  query?: Readonly<Record<string, string | number | boolean | undefined>>
  body?: unknown
  idempotencyKey?: string
  /** Defaults to `bearer`. */
  auth?: 'bearer' | 'none'
  /** Validates a successful body; use `EmptyResponse` when there is none. */
  response: z.ZodType<T>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ServerClientOptions {
  /** Already validated by `parseServerBaseUrl`, without a trailing slash. */
  baseUrl: string
  fetch: FetchLike
  /** The current access token, or null when signed out. Read at the moment of each request. */
  accessToken(): string | null
  /** Wall clock in milliseconds; injected for tests. */
  now?(): number
  clock?: ServerClock
  defaultTimeoutMs?: number
  maxResponseBytes?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000

const PATH = /^\/[A-Za-z0-9_\-./~%]*$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/
const TOKEN = /^[A-Za-z0-9._~+/=-]+$/
const SERVER_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

/** Errors thrown before a request left this machine, in Node's and Chromium's vocabulary. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])
const NOT_SENT_MESSAGE =
  /net::ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_UNREACHABLE|CONNECTION_TIMED_OUT|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|CERT_|SSL_)/

/**
 * The REST spec's `{"error": {...}}`, and the `{"detail": {"code": ...}}` that the server's
 * framework produces for some failures (the rate limit, for one). A `detail` that is a list or a
 * string, as in a framework validation error, carries no code and is classified by status.
 */
const SpecEnvelopeSchema = z.looseObject({
  error: z.looseObject({ code: z.string().optional(), request_id: z.string().optional() })
})
const DetailEnvelopeSchema = z.looseObject({
  detail: z.looseObject({ code: z.string().optional() })
})

const failure = (
  error: ClientError,
  detail: ServerErrorDetail
): { ok: false; error: ClientError; detail: ServerErrorDetail } => ({ ok: false, error, detail })

/**
 * A fetch that failed before getting a response did not reach the server only for the failures
 * that happen while connecting. Anything else (a reset, a timeout after connecting, something
 * unknown) may have been processed, so it counts as sent.
 */
export function classifyNetworkError(error: unknown): 'not_sent' | 'no_response' {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, message, cause } = current as {
      code?: unknown
      message?: unknown
      cause?: unknown
    }
    if (typeof code === 'string' && NOT_SENT_CODES.has(code)) return 'not_sent'
    if (typeof message === 'string' && NOT_SENT_MESSAGE.test(message)) return 'not_sent'
    current = cause
  }
  return 'no_response'
}

/**
 * The one way the app talks to the server. It checks what goes out (address, path, headers),
 * attaches the access token only as a bearer header, and turns whatever comes back into a result
 * that never carries the server's own wording, the request body or a token. It does not retry:
 * whether to try again depends on the call, so the caller decides.
 */
export class ServerClient {
  readonly clock: ServerClock
  private readonly now: () => number

  constructor(private readonly options: ServerClientOptions) {
    this.clock = options.clock ?? new ServerClock()
    this.now = options.now ?? Date.now
  }

  async request<T>(request: ServerRequest<T>): Promise<ServerResult<T>> {
    const prepared = this.prepare(request)
    if (!prepared.ok) return prepared
    if (request.signal?.aborted) return failure(clientError('cancelled'), { delivery: 'not_sent' })

    const timeout = AbortSignal.timeout(
      request.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    )
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout

    let response: Response
    try {
      response = await this.options.fetch(prepared.url, { ...prepared.init, signal })
    } catch (error) {
      if (request.signal?.aborted)
        return failure(clientError('cancelled'), { delivery: 'no_response' })
      if (timeout.aborted) return failure(clientError('unavailable'), { delivery: 'no_response' })
      return failure(clientError('unavailable'), { delivery: classifyNetworkError(error) })
    }

    this.clock.observe(response.headers.get('date'), this.now())
    const status = response.status
    const responded: ServerErrorDetail = { delivery: 'responded', status }

    if (status >= 300 && status < 400) {
      await discard(response)
      return failure(clientError('unavailable'), responded)
    }

    const body = await readBody(
      response,
      this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    )
    if (!body.ok) {
      if (request.signal?.aborted) return failure(clientError('cancelled'), responded)
      return failure(
        clientError(body.reason === 'too_large' ? 'internal' : 'unavailable'),
        responded
      )
    }

    if (status >= 200 && status < 300)
      return this.success(request.response, status, response, body.text, responded)
    return failure(...this.failureFrom(status, response, body.text))
  }

  // --- internals -------------------------------------------------------------------------------

  private prepare<T>(
    request: ServerRequest<T>
  ):
    | { ok: true; url: string; init: RequestInit }
    | { ok: false; error: ClientError; detail: ServerErrorDetail } {
    const refuse = (code: ClientError['code']) =>
      failure(clientError(code), { delivery: 'not_sent' })
    if (!PATH.test(request.path) || request.path.includes('..') || request.path.includes('//'))
      return refuse('invalid_input')
    if (request.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(request.idempotencyKey))
      return refuse('invalid_input')

    // An encoded `..` is resolved by URL parsing, so the result must still sit under the base path.
    const base = new URL(this.options.baseUrl)
    const basePath = base.pathname.replace(/\/+$/, '')
    const url = new URL(`${this.options.baseUrl}${request.path}`)
    if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`))
      return refuse('invalid_input')
    for (const [key, value] of Object.entries(request.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value))

    const headers: Record<string, string> = { Accept: 'application/json' }
    if ((request.auth ?? 'bearer') === 'bearer') {
      const token = this.options.accessToken()
      if (token === null || !TOKEN.test(token)) return refuse('authentication_required')
      headers.Authorization = `Bearer ${token}`
    }
    if (request.idempotencyKey !== undefined) headers['Idempotency-Key'] = request.idempotencyKey

    let body: string | undefined
    if (request.body !== undefined) {
      try {
        body = JSON.stringify(request.body)
      } catch {
        return refuse('invalid_input')
      }
      headers['Content-Type'] = 'application/json'
    }
    return {
      ok: true,
      url: url.toString(),
      init: {
        method: request.method,
        headers,
        redirect: 'manual',
        ...(body === undefined ? {} : { body })
      }
    }
  }

  private success<T>(
    schema: z.ZodType<T>,
    status: number,
    response: Response,
    text: string,
    responded: ServerErrorDetail
  ): ServerResult<T> {
    let payload: unknown
    if (text !== '') {
      if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json'))
        return failure(clientError('internal'), responded)
      try {
        payload = JSON.parse(text)
      } catch {
        return failure(clientError('internal'), responded)
      }
    }
    const parsed = schema.safeParse(payload)
    // The reason is left out on purpose: it can quote what the server sent.
    if (!parsed.success) return failure(clientError('internal'), responded)
    return { ok: true, value: parsed.data, status }
  }

  private failureFrom(
    status: number,
    response: Response,
    text: string
  ): [ClientError, ServerErrorDetail] {
    let serverCode: string | undefined
    let requestId: string | undefined
    try {
      const body: unknown = JSON.parse(text)
      const spec = SpecEnvelopeSchema.safeParse(body)
      const detail = DetailEnvelopeSchema.safeParse(body)
      const code = spec.success
        ? spec.data.error.code
        : detail.success
          ? detail.data.detail.code
          : undefined
      const id = spec.success ? spec.data.error.request_id : undefined
      if (code !== undefined && SERVER_CODE.test(code)) serverCode = code
      if (id !== undefined && id.length <= 128) requestId = id
    } catch {
      /* A body that is not an error envelope is classified by its status alone. */
    }
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    return [
      classifyServerError(status, serverCode),
      {
        delivery: 'responded',
        status,
        ...(serverCode ? { serverCode } : {}),
        ...(requestId ? { requestId } : {}),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs })
      }
    ]
  }
}

/** Seconds only; an HTTP date is not worth supporting for the delays this server sends. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,7}$/.test(value.trim())) return undefined
  return Math.min(Number(value.trim()) * 1000, MAX_RETRY_AFTER_MS)
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* Nothing to clean up. */
  }
}

async function readBody(
  response: Response,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false; reason: 'too_large' | 'failed' }> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response)
    return { ok: false, reason: 'too_large' }
  }
  if (!response.body) return { ok: true, text: '' }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: 'failed' }
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) }
}
