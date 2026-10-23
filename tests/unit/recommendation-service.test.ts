import { describe, expect, it } from 'vitest'
import type { Result } from '../../src/shared/contracts/common'
import { RECOMMENDATION_RESPONSES } from '../../src/shared/contracts/recommendation'
import type {
  RecommendationAnswer,
  RecommendationCard
} from '../../src/shared/contracts/recommendation'
import type {
  PendingRecommendation,
  RecommendationApiPort,
  RespondOutcome
} from '../../src/main/recommendation/recommendation-api'
import { RecommendationService } from '../../src/main/recommendation/recommendation-service'
import { waitUntil } from '../helpers/wait'

const T0 = Date.parse('2026-10-22T03:00:00.000Z')

function recommendation(overrides: Partial<PendingRecommendation> = {}): PendingRecommendation {
  return {
    recommendationId: '701',
    reason: 'VS Code 다음에 Chrome을 자주 실행했어요.',
    expiresAtServerMs: T0 + 60_000,
    targets: [{ position: 0, appCode: 'chrome', displayName: 'Google Chrome' }],
    ...overrides
  }
}

class FakeApi implements RecommendationApiPort {
  offers: (PendingRecommendation | null)[] = []
  pendingError: { code: 'unavailable' | 'cancelled' } | null = null
  outcomes: (RespondOutcome | 'hold')[] = []
  readonly answers: { id: string; answer: RecommendationAnswer }[] = []
  pendingCalls = 0
  held: ((outcome: RespondOutcome) => void) | null = null
  async pending(): Promise<Result<PendingRecommendation | null>> {
    this.pendingCalls += 1
    if (this.pendingError)
      return { ok: false, error: { code: this.pendingError.code, message: 'x' } }
    return { ok: true, value: this.offers.shift() ?? null }
  }
  async respond(id: string, answer: RecommendationAnswer): Promise<RespondOutcome> {
    this.answers.push({ id, answer })
    const next = this.outcomes.shift() ?? { kind: 'recorded' as const }
    if (next === 'hold')
      return new Promise<RespondOutcome>((resolve) => {
        this.held = resolve
      })
    return next
  }
}

function setup(
  options: {
    canShow?: () => boolean
    offsetMs?: number | null
    alreadyOpen?: (targets: PendingRecommendation['targets']) => Promise<boolean>
  } = {}
) {
  const api = new FakeApi()
  const published: (RecommendationCard | null)[] = []
  const timers: { callback: () => void; ms: number; cancelled: boolean }[] = []
  const sleeps: number[] = []
  const logs: string[] = []
  const ref = { now: T0, show: true }
  const service = new RecommendationService({
    api,
    now: () => ref.now,
    clock: {
      serverTimeAt: (local) => (options.offsetMs === null ? null : local + (options.offsetMs ?? 0))
    },
    sleep: async (ms, signal) => {
      sleeps.push(ms)
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
        setTimeout(resolve, 3)
      })
    },
    schedule: (callback, ms) => {
      const timer = { callback, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    canShow: options.canShow ?? (() => ref.show),
    ...(options.alreadyOpen ? { alreadyOpen: options.alreadyOpen } : {}),
    publish: (card) => published.push(card),
    log: (message) => logs.push(message)
  })
  const live = () => timers.filter((timer) => !timer.cancelled)
  return { api, service, published, timers, live, sleeps, logs, ref }
}

const signal = () => new AbortController().signal
const last = (published: (RecommendationCard | null)[]) => published.at(-1) ?? null

/** A service that is running for a user, so answers can be sent. */
async function running(t: ReturnType<typeof setup>) {
  t.api.offers = [recommendation()]
  t.service.start('u1')
  await waitUntil(() => t.service.current() !== null)
}

