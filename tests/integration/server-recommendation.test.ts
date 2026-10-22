import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandApi } from '../../src/main/commands/command-api'
import { CommandJournal } from '../../src/main/commands/command-journal'
import { CommandService } from '../../src/main/commands/command-service'
import type { AppControlPort, FolderOpenPort, SystemAudioPort } from '../../src/main/platform/ports'
import { RecommendationApi } from '../../src/main/recommendation/recommendation-api'
import { RecommendationService } from '../../src/main/recommendation/recommendation-service'
import { CapabilityRegistry, platformCapabilities } from '../../src/main/tools/capability-registry'
import { ToolExecutor } from '../../src/main/tools/tool-executor'
import type { RecommendationCard } from '../../src/shared/contracts/recommendation'
import { stopAllFakeServers } from '../fixtures/fake-auth-server'
import { signedInApp } from '../fixtures/signed-in-app'

afterEach(stopAllFakeServers)

async function waitUntil(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const shortSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.min(ms, 15))
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })

/** Recommendations and the command path, over a real connection to the fake server. */
async function recommendationApp(options: { alreadyOpen?: () => Promise<boolean> } = {}) {
  const app = await signedInApp()
  const cards: (RecommendationCard | null)[] = []
  const service = new RecommendationService({
    api: new RecommendationApi(app.api),
    now: Date.now,
    clock: app.api.clock,
    sleep: shortSleep,
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    },
    canShow: () => true,
    ...(options.alreadyOpen ? { alreadyOpen: options.alreadyOpen } : {}),
    publish: (card) => cards.push(card),
    intervalMs: 20
  })
  const launch = vi.fn<AppControlPort['launch']>(async (appId) => ({
    ok: true,
    value: { kind: 'app', appId, status: 'confirmed' }
  }))
  const appControl = {
    list: vi.fn<AppControlPort['list']>(async () => ({ ok: true, value: [] })),
    launch,
    activate: vi.fn<AppControlPort['activate']>(),
    restore: vi.fn<AppControlPort['restore']>(),
    getForegroundWindow: vi.fn<AppControlPort['getForegroundWindow']>(),
    switchRecentTask: vi.fn<AppControlPort['switchRecentTask']>(),
    openUrl: vi.fn<AppControlPort['openUrl']>()
  } satisfies AppControlPort
  const executor = new ToolExecutor({
    registry: new CapabilityRegistry(platformCapabilities('darwin')),
    appControl,
    folders: { open: vi.fn<FolderOpenPort['open']>() },
    audio: {
      setVolume: vi.fn<SystemAudioPort['setVolume']>(),
      adjustVolume: vi.fn<SystemAudioPort['adjustVolume']>(),
      setMuted: vi.fn<SystemAudioPort['setMuted']>()
    },
    auth: { requireSignedIn: () => ({ ok: true, value: undefined }) },
    clock: { now: () => performance.now() },
    restoreTarget: () => null
  })
  const commands = new CommandService({
    api: new CommandApi(app.api),
    journal: new CommandJournal({
      files: { read: async () => null, replace: async () => undefined },
      now: Date.now
    }),
    executor,
    platform: 'darwin',
    now: Date.now,
    clock: app.api.clock,
    sleep: shortSleep
  })
  const offer = (overrides: Partial<NonNullable<typeof app.fake.recommendation>> = {}) => {
    app.fake.recommendation = {
      recommendation_id: 701,
      reason: 'VS Code 다음에 Chrome을 자주 실행했어요.',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      targets: [
        { position: 0, device_app_id: 44, app_code: 'chrome', display_name: 'Google Chrome' },
        { position: 1, device_app_id: 45, app_code: 'slack', display_name: 'Slack' }
      ],
      ...overrides
    }
  }
  const showing = () => cards.at(-1) ?? null
  return { ...app, service, commands, cards, offer, showing, launch }
}

