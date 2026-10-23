import { describe, expect, it, vi } from 'vitest'
import { ServerClient } from '../../src/main/connection/server-client'
import type { FetchLike } from '../../src/main/connection/server-client'
import { RecommendationApi } from '../../src/main/recommendation/recommendation-api'
import { RECOMMENDATION_RESPONSES } from '../../src/shared/contracts/recommendation'

const BASE = 'http://127.0.0.1:8001/api/v1'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const envelope = (status: number, code: string) =>
  json({ error: { code, message: 'server wording' } }, status)

const offer = (overrides: Record<string, unknown> = {}) => ({
  recommendation_id: 701,
  recommendation_type: 'associated_app',
  reason_code: 'assoc_10min',
  reason: 'VS Code 다음에 Chrome을 자주 실행했어요.',
  algorithm_version: 'rule-v1',
  expires_at: '2026-10-21T05:11:00Z',
  targets: [{ position: 0, device_app_id: 44, app_code: 'chrome', display_name: 'Google Chrome' }],
  ...overrides
})

function api(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn<FetchLike>(async (url, init) => respond(url, init))
  const client = new ServerClient({ baseUrl: BASE, fetch, accessToken: () => 'tok' })
  return { api: new RecommendationApi(client), fetch }
}

describe('asking for a recommendation', () => {
  it('reads the offer the spec describes', async () => {
    const t = api(() => json(offer()))
    expect(await t.api.pending()).toEqual({
      ok: true,
      value: {
        recommendationId: '701',
        reason: 'VS Code 다음에 Chrome을 자주 실행했어요.',
        expiresAtServerMs: Date.parse('2026-10-21T05:11:00Z'),
        targets: [{ position: 0, appCode: 'chrome', displayName: 'Google Chrome' }]
      }
    })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/recommendations/pending`)
    expect(init.method).toBe('GET')
  })

  it('reads "no recommendation" (204, no body) as nothing', async () => {
    const t = api(() => new Response(null, { status: 204 }))
    expect(await t.api.pending()).toEqual({ ok: true, value: null })
  })

  it('reads a deadline sent without its zone as UTC, as the real server sends times', async () => {
    const t = api(() => json(offer({ expires_at: '2026-10-21T05:11:00.123456' })))
    const result = await t.api.pending()
    expect(result.ok && result.value?.expiresAtServerMs).toBe(
      Date.parse('2026-10-21T05:11:00.123Z')
    )
  })

  it('puts the apps in the order the server numbers them, and takes a missing app code as none', async () => {
    const t = api(() =>
      json(
        offer({
          targets: [
            { position: 2, device_app_id: 3, display_name: 'C' },
            { position: 0, device_app_id: 1, app_code: 'chrome', display_name: 'A' },
            { position: 1, device_app_id: 2, app_code: null, display_name: 'B' }
          ]
        })
      )
    )
    const result = await t.api.pending()
    expect(
      result.ok && result.value?.targets.map((target) => [target.displayName, target.appCode])
    ).toEqual([
      ['A', 'chrome'],
      ['B', null],
      ['C', null]
    ])
  })

  it('ignores fields it does not know, and trims the text it shows', async () => {
    const t = api(() => json(offer({ future: true, reason: '  좋은 추천이에요  ' })))
    expect(await t.api.pending()).toMatchObject({ ok: true, value: { reason: '좋은 추천이에요' } })
  })

  it.each([
    ['no ID', { recommendation_id: undefined }],
    ['a string ID', { recommendation_id: '701' }],
    ['an unsafe ID', { recommendation_id: 2 ** 53 }],
    ['an empty reason', { reason: '   ' }],
    ['a reason that is too long', { reason: 'a'.repeat(201) }],
    ['no deadline', { expires_at: undefined }],
    ['a deadline that is not a time', { expires_at: 'soon' }],
    ['no apps', { targets: [] }],
    [
      'too many apps',
      {
        targets: Array.from({ length: 11 }, (_, index) => ({
          position: index,
          device_app_id: index,
          display_name: `A${index}`
        }))
      }
    ],
    ['an app without a name', { targets: [{ position: 0, device_app_id: 1, display_name: ' ' }] }],
    [
      'an app name that is too long',
      { targets: [{ position: 0, device_app_id: 1, display_name: 'a'.repeat(101) }] }
    ],
    ['a negative position', { targets: [{ position: -1, device_app_id: 1, display_name: 'A' }] }]
  ])(
    'refuses an offer with %s, without repeating what the server said',
    async (_name, overrides) => {
      const t = api(() => json(offer(overrides)))
      const result = await t.api.pending()
      expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
      expect(JSON.stringify(result)).not.toMatch(/Chrome|VS Code/)
    }
  )

  it('reports a server error as one, and a refused session as such', async () => {
    expect(await api(() => envelope(503, 'SERVICE_UNAVAILABLE')).api.pending()).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(await api(() => envelope(401, 'INVALID_SESSION')).api.pending()).toMatchObject({
      ok: false,
      error: { code: 'session_expired' }
    })
  })

  it('hands the cancel signal on', async () => {
    const t = api(() => json(offer()))
    const abort = new AbortController()
    abort.abort()
    expect(await t.api.pending(abort.signal)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
  })
})

describe('answering a recommendation', () => {
  it.each(RECOMMENDATION_RESPONSES)('sends %s and reports it recorded', async (response) => {
    const t = api(() => json({ recommendation_id: 701, response_status: response, commands: [] }))
    expect(await t.api.respond('701', { response, pauseToday: false })).toEqual({
      kind: 'recorded'
    })
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(`${BASE}/recommendations/701/responses`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ response, pause_today: false })
  })

  it('sends "not today" as pause_today, and only the fields the server accepts', async () => {
    const t = api(() => json({ recommendation_id: 701, response_status: 'rejected', commands: [] }))
    await t.api.respond('701', { response: 'reject_for_7_days', pauseToday: true })
    expect(JSON.parse(String(t.fetch.mock.calls[0]![1].body))).toEqual({
      response: 'reject_for_7_days',
      pause_today: true
    })
  })

  it('tells "nothing it can open" apart from "already answered", though both are a 409', async () => {
    const unavailable = api(() => envelope(409, 'RECOMMENDATION_TARGET_UNAVAILABLE'))
    expect(
      await unavailable.api.respond('701', { response: 'execute', pauseToday: false })
    ).toEqual({ kind: 'gone', reason: 'target_unavailable' })
    const answered = api(() => envelope(409, 'RECOMMENDATION_ALREADY_RESPONDED'))
    expect(await answered.api.respond('701', { response: 'execute', pauseToday: false })).toEqual({
      kind: 'gone',
      reason: 'already_responded'
    })
  })

  it.each([
    [409, 'RECOMMENDATION_ALREADY_RESPONDED', 'already_responded'],
    [410, 'RECOMMENDATION_EXPIRED', 'expired'],
    [404, 'RESOURCE_NOT_FOUND', 'not_found']
  ] as const)('reports %i as gone (%s)', async (status, code, reason) => {
    const t = api(() => envelope(status, code))
    expect(await t.api.respond('701', { response: 'execute', pauseToday: false })).toEqual({
      kind: 'gone',
      reason
    })
  })

  it.each([
    ['a server error', () => envelope(500, 'INTERNAL_ERROR')],
    ['a rate limit', () => envelope(429, 'RATE_LIMITED')],
    ['a validation error', () => envelope(422, 'VALIDATION_ERROR')],
    [
      'a lost connection',
      () => {
        throw new TypeError('socket hang up')
      }
    ]
  ])('keeps the card for later after %s', async (_name, respond) => {
    const t = api(respond)
    expect(await t.api.respond('701', { response: 'execute', pauseToday: false })).toMatchObject({
      kind: 'failed',
      error: { code: expect.any(String) }
    })
  })

  it('does not send for an ID that is not a number', async () => {
    const t = api(() => json({}))
    expect(await t.api.respond('701/../x', { response: 'execute', pauseToday: false })).toEqual({
      kind: 'gone',
      reason: 'not_found'
    })
    expect(await t.api.respond('', { response: 'execute', pauseToday: false })).toEqual({
      kind: 'gone',
      reason: 'not_found'
    })
    expect(t.fetch).not.toHaveBeenCalled()
  })

  it('does not take a conflict of a lost connection for the server having refused', async () => {
    const t = api(() => {
      throw new TypeError('reset')
    })
    const result = await t.api.respond('701', { response: 'execute', pauseToday: false })
    expect(result.kind).toBe('failed')
  })
})