describe('offering', () => {
  it("shows what the server offers, with the deadline on this machine's clock", async () => {
    const t = setup()
    t.api.offers = [recommendation()]
    await t.service.poll(signal())
    expect(last(t.published)).toEqual({
      recommendationId: '701',
      reason: 'VS Code 다음에 Chrome을 자주 실행했어요.',
      targets: [{ position: 0, appCode: 'chrome', displayName: 'Google Chrome' }],
      expiresAtUnixMs: T0 + 60_000,
      phase: 'offered'
    })
  })

  it('shows nothing when the server has nothing', async () => {
    const t = setup()
    expect(await t.service.poll(signal())).toBe(false)
    expect(t.published).toEqual([])
  })

  it('does not ask again while a card is on offer', async () => {
    const t = setup()
    t.api.offers = [recommendation()]
    await t.service.poll(signal())
    await t.service.poll(signal())
    await t.service.poll(signal())
    expect(t.api.pendingCalls).toBe(1)
  })

  it('does not ask, or show, while the user is busy, and shows it later', async () => {
    const t = setup()
    t.ref.show = false
    t.api.offers = [recommendation()]
    await t.service.poll(signal())
    expect(t.api.pendingCalls).toBe(0)
    expect(t.published).toEqual([])
    t.ref.show = true
    await t.service.poll(signal())
    expect(last(t.published)).toMatchObject({ recommendationId: '701' })
  })

  it("judges the deadline on the server's clock", async () => {
    // The server is a minute ahead of this machine: 40 s are left on its clock, not 100 s.
    const ahead = setup({ offsetMs: 60_000 })
    ahead.api.offers = [recommendation({ expiresAtServerMs: T0 + 60_000 + 40_000 })]
    await ahead.service.poll(signal())
    expect(last(ahead.published)?.expiresAtUnixMs).toBe(T0 + 40_000)
    expect(ahead.live()[0]?.ms).toBe(40_000)

    // The server is a minute behind: the same deadline is 100 s away.
    const behind = setup({ offsetMs: -60_000 })
    behind.api.offers = [recommendation({ expiresAtServerMs: T0 - 60_000 + 100_000 })]
    await behind.service.poll(signal())
    expect(behind.live()[0]?.ms).toBe(100_000)
  })

  it("falls back to this machine's clock before the server's is known", async () => {
    const t = setup({ offsetMs: null })
    t.api.offers = [recommendation({ expiresAtServerMs: T0 + 25_000 })]
    await t.service.poll(signal())
    expect(t.live()[0]?.ms).toBe(25_000)
  })

  it.each([
    ['one that has already run out', T0 - 1],
    ['one that runs out this very moment', T0]
  ])('does not show %s', async (_name, expiresAtServerMs) => {
    const t = setup()
    t.api.offers = [recommendation({ expiresAtServerMs })]
    await t.service.poll(signal())
    expect(t.published).toEqual([])
    expect(t.timers).toHaveLength(0)
  })

  it("takes the card down when the server's deadline passes", async () => {
    const t = setup()
    t.api.offers = [recommendation()]
    await t.service.poll(signal())
    t.live()[0]!.callback()
    expect(last(t.published)).toBeNull()
    expect(t.service.current()).toBeNull()
  })

  it('does not let an old deadline take down a newer card', async () => {
    const t = setup()
    await running(t)
    const stale = t.live()[0]!
    // The first card is answered, a second one is offered, then the first one's timer fires late.
    await t.service.respond('701', { response: 'dismiss', pauseToday: false })
    t.api.offers = [recommendation({ recommendationId: '702' })]
    t.service.stop()
    t.service.start('u1')
    await waitUntil(() => t.service.current()?.recommendationId === '702')
    stale.callback()
    expect(t.service.current()?.recommendationId).toBe('702')
    await t.service.stop()
  })

  it('keeps going on the next round after a failure, and backs off while it lasts', async () => {
    const t = setup()
    t.api.pendingError = { code: 'unavailable' }
    t.service.start('u1')
    await waitUntil(() => t.sleeps.length >= 6)
    expect(t.sleeps.slice(0, 6)).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000])
    t.api.pendingError = null
    const before = t.sleeps.length
    await waitUntil(() => t.sleeps.length >= before + 2)
    expect(t.sleeps[before + 1]).toBe(30_000)
    await t.service.stop()
  })

  it('does not take a cancelled request for a failure', async () => {
    const t = setup()
    t.api.pendingError = { code: 'cancelled' }
    expect(await t.service.poll(signal())).toBe(false)
  })
})