describe('recommendations from the server', () => {
  it('shows the offer, and approving it opens the apps through the command poller', async () => {
    const t = await recommendationApp()
    t.offer()
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    expect(t.showing()).toMatchObject({
      recommendationId: '701',
      reason: 'VS Code 다음에 Chrome을 자주 실행했어요.',
      phase: 'offered',
      targets: [{ displayName: 'Google Chrome' }, { displayName: 'Slack' }]
    })
    // Nothing runs because a card is shown.
    expect(t.launch).not.toHaveBeenCalled()

    expect(await t.service.respond('701', 'approved')).toEqual({ ok: true, value: undefined })
    expect(t.showing()).toBeNull()
    expect(t.fake.recommendationAnswers.get(701)).toBe('approved')

    // The commands the server created reach this device and run, and their results are reported.
    t.commands.start('uuid-jarvis')
    await waitUntil(() => t.launch.mock.calls.length === 2)
    await waitUntil(() => t.fake.results.size === 2)
    await t.commands.stop()
    await t.service.stop()
    expect(t.launch.mock.calls.map(([appId]) => appId).sort()).toEqual(
      ['com.google.Chrome', 'com.tinyspeck.slackmacgap'].sort()
    )
    for (const result of t.fake.results.values())
      expect(result).toMatchObject({ status: 'success' })
  })

  it('does not show what is already open, and shows it once the app is closed', async () => {
    let open = true
    const t = await recommendationApp({ alreadyOpen: async () => open })
    t.offer()
    t.service.start('uuid-jarvis')
    const pending = () =>
      t.fake.calls.filter((call) => call.path === '/recommendations/pending').length
    await waitUntil(() => pending() >= 3)
    expect(t.cards).toEqual([])
    // Nothing was answered to the server on its behalf.
    expect(t.fake.recommendationAnswers.size).toBe(0)
    open = false
    await waitUntil(() => t.showing() !== null)
    await t.service.stop()
  })

  it('answers later for a recommendation, and runs nothing', async () => {
    const t = await recommendationApp()
    t.offer()
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    expect(await t.service.respond('701', 'snoozed')).toEqual({ ok: true, value: undefined })
    expect(t.fake.recommendationAnswers.get(701)).toBe('snoozed')
    expect(t.fake.commands).toHaveLength(0)
    await t.service.stop()
  })

  it('records a rejection and runs nothing', async () => {
    const t = await recommendationApp()
    t.offer()
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    expect(await t.service.respond('701', 'rejected')).toEqual({ ok: true, value: undefined })
    expect(t.fake.recommendationAnswers.get(701)).toBe('rejected')
    expect(t.fake.commands).toHaveLength(0)
    await t.service.stop()
  })

  it('does not show the same recommendation again after it was answered', async () => {
    const t = await recommendationApp()
    t.offer()
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    await t.service.respond('701', 'dismissed')
    // The fake server stops offering it too, so offer it again as a faulty server might.
    t.fake.recommendationAnswers.delete(701)
    const pending = () =>
      t.fake.calls.filter((call) => call.path === '/recommendations/pending').length
    const before = pending()
    await waitUntil(() => pending() >= before + 3)
    expect(t.showing()).toBeNull()
    await t.service.stop()
  })

  it('reads the deadline whether the server names its zone or leaves it off', async () => {
    for (const naive of [true, false]) {
      const t = await recommendationApp()
      t.fake.naiveTimes = naive
      t.offer()
      t.service.start('uuid-jarvis')
      await waitUntil(() => t.showing() !== null)
      const remaining = (t.showing()?.expiresAtUnixMs ?? 0) - Date.now()
      expect(remaining).toBeGreaterThan(50_000)
      expect(remaining).toBeLessThanOrEqual(61_000)
      await t.service.stop()
      await stopAllFakeServers()
    }
  })

  it('does not show an offer whose time has already passed', async () => {
    const t = await recommendationApp()
    t.offer({ expires_at: new Date(Date.now() - 5000).toISOString() })
    t.service.start('uuid-jarvis')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(t.cards).toEqual([])
    await t.service.stop()
  })

  it("takes the card down at the server's deadline", async () => {
    const t = await recommendationApp()
    t.offer({ expires_at: new Date(Date.now() + 1500).toISOString() })
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    await waitUntil(() => t.showing() === null, 4000)
    expect(t.fake.recommendationAnswers.size).toBe(0)
    await t.service.stop()
  })

  it('closes the card when the server says it was already answered elsewhere', async () => {
    const t = await recommendationApp()
    t.offer()
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    t.fake.recommendationAnswers.set(701, 'approved')
    expect(await t.service.respond('701', 'rejected')).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    expect(t.showing()).toBeNull()
    expect(t.fake.commands).toHaveLength(0)
    await t.service.stop()
  })

  it('keeps the card through a server error and answers again', async () => {
    const t = await recommendationApp()
    t.offer()
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    t.fake.recommendationFaults = [503]
    expect(await t.service.respond('701', 'approved')).toMatchObject({ ok: false })
    expect(t.showing()).toMatchObject({ recommendationId: '701', phase: 'offered' })
    expect(await t.service.respond('701', 'approved')).toEqual({ ok: true, value: undefined })
    expect(t.fake.commands).toHaveLength(2)
    await t.service.stop()
  })

  it('answers once even when the user presses twice', async () => {
    const t = await recommendationApp()
    t.offer()
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    const results = await Promise.all([
      t.service.respond('701', 'approved'),
      t.service.respond('701', 'approved')
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(t.fake.commands).toHaveLength(2) // one approval, two apps
    await t.service.stop()
  })

  it('takes the card down on signing out and shows nothing more', async () => {
    const t = await recommendationApp()
    t.offer()
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    await t.service.stop()
    expect(t.showing()).toBeNull()
    const before = t.fake.calls.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(t.fake.calls.length).toBe(before)
  })

  it('keeps asking through a revoked access token by renewing the session', async () => {
    const t = await recommendationApp()
    t.offer()
    t.fake.revokedAccess.add(t.tokens.get() ?? '')
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.showing() !== null)
    expect(t.fake.count('/auth/refresh')).toBeGreaterThanOrEqual(1)
    await t.service.stop()
  })
})
