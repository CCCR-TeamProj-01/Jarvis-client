import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  EmptyResponse,
  ServerClient,
  classifyNetworkError
} from '../../src/main/connection/server-client'
import type { FetchLike, ServerResult } from '../../src/main/connection/server-client'
import { ServerIdSchema } from '../../src/main/connection/server-ids'

const BASE = 'http://127.0.0.1:8000/api/v1'
const TOKEN = 'tok_SECRET.value-123'

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init
  })

function setup(
  respond: (url: string, init: RequestInit) => Promise<Response> | Response,
  options: {
    token?: string | null
    baseUrl?: string
    maxResponseBytes?: number
    now?: () => number
  } = {}
) {
  const fetch = vi.fn<FetchLike>(async (url, init) => respond(url, init))
  const client = new ServerClient({
    baseUrl: options.baseUrl ?? BASE,
    fetch,
    accessToken: () => (options.token === undefined ? TOKEN : options.token),
    ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    ...(options.now ? { now: options.now } : {})
  })
  return { client, fetch }
}

const Device = z.object({ device_id: ServerIdSchema, device_name: z.string() })

describe('requests', () => {
  it('sends a checked request with the token only as a bearer header and validates the answer', async () => {
    const { client, fetch } = setup(() => json({ device_id: 12, device_name: '집 PC' }))
    const result = await client.request({
      method: 'POST',
      path: '/conversations/conv_1/messages',
      query: { limit: 5, skip: undefined, q: 'a b&c=d' },
      body: { request_id: 'req_1', content: '안녕' },
      idempotencyKey: 'idem-key-12345',
      response: Device
    })
    expect(result).toEqual({
      ok: true,
      value: { device_id: '12', device_name: '집 PC' },
      status: 200
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/conversations/conv_1/messages?limit=5&q=a+b%26c%3Dd`)
    expect(url).not.toContain(TOKEN)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(init.body).toBe(JSON.stringify({ request_id: 'req_1', content: '안녕' }))
    expect(init.headers).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'Idempotency-Key': 'idem-key-12345',
      'Content-Type': 'application/json'
    })
  })

  it('leaves the token off a request that does not need one', async () => {
    const { client, fetch } = setup(() => json({ status: 'ok' }))
    await client.request({
      method: 'POST',
      path: '/auth/login',
      body: { username: 'a' },
      auth: 'none',
      response: z.object({ status: z.string() })
    })
    expect(fetch.mock.calls[0]![1].headers).not.toHaveProperty('Authorization')
  })

  it('does not send a protected request without a usable token', async () => {
    for (const token of [null, 'bad token', 'a\r\nX-Evil: 1', '']) {
      const { client, fetch } = setup(() => json({}), { token })
      expect(
        await client.request({ method: 'GET', path: '/auth/me', response: z.object({}) })
      ).toMatchObject({
        ok: false,
        error: { code: 'authentication_required' },
        detail: { delivery: 'not_sent' }
      })
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it('refuses paths and headers it cannot vouch for before sending anything', async () => {
    const { client, fetch } = setup(() => json({}))
    const run = (path: string, extra: object = {}) =>
      client.request({ method: 'GET', path, response: z.unknown(), ...extra })
    for (const path of [
      'auth/me',
      '/a/../b',
      '//evil.example/x',
      '/a b',
      '/x?y=1',
      '/x#frag',
      '/%2e%2e/admin',
      '/api/%2E%2E/%2E%2E/other',
      '/a\nb'
    ])
      expect(await run(path)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    for (const key of ['short', 'has space here', 'x\r\nInjected: 1', 'a'.repeat(129)])
      expect(await run('/ok', { idempotencyKey: key })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('works with an address that has no path prefix', async () => {
    const { client, fetch } = setup(() => json({}), { baseUrl: 'https://api.example.com' })
    expect(
      await client.request({ method: 'GET', path: '/health', response: z.object({}) })
    ).toMatchObject({
      ok: true
    })
    expect(fetch.mock.calls[0]![0]).toBe('https://api.example.com/health')
  })

  it('accepts an empty success only when the caller expects one', async () => {
    const { client } = setup(() => new Response(null, { status: 204 }))
    expect(
      await client.request({ method: 'POST', path: '/auth/logout', response: EmptyResponse })
    ).toEqual({
      ok: true,
      value: undefined,
      status: 204
    })
    expect(
      await client.request({
        method: 'GET',
        path: '/auth/me',
        response: z.object({ a: z.string() })
      })
    ).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
})

describe('what comes back', () => {
  const failed = async (response: Response, options: Parameters<typeof setup>[1] = {}) => {
    const { client } = setup(() => response, options)
    return (await client.request({
      method: 'GET',
      path: '/x',
      response: z.object({ ok: z.boolean() })
    })) as Extract<ServerResult<unknown>, { ok: false }>
  }

  it('turns the error envelope into a client error and keeps the server code for logic', async () => {
    const result = await failed(
      json(
        {
          error: {
            code: 'INVALID_SESSION',
            message: 'token for user 77 expired',
            request_id: 'req-01J'
          }
        },
        { status: 401 }
      )
    )
    expect(result.error.code).toBe('session_expired')
    expect(result.detail).toEqual({
      delivery: 'responded',
      status: 401,
      serverCode: 'INVALID_SESSION',
      requestId: 'req-01J'
    })
    expect(JSON.stringify(result)).not.toContain('user 77')
  })

  it('classifies by status when the body is not an error envelope', async () => {
    expect(
      (await failed(new Response('<html>bad gateway</html>', { status: 502 }))).error.code
    ).toBe('unavailable')
    expect((await failed(json({ detail: 'x' }, { status: 409 }))).error.code).toBe('conflict')
    expect((await failed(new Response('', { status: 503 }))).error.code).toBe('unavailable')
  })

  it('reads the code from the framework `detail` shape too, and ignores a detail without one', async () => {
    const limited = await failed(
      json({ detail: { code: 'RATE_LIMITED' } }, { status: 429, headers: { 'retry-after': '7' } })
    )
    expect(limited.error.code).toBe('rate_limited')
    expect(limited.detail).toMatchObject({
      status: 429,
      serverCode: 'RATE_LIMITED',
      retryAfterMs: 7000
    })
    // A framework validation error lists problems instead; the status alone decides.
    const listed = await failed(
      json({ detail: [{ loc: ['body', 'username'], msg: 'too short' }] }, { status: 422 })
    )
    expect(listed.error.code).toBe('invalid_input')
    expect(listed.detail.serverCode).toBeUndefined()
    const text = await failed(json({ detail: 'Not Found' }, { status: 404 }))
    expect(text.error.code).toBe('not_found')
  })

  it('ignores a server code or request ID that does not look like one', async () => {
    const result = await failed(
      json({ error: { code: 'lower case; DROP', request_id: 'r'.repeat(500) } }, { status: 500 })
    )
    expect(result.detail.serverCode).toBeUndefined()
    expect(result.detail.requestId).toBeUndefined()
  })

  it('passes Retry-After on as a delay and never retries by itself', async () => {
    const { client, fetch } = setup(() =>
      json({ error: { code: 'RATE_LIMITED' } }, { status: 429, headers: { 'retry-after': '3' } })
    )
    const result = await client.request({ method: 'GET', path: '/x', response: z.unknown() })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'rate_limited' },
      detail: { retryAfterMs: 3000 }
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(
      (await failed(json({}, { status: 429, headers: { 'retry-after': 'soon' } }))).detail
        .retryAfterMs
    ).toBeUndefined()
    expect(
      (await failed(json({}, { status: 429, headers: { 'retry-after': '99999999' } }))).detail
        .retryAfterMs
    ).toBeUndefined()
    expect(
      (await failed(json({}, { status: 429, headers: { 'retry-after': '999999' } }))).detail
        .retryAfterMs
    ).toBe(3_600_000)
  })

  it('does not follow a redirect', async () => {
    const result = await failed(
      new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
    )
    expect(result.error.code).toBe('unavailable')
    expect(result.detail).toMatchObject({ delivery: 'responded', status: 302 })
  })

  it('does not accept a success that is not the agreed JSON', async () => {
    expect(
      (
        await failed(
          new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'text/html' } })
        )
      ).error.code
    ).toBe('internal')
    expect((await failed(json('{broken'))).error.code).toBe('internal')
    const mismatch = await failed(json({ ok: 'yes', 'server-supplied-text': 1 }))
    expect(mismatch.error.code).toBe('internal')
    expect(JSON.stringify(mismatch)).not.toContain('server-supplied-text')
    // A strict schema names the unexpected key in its issues; that must not reach the result.
    const { client } = setup(() => json({ ok: true, 'server-supplied-text': 1 }))
    const strict = await client.request({
      method: 'GET',
      path: '/x',
      response: z.strictObject({ ok: z.boolean() })
    })
    expect(strict).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(strict)).not.toContain('server-supplied-text')
  })

  it('refuses an unsafe integer ID in an answer', async () => {
    const { client } = setup(
      () =>
        new Response('{"device_id": 9007199254740993, "device_name": "x"}', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    expect(await client.request({ method: 'GET', path: '/x', response: Device })).toMatchObject({
      ok: false,
      error: { code: 'internal' }
    })
  })

  it('refuses an answer that is too large, declared or streamed', async () => {
    const declared = await failed(
      new Response('x', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '2000' }
      }),
      { maxResponseBytes: 1000 }
    )
    expect(declared.error.code).toBe('internal')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":"'))
        controller.enqueue(new TextEncoder().encode('a'.repeat(2000)))
        controller.close()
      }
    })
    const streamed = await failed(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
      {
        maxResponseBytes: 1000
      }
    )
    expect(streamed.error.code).toBe('internal')
  })

  it('reports a body that breaks off after the headers as unavailable but responded', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket hang up'))
      }
    })
    const result = await failed(
      new Response(stream, { status: 201, headers: { 'content-type': 'application/json' } })
    )
    expect(result.error.code).toBe('unavailable')
    expect(result.detail).toMatchObject({ delivery: 'responded', status: 201 })
  })

  it('learns the server clock from the Date header', async () => {
    const { client } = setup(
      () => json({ ok: true }, { headers: { date: 'Thu, 22 Oct 2026 00:00:10 GMT' } }),
      {
        now: () => Date.parse('2026-10-22T00:00:00Z')
      }
    )
    await client.request({ method: 'GET', path: '/x', response: z.unknown() })
    expect(client.clock.offsetMs).toBe(10_000)
  })
})

describe('when the request does not get an answer', () => {
  const networkFailure = (error: unknown) => async () => {
    throw error
  }
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' })
  })

  it('tells a failure before connecting from one that may have been processed', () => {
    expect(classifyNetworkError(refused)).toBe('not_sent')
    expect(classifyNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('not_sent')
    expect(classifyNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('not_sent')
    expect(classifyNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe('not_sent')
    expect(
      classifyNetworkError(Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))
    ).toBe('not_sent')
    expect(classifyNetworkError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(
      'not_sent'
    )
    expect(classifyNetworkError(new Error('net::ERR_CONNECTION_RESET'))).toBe('no_response')
    expect(
      classifyNetworkError(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        })
      )
    ).toBe('no_response')
    expect(classifyNetworkError('something odd')).toBe('no_response')
    expect(classifyNetworkError(undefined)).toBe('no_response')
  })

  it('reports each case as unavailable with the right delivery', async () => {
    for (const [error, delivery] of [
      [refused, 'not_sent'],
      [new Error('net::ERR_CONNECTION_CLOSED'), 'no_response']
    ] as const) {
      const { client } = setup(networkFailure(error))
      expect(
        await client.request({ method: 'POST', path: '/auth/refresh', response: z.unknown() })
      ).toMatchObject({
        ok: false,
        error: { code: 'unavailable' },
        detail: { delivery }
      })
    }
  })

  it('gives up after the time limit and counts it as possibly sent', async () => {
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    expect(
      await client.request({ method: 'GET', path: '/slow', response: z.unknown(), timeoutMs: 30 })
    ).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
      detail: { delivery: 'no_response' }
    })
  })

  it('distinguishes the caller cancelling from a timeout', async () => {
    const controller = new AbortController()
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
          setTimeout(() => controller.abort(), 5)
        })
    )
    expect(
      await client.request({
        method: 'GET',
        path: '/slow',
        response: z.unknown(),
        signal: controller.signal
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
      detail: { delivery: 'no_response' }
    })
  })

  it('does not send anything for a request that is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client, fetch } = setup(() => json({}))
    expect(
      await client.request({
        method: 'GET',
        path: '/x',
        response: z.unknown(),
        signal: controller.signal
      })
    ).toMatchObject({ ok: false, error: { code: 'cancelled' }, detail: { delivery: 'not_sent' } })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('secrets', () => {
  it('never puts the token or the request body into a result', async () => {
    const results: unknown[] = []
    const failures: (() => Promise<Response> | Response)[] = [
      () =>
        json(
          { error: { code: 'INVALID_CREDENTIALS', message: 'bad password hunter2-pass' } },
          { status: 401 }
        ),
      () => new Response('hunter2-pass', { status: 500 }),
      () => json({ ok: 'no' }),
      () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: new Error(`failed with ${TOKEN} hunter2-pass`)
        })
      }
    ]
    for (const respond of failures) {
      const { client } = setup(respond)
      results.push(
        await client.request({
          method: 'POST',
          path: '/auth/login',
          body: { username: 'jarvis', password: 'hunter2-pass' },
          response: z.object({ ok: z.boolean() })
        })
      )
    }
    const text = JSON.stringify(results)
    expect(text).not.toContain('hunter2-pass')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('127.0.0.1')
  })
})

describe('keeping the access token good', () => {
  const unauthorized = () =>
    json({ error: { code: 'INVALID_SESSION', message: 'x' } }, { status: 401 })

  /** A client whose token can be swapped, as a renewal would, and that counts renewals. */
  function renewing(
    respond: (init: RequestInit) => Response,
    renew: () => Promise<boolean> | boolean
  ) {
    let token: string | null = 'old-token'
    let renewals = 0
    const fetch = vi.fn<FetchLike>(async (_url, init) => respond(init))
    const client = new ServerClient({
      baseUrl: BASE,
      fetch,
      accessToken: async () => token,
      renewAccessToken: async () => {
        renewals += 1
        const renewed = await renew()
        if (renewed) token = 'new-token'
        return renewed
      }
    })
    return { client, fetch, renewals: () => renewals }
  }
  const bearer = (init: RequestInit) => (init.headers as Record<string, string>).Authorization

  it('waits for an asynchronous token before sending', async () => {
    const { client, fetch } = renewing(
      () => json({ ok: true }),
      () => true
    )
    await client.request({ method: 'GET', path: '/x', response: z.unknown() })
    expect(bearer(fetch.mock.calls[0]![1])).toBe('Bearer old-token')
  })

  it('renews once when the session is refused and sends the same request again', async () => {
    let calls = 0
    const { client, fetch, renewals } = renewing(
      (init) =>
        bearer(init) === 'Bearer new-token' ? json({ ok: true }) : (calls++, unauthorized()),
      () => true
    )
    const result = await client.request({
      method: 'POST',
      path: '/conversations',
      body: { a: 1 },
      idempotencyKey: 'idem-key-12345',
      response: z.object({ ok: z.boolean() })
    })
    expect(result).toMatchObject({ ok: true, value: { ok: true } })
    expect(calls).toBe(1)
    expect(renewals()).toBe(1)
    const [first, second] = fetch.mock.calls.map(([, init]) => init)
    expect(bearer(first!)).toBe('Bearer old-token')
    expect(bearer(second!)).toBe('Bearer new-token')
    expect(second!.body).toBe(first!.body)
    expect((second!.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-key-12345')
  })

  it('gives up without a second request when the renewal fails', async () => {
    const { client, fetch, renewals } = renewing(unauthorized, () => false)
    expect(
      await client.request({ method: 'GET', path: '/x', response: z.unknown() })
    ).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
    expect(renewals()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not loop when the renewed token is refused too', async () => {
    const { client, fetch, renewals } = renewing(unauthorized, () => true)
    expect(
      await client.request({ method: 'GET', path: '/x', response: z.unknown() })
    ).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
    expect(renewals()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('leaves everything else alone', async () => {
    // A request that sends no token, a refusal that is not a 401, a cancelled request, no hook.
    const none = renewing(unauthorized, () => true)
    await none.client.request({
      method: 'POST',
      path: '/auth/login',
      auth: 'none',
      response: z.unknown()
    })
    expect(none.renewals()).toBe(0)

    const conflict = renewing(
      () => json({ error: { code: 'INVALID_SESSION' } }, { status: 403 }),
      () => true
    )
    await conflict.client.request({ method: 'GET', path: '/x', response: z.unknown() })
    expect(conflict.renewals()).toBe(0)

    const controller = new AbortController()
    const aborted = renewing(
      () => (controller.abort(), unauthorized()),
      () => true
    )
    await aborted.client.request({
      method: 'GET',
      path: '/x',
      response: z.unknown(),
      signal: controller.signal
    })
    expect(aborted.renewals()).toBe(0)

    const { client, fetch } = setup(unauthorized)
    expect(
      await client.request({ method: 'GET', path: '/x', response: z.unknown() })
    ).toMatchObject({
      ok: false
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('uploading a file', () => {
  const upload = {
    fields: { request_id: 'req_1', input_method: 'voice' },
    file: {
      field: 'audio',
      filename: 'utterance.wav',
      mimeType: 'audio/wav',
      bytes: new Uint8Array([1, 2, 3, 4])
    }
  }

  it('sends the fields and the file as a form, leaving the content type to the form', async () => {
    const { client, fetch } = setup(() => json({ ok: true }, { status: 202 }))
    const result = await client.request({
      method: 'POST',
      path: '/conversations/c1/messages',
      multipart: upload,
      response: z.looseObject({ ok: z.boolean() })
    })
    expect(result.ok).toBe(true)
    const init = fetch.mock.calls[0]![1]
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('request_id')).toBe('req_1')
    expect(form.get('input_method')).toBe('voice')
    const file = form.get('audio') as File
    expect(file.name).toBe('utterance.wav')
    expect(file.type).toBe('audio/wav')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBeUndefined()
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('refuses a request that has both a JSON body and a file, without sending it', async () => {
    const { client, fetch } = setup(() => json({}))
    const result = await client.request({
      method: 'POST',
      path: '/x',
      body: { a: 1 },
      multipart: upload,
      response: z.unknown()
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
      detail: { delivery: 'not_sent' }
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('receiving a file', () => {
  const audio = (bytes: number[], type = 'audio/mpeg') =>
    new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } })

  it('returns the bytes and their media type, asking for that type', async () => {
    const { client, fetch } = setup(() => audio([9, 8, 7]))
    const result = await client.requestBytes({
      method: 'POST',
      path: '/speech/syntheses',
      body: { text: '안녕' },
      accept: 'audio/mpeg'
    })
    expect(result).toEqual({
      ok: true,
      value: { bytes: new Uint8Array([9, 8, 7]), mimeType: 'audio/mpeg' },
      status: 200
    })
    expect((fetch.mock.calls[0]![1].headers as Record<string, string>).Accept).toBe('audio/mpeg')
  })

  it('takes a media type with parameters', async () => {
    const { client } = setup(() => audio([1], 'Audio/MPEG; charset=binary'))
    expect(
      await client.requestBytes({ method: 'GET', path: '/x', accept: 'audio/mpeg' })
    ).toMatchObject({ ok: true, value: { mimeType: 'audio/mpeg' } })
  })

  it('refuses another media type and an empty answer', async () => {
    for (const response of [
      audio([1, 2], 'application/json'),
      audio([1], 'text/html'),
      audio([])
    ]) {
      const { client } = setup(() => response)
      expect(
        await client.requestBytes({ method: 'GET', path: '/x', accept: 'audio/mpeg' })
      ).toMatchObject({ ok: false, error: { code: 'internal' } })
    }
  })

  it('refuses an answer larger than the limit for that request', async () => {
    const { client } = setup(() => audio(new Array(2000).fill(1)))
    expect(
      await client.requestBytes({
        method: 'GET',
        path: '/x',
        accept: 'audio/mpeg',
        maxResponseBytes: 1000
      })
    ).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('allows a larger answer where the request says so', async () => {
    const { client } = setup(() => audio(new Array(2000).fill(1)), { maxResponseBytes: 1000 })
    expect(
      await client.requestBytes({
        method: 'GET',
        path: '/x',
        accept: 'audio/mpeg',
        maxResponseBytes: 5000
      })
    ).toMatchObject({ ok: true })
  })

  it('reads an error as an error, whatever was asked for', async () => {
    const { client } = setup(
      () =>
        new Response(JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: 'x' } }), {
          status: 502,
          headers: { 'content-type': 'application/json' }
        })
    )
    expect(
      await client.requestBytes({ method: 'POST', path: '/x', accept: 'audio/mpeg' })
    ).toMatchObject({ ok: false, error: { code: 'unavailable' }, detail: { status: 502 } })
  })

  it('renews the session once on a refused token, like any other request', async () => {
    let calls = 0
    const fetch = vi.fn<FetchLike>(async () => {
      calls += 1
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: 'INVALID_SESSION', message: 'x' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        : audio([5])
    })
    const renew = vi.fn<() => Promise<boolean>>(async () => true)
    const client = new ServerClient({
      baseUrl: BASE,
      fetch,
      accessToken: () => TOKEN,
      renewAccessToken: renew
    })
    expect(
      await client.requestBytes({ method: 'POST', path: '/x', accept: 'audio/mpeg' })
    ).toMatchObject({ ok: true })
    expect(renew).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