describe('apps that are already open', () => {
  it('shows nothing when everything suggested is already running, and says why in fixed words', async () => {
    const t = setup({ alreadyOpen: async () => true })
    t.api.offers = [recommendation()]
    await t.service.poll(signal())
    expect(t.published).toEqual([])
    expect(t.logs).toContain('추천할 앱이 이미 실행 중이라 보여 주지 않았어요.')
    expect(t.logs.join('\n')).not.toMatch(/Chrome|VS Code/)
  })

  it('does not answer the server for one it left out, and looks again on the next round', async () => {
    let open = true
    const t = setup({ alreadyOpen: async () => open })
    t.api.offers = [recommendation(), recommendation()]
    await t.service.poll(signal())
    expect(t.api.answers).toEqual([])
    open = false // the user closed the app
    await t.service.poll(signal())
    expect(t.service.current()?.recommendationId).toBe('701')
  })

  it('is given the apps that were suggested', async () => {
    const seen: PendingRecommendation['targets'][] = []
    const t = setup({
      alreadyOpen: async (targets) => {
        seen.push(targets)
        return false
      }
    })
    t.api.offers = [recommendation()]
    await t.service.poll(signal())
    expect(seen).toEqual([[{ position: 0, appCode: 'chrome', displayName: 'Google Chrome' }]])
  })

  it('shows it when the check says no', async () => {
    const t = setup({ alreadyOpen: async () => false })
    t.api.offers = [recommendation()]
    await t.service.poll(signal())
    expect(t.service.current()).not.toBeNull()
  })

  it('does not show it if the user got busy while the check ran', async () => {
    let release: (value: boolean) => void = () => undefined
    const t = setup({ alreadyOpen: () => new Promise<boolean>((resolve) => (release = resolve)) })
    t.api.offers = [recommendation()]
    const polling = t.service.poll(signal())
    await waitUntil(() => t.api.pendingCalls === 1)
    t.ref.show = false
    release(false)
    await polling
    expect(t.service.current()).toBeNull()
  })

  it('does not show it if the service was stopped while the check ran', async () => {
    let release: (value: boolean) => void = () => undefined
    const t = setup({ alreadyOpen: () => new Promise<boolean>((resolve) => (release = resolve)) })
    t.api.offers = [recommendation()]
    const stop = new AbortController()
    const polling = t.service.poll(stop.signal)
    await waitUntil(() => t.api.pendingCalls === 1)
    stop.abort()
    release(false)
    await polling
    expect(t.service.current()).toBeNull()
  })
})

