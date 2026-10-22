import { describe, expect, it, vi } from 'vitest'
import { ServerAssistant } from '../../src/main/conversation/server-assistant'
import { ServerClient } from '../../src/main/connection/server-client'
import type { FetchLike } from '../../src/main/connection/server-client'
import { idempotencyKeyFor, newUlid } from '../../src/main/connection/ids'

const BASE = 'http://127.0.0.1:8000/api/v1'
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
const envelope = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code, message: 'server wording' } }, status, headers)

const status = (state: string, extra: object = {}) =>
  json({
    processing_status: state,
    error_code: null,
    assistant_messages: [],
    commands: [],
    ...extra
  })
const done = (text: string, extra: object = {}) =>
  status('success', { assistant_messages: [{ content: text }], ...extra })

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
  key: string | undefined
}

/** Routes by path; each handler may return a Response or throw to simulate a network failure. */
function setup(
  handlers: {
    create?: (call: Call, n: number) => Response | Promise<Response>
    submit?: (call: Call, n: number) => Response | Promise<Response>
    poll?: (call: Call, n: number) => Response | Promise<Response>
  } = {},
  options: { token?: string | null; maxWaitMs?: number } = {}
) {
  const calls: Call[] = []
  const counts = { create: 0, submit: 0, poll: 0 }
  const delays: number[] = []
  let clock = 0
  let conversations = 0
  let randoms = 0
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const path = new URL(url).pathname.replace('/api/v1', '')
    const call: Call = {
      method: init.method ?? 'GET',
      path,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      key: (init.headers as Record<string, string>)['Idempotency-Key']
    }
    calls.push(call)
    if (path === '/conversations') {
      const n = ++counts.create
      return handlers.create?.(call, n) ?? json({ conversation_id: `conv_${++conversations}` }, 201)
    }
    if (path.endsWith('/messages')) {
      const n = ++counts.submit
      return (
        handlers.submit?.(call, n) ??
        json({ request_id: call.body!.request_id, poll_after_ms: 500 }, 202)
      )
    }
    const n = ++counts.poll
    return handlers.poll?.(call, n) ?? done('hi')
  })
  const client = new ServerClient({
    baseUrl: BASE,
    fetch,
    accessToken: () => (options.token === undefined ? 'tok' : options.token)
  })
  const assistant = new ServerAssistant({
    client,
    now: () => clock,
    wait: async (ms) => {
      delays.push(ms)
      clock += ms
    },
    random: (size) => new Uint8Array(size).fill(++randoms % 256),
    ...(options.maxWaitMs ? { maxWaitMs: options.maxWaitMs } : {})
  })
  const turn = (conversationId = 'local-1', requestId = 'turn-1') => ({ conversationId, requestId })
  return { assistant, calls, counts, delays, turn, fetch }
}

describe('a typed request', () => {
  it('opens a server conversation, submits the text and waits for the answer', async () => {
    const t = setup({
      poll: (_call, n) =>
        n === 1 ? status('queued') : n === 2 ? status('processing') : done('안녕하세요')
    })
    expect(await t.assistant.respond(t.turn(), '안녕')).toEqual({
      ok: true,
      value: { text: '안녕하세요' }
    })
    expect(t.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /conversations',
      'POST /conversations/conv_1/messages',
      'GET /requests/' + String(t.calls[1]!.body!.request_id),
      'GET /requests/' + String(t.calls[1]!.body!.request_id),
      'GET /requests/' + String(t.calls[1]!.body!.request_id)
    ])
    expect(t.calls[0]!.key).toMatch(/^conversation-[0-9a-f]{32}$/)
    expect(t.calls[1]!.body).toEqual({
      request_id: expect.stringMatching(/^req_[0-9A-HJKMNP-TV-Z]{26}$/),
      input_method: 'text',
      content: '안녕'
    })
    // Polling starts at the server's hint and eases from half a second towards one second.
    expect(t.delays).toEqual([500, 600, 700])
  })

  it('opens one server conversation per local conversation and one request per turn', async () => {
    const t = setup()
    await t.assistant.respond(t.turn('local-1', 'a'), 'one')
    await t.assistant.respond(t.turn('local-1', 'b'), 'two')
    await t.assistant.respond(t.turn('local-2', 'c'), 'three')
    expect(t.counts.create).toBe(2)
    const posts = t.calls.filter((call) => call.path.endsWith('/messages'))
    expect(posts.map((call) => call.path)).toEqual([
      '/conversations/conv_1/messages',
      '/conversations/conv_1/messages',
      '/conversations/conv_2/messages'
    ])
    expect(new Set(posts.map((call) => call.body!.request_id)).size).toBe(3)
  })

  it('answers with every non-empty message of the reply', async () => {
    const t = setup({
      poll: () =>
        status('success', {
          assistant_messages: [
            { content: ' 첫째 ' },
            { content: '  ' },
            { content: null },
            { content: '둘째' }
          ]
        })
    })
    expect(await t.assistant.respond(t.turn(), 'x')).toEqual({
      ok: true,
      value: { text: '첫째\n둘째' }
    })
  })

  it("shows only the server's sentence when it planned commands, which the command poller runs", async () => {
    const withText = setup({
      poll: () => done('크롬 실행 명령을 보냈어요.', { commands: [{ command_id: 1 }] })
    })
    expect(await withText.assistant.respond(withText.turn(), 'x')).toEqual({
      ok: true,
      value: {
        text: '크롬 실행 명령을 보냈어요.'
      }
    })
    const bare = setup({ poll: () => status('success', { commands: [{ command_id: 1 }] }) })
    expect(await bare.assistant.respond(bare.turn(), 'x')).toMatchObject({
      ok: true,
      value: { text: '요청을 처리했어요.' }
    })
    const empty = setup({ poll: () => status('success') })
    expect(await empty.assistant.respond(empty.turn(), 'x')).toMatchObject({
      ok: false,
      error: { code: 'internal' }
    })
  })

  it('tells a policy refusal from a processing failure and shows no server wording', async () => {
    const rejected = setup({
      poll: () => status('rejected', { error_code: 'APP_BLOCKED_BY_USER' })
    })
    const refused = await rejected.assistant.respond(rejected.turn(), 'x')
    expect(refused).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    const failed = setup({ poll: () => status('failed', { error_code: 'LLM_TIMEOUT_DETAIL' }) })
    const broke = await failed.assistant.respond(failed.turn(), 'x')
    expect(broke).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(JSON.stringify([refused, broke])).not.toMatch(/APP_BLOCKED|LLM_TIMEOUT/)
  })
})