describe('answering', () => {
  it('sends the answer, takes the card down and remembers it', async () => {
    const t = setup()
    await running(t)
    expect(await t.service.respond('701', { response: 'execute', pauseToday: false })).toEqual({
      ok: true,
      value: undefined
    })
    expect(t.api.answers).toEqual([
      { id: '701', answer: { response: 'execute', pauseToday: false } }
    ])
    expect(last(t.published)).toBeNull()
    expect(t.live()).toHaveLength(0)
    // The server offering the same one again is not shown again.
    t.api.offers = [recommendation()]
    await t.service.poll(signal())
    expect(t.service.current()).toBeNull()
    await t.service.stop()
  })

  it.each(RECOMMENDATION_RESPONSES)('sends %s as it is', async (response) => {
    const t = setup()
    await running(t)
    await t.service.respond('701', { response, pauseToday: false })
    expect(t.api.answers[0]?.answer).toEqual({ response, pauseToday: false })
    await t.service.stop()
  })

  it('sends "not today" with the answer, whatever the answer is', async () => {
    const t = setup()
    await running(t)
    await t.service.respond('701', { response: 'reject_once', pauseToday: true })
    expect(t.api.answers).toEqual([
      { id: '701', answer: { response: 'reject_once', pauseToday: true } }
    ])
    await t.service.stop()
  })

  it('shows the card as being answered, and refuses a second answer meanwhile', async () => {
    const t = setup()
    await running(t)
    t.api.outcomes = ['hold']
    const first = t.service.respond('701', { response: 'execute', pauseToday: false })
    await waitUntil(() => t.api.held !== null)
    expect(last(t.published)).toMatchObject({ phase: 'responding' })
    expect(
      await t.service.respond('701', { response: 'reject_once', pauseToday: false })
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    expect(t.api.answers).toHaveLength(1)
    t.api.held!({ kind: 'recorded' })
    expect(await first).toEqual({ ok: true, value: undefined })
    await t.service.stop()
  })

  it('keeps the card, offered again, when the answer did not get through', async () => {
    const t = setup()
    await running(t)
    t.api.outcomes = [
      { kind: 'failed', error: { code: 'unavailable', message: '서버에 연결하지 못했어요.' } }
    ]
    expect(
      await t.service.respond('701', { response: 'execute', pauseToday: false })
    ).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(last(t.published)).toMatchObject({ recommendationId: '701', phase: 'offered' })
    // And it can be answered again.
    expect(await t.service.respond('701', { response: 'execute', pauseToday: false })).toEqual({
      ok: true,
      value: undefined
    })
    expect(t.api.answers).toHaveLength(2)
    await t.service.stop()
  })

  it.each([
    ['already_responded', 'conflict'],
    ['target_unavailable', 'conflict'],
    ['expired', 'expired'],
    ['not_found', 'not_found']
  ] as const)('takes the card down when the server says it is %s', async (reason, code) => {
    const t = setup()
    await running(t)
    t.api.outcomes = [{ kind: 'gone', reason }]
    expect(
      await t.service.respond('701', { response: 'execute', pauseToday: false })
    ).toMatchObject({ ok: false, error: { code } })
    expect(last(t.published)).toBeNull()
    t.api.offers = [recommendation()]
    await t.service.poll(signal())
    expect(t.service.current()).toBeNull()
    await t.service.stop()
  })

  it.each([
    ['target_unavailable', '열 수 있는 앱이 없어서 추천을 닫았어요.'],
    ['already_responded', '이미 처리된 추천이에요.']
  ] as const)('words a 409 that is %s differently from the other', async (reason, message) => {
    const t = setup()
    await running(t)
    t.api.outcomes = [{ kind: 'gone', reason }]
    expect(await t.service.respond('701', { response: 'execute', pauseToday: false })).toEqual({
      ok: false,
      error: { code: 'conflict', message }
    })
    await t.service.stop()
  })

  it('refuses an answer for a recommendation that is not on offer, without asking the server', async () => {
    const t = setup()
    await running(t)
    expect(
      await t.service.respond('999', { response: 'execute', pauseToday: false })
    ).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    expect(t.api.answers).toHaveLength(0)
    expect(t.service.current()).not.toBeNull()
    await t.service.stop()
  })

  it('refuses an answer when nothing is on offer or the service is not running', async () => {
    const t = setup()
    expect(
      await t.service.respond('701', { response: 'execute', pauseToday: false })
    ).toMatchObject({ ok: false })
    expect(t.api.answers).toHaveLength(0)
  })

  it('does not ask the server about a card whose time has run out here', async () => {
    const t = setup()
    await running(t)
    t.ref.now = T0 + 60_000
    expect(
      await t.service.respond('701', { response: 'execute', pauseToday: false })
    ).toMatchObject({
      ok: false,
      error: { code: 'expired' }
    })
    expect(t.api.answers).toHaveLength(0)
    expect(last(t.published)).toBeNull()
    await t.service.stop()
  })
})

describe('signing out', () => {
  it('takes the card down and stops asking', async () => {
    const t = setup()
    await running(t)
    await t.service.stop()
    expect(last(t.published)).toBeNull()
    const calls = t.api.pendingCalls
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.api.pendingCalls).toBe(calls)
    expect(t.live()).toHaveLength(0)
  })

  it('drops an answer that was on its way, and shows nothing afterwards', async () => {
    const t = setup()
    await running(t)
    t.api.outcomes = ['hold']
    const pending = t.service.respond('701', { response: 'execute', pauseToday: false })
    await waitUntil(() => t.api.held !== null)
    await t.service.stop()
    t.api.held!({ kind: 'recorded' })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(last(t.published)).toBeNull()
  })

  it('does not carry the answered list over to the next user', async () => {
    const t = setup()
    await running(t)
    await t.service.respond('701', { response: 'dismiss', pauseToday: false })
    await t.service.stop()
    t.api.offers = [recommendation()]
    t.service.start('u2')
    await waitUntil(() => t.service.current() !== null)
    expect(t.service.current()?.recommendationId).toBe('701')
    await t.service.stop()
  })

  it('does not start a second loop for the same user', async () => {
    // Every loop that is waiting for its next round holds one of these.
    const waiting: (() => void)[] = []
    const api = new FakeApi()
    const service = new RecommendationService({
      api,
      now: () => T0,
      clock: { serverTimeAt: (local) => local },
      sleep: (_ms, stop) =>
        new Promise<void>((resolve) => {
          waiting.push(resolve)
          stop.addEventListener('abort', () => resolve(), { once: true })
        }),
      schedule: () => () => undefined,
      canShow: () => true,
      publish: () => undefined
    })
    service.start('u1')
    service.start('u1')
    service.start('u1')
    await waitUntil(() => waiting.length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(waiting).toHaveLength(1)
    expect(api.pendingCalls).toBe(1)
    await service.stop()
  })

  it('does not cancel an answer on its way when the same user is started again', async () => {
    const t = setup()
    await running(t)
    t.api.outcomes = ['hold']
    const pending = t.service.respond('701', { response: 'execute', pauseToday: false })
    await waitUntil(() => t.api.held !== null)
    t.service.start('u1')
    t.service.start('u1')
    t.api.held!({ kind: 'recorded' })
    expect(await pending).toEqual({ ok: true, value: undefined })
    await t.service.stop()
  })
})