describe('when a call gets no answer', () => {
  const lost = () => {
    throw new TypeError('net::ERR_CONNECTION_RESET')
  }

  it('repeats a submit whose answer was lost with the same request ID and text', async () => {
    const t = setup({
      submit: (call, n) => (n === 1 ? lost() : json({ request_id: call.body!.request_id }, 202))
    })
    expect(await t.assistant.respond(t.turn(), '같은 문장')).toMatchObject({ ok: true })
    const posts = t.calls.filter((call) => call.path.endsWith('/messages'))
    expect(posts).toHaveLength(2)
    expect(posts[1]!.body).toEqual(posts[0]!.body)
  })

  it('repeats a conversation whose answer was lost with the same key', async () => {
    const t = setup({
      create: (_call, n) => (n === 1 ? lost() : json({ conversation_id: 'conv_x' }, 201))
    })
    expect(await t.assistant.respond(t.turn(), 'x')).toMatchObject({ ok: true })
    const creates = t.calls.filter((call) => call.path === '/conversations')
    expect(creates).toHaveLength(2)
    expect(creates[1]!.key).toBe(creates[0]!.key)
  })

  it('stops repeating after a few lost answers, and does not repeat what never left', async () => {
    const stuck = setup({ submit: lost })
    expect(await stuck.assistant.respond(stuck.turn(), 'x')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(stuck.counts.submit).toBe(3)

    const refused = setup({
      submit: () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      }
    })
    await refused.assistant.respond(refused.turn(), 'x')
    expect(refused.counts.submit).toBe(1)
  })

  it('forgets a conversation that could not be opened, so the next input tries again', async () => {
    const t = setup({
      create: (_call, n) =>
        n <= 1 ? envelope('SERVICE_UNAVAILABLE', 503) : json({ conversation_id: 'conv_late' }, 201)
    })
    expect(await t.assistant.respond(t.turn('local-1', 'a'), 'x')).toMatchObject({ ok: false })
    expect(await t.assistant.respond(t.turn('local-1', 'b'), 'x')).toMatchObject({ ok: true })
  })
})

describe('when the server is busy or has lost the conversation', () => {
  it('waits a moment and submits again while an earlier request of the conversation is running', async () => {
    const t = setup({
      submit: (call, n) =>
        n <= 2
          ? envelope('CONVERSATION_BUSY', 409)
          : json({ request_id: call.body!.request_id }, 202)
    })
    expect(await t.assistant.respond(t.turn(), 'x')).toMatchObject({ ok: true })
    expect(t.counts.submit).toBe(3)
    expect(t.delays.slice(0, 2)).toEqual([1000, 1000])
  })

  it('gives up after a limited number of busy answers', async () => {
    const t = setup({ submit: () => envelope('CONVERSATION_BUSY', 409) })
    expect(await t.assistant.respond(t.turn(), 'x')).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    expect(t.counts.submit).toBe(6)
  })

  it('opens a new conversation once when the server no longer knows the old one', async () => {
    const t = setup({
      submit: (call, n) =>
        n === 1
          ? envelope('RESOURCE_NOT_FOUND', 404)
          : json({ request_id: call.body!.request_id }, 202)
    })
    expect(await t.assistant.respond(t.turn(), 'x')).toMatchObject({ ok: true })
    expect(t.counts.create).toBe(2)
    expect(
      t.calls.filter((call) => call.path.endsWith('/messages')).map((call) => call.path)
    ).toEqual(['/conversations/conv_1/messages', '/conversations/conv_2/messages'])

    const gone = setup({ submit: () => envelope('RESOURCE_NOT_FOUND', 404) })
    expect(await gone.assistant.respond(gone.turn(), 'x')).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    expect(gone.counts.create).toBe(2)
  })
})

describe('waiting for the answer', () => {
  it('bears a few passing errors with growing pauses and then gets the answer', async () => {
    const t = setup({
      poll: (_call, n) => (n <= 3 ? envelope('SERVICE_UNAVAILABLE', 503) : done('ok'))
    })
    expect(await t.assistant.respond(t.turn(), 'x')).toMatchObject({
      ok: true,
      value: { text: 'ok' }
    })
    expect(t.delays).toEqual([500, 1000, 2000, 4000])
  })

  it('gives up when the errors keep coming, and at once for one that will not pass', async () => {
    const down = setup({ poll: () => envelope('SERVICE_UNAVAILABLE', 503) })
    expect(await down.assistant.respond(down.turn(), 'x')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(down.counts.poll).toBe(5)

    const gone = setup({ poll: () => envelope('RESOURCE_NOT_FOUND', 404) })
    expect(await gone.assistant.respond(gone.turn(), 'x')).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    expect(gone.counts.poll).toBe(1)

    const ended = setup({ poll: () => envelope('INVALID_SESSION', 401) })
    expect(await ended.assistant.respond(ended.turn(), 'x')).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
  })

  it('keeps off the server for as long as it asks when the rate limit is hit', async () => {
    const t = setup({
      poll: (_call, n) =>
        n === 1 ? envelope('RATE_LIMITED', 429, { 'retry-after': '8' }) : done('ok')
    })
    expect(await t.assistant.respond(t.turn(), 'x')).toMatchObject({ ok: true })
    expect(t.delays[1]).toBe(8000)
  })

  it('stops after its own longest wait, and treats an unknown state as still working', async () => {
    const t = setup({ poll: () => status('thinking_very_hard') }, { maxWaitMs: 5_000 })
    expect(await t.assistant.respond(t.turn(), 'x')).toMatchObject({
      ok: false,
      error: { code: 'expired' }
    })
  })
})

describe('cancelling', () => {
  it('does nothing for a request that is already cancelled', async () => {
    const t = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await t.assistant.respond(t.turn(), 'x', { signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(t.fetch).not.toHaveBeenCalled()
  })

  it('stops asking as soon as it is cancelled while waiting', async () => {
    const controller = new AbortController()
    const t = setup({
      poll: (_call, n) =>
        n === 2 ? (controller.abort(), status('processing')) : status('processing')
    })
    expect(await t.assistant.respond(t.turn(), 'x', { signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(t.counts.poll).toBe(2)
  })
})

describe('what it will not do', () => {
  it('does not call the server without a signed-in token', async () => {
    const t = setup({}, { token: null })
    expect(await t.assistant.respond(t.turn(), 'x')).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(t.fetch).not.toHaveBeenCalled()
  })

  it('keeps what the user typed and what the server answered out of its errors', async () => {
    const t = setup({ poll: () => status('failed') })
    const failed = await t.assistant.respond(t.turn(), '비밀 문장 가나다')
    const busy = setup({ submit: () => envelope('CONVERSATION_BUSY', 409) })
    const refused = await busy.assistant.respond(busy.turn(), '비밀 문장 가나다')
    expect(JSON.stringify([failed, refused])).not.toContain('비밀 문장')
    expect(JSON.stringify([failed, refused])).not.toContain('server wording')
  })
})

describe('identifiers', () => {
  it('makes ULID-shaped IDs that sort by time and differ by their random part', () => {
    const fixed = (byte: number) => () => new Uint8Array(16).fill(byte)
    const a = newUlid(1_700_000_000_000, fixed(1))
    const b = newUlid(1_700_000_000_001, fixed(1))
    const c = newUlid(1_700_000_000_000, fixed(2))
    for (const id of [a, b, c]) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(a < b).toBe(true)
    expect(a.slice(0, 10)).toBe(c.slice(0, 10))
    expect(a).not.toBe(c)
    expect(newUlid(0, fixed(0))).toBe('0'.repeat(26))
    expect(newUlid(Date.now())).toHaveLength(26)
  })

  it('derives a stable, safe idempotency key from a local ID', () => {
    const key = idempotencyKeyFor('conversation', 'local id with / odd chars ✓')
    expect(key).toMatch(/^conversation-[0-9a-f]{32}$/)
    expect(idempotencyKeyFor('conversation', 'local id with / odd chars ✓')).toBe(key)
    expect(idempotencyKeyFor('conversation', 'another')).not.toBe(key)
  })
})
