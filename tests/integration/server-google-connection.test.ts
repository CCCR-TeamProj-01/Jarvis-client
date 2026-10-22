import { afterEach, describe, expect, it } from 'vitest'
import { runWhileSignedIn } from '../../src/main/auth/run-while-signed-in'
import { CalendarApi } from '../../src/main/calendar/calendar-api'
import { CalendarService } from '../../src/main/calendar/calendar-service'
import { GoogleConnectionApi } from '../../src/main/google-connection/google-connection-api'
import { GoogleConnectionService } from '../../src/main/google-connection/google-connection-service'
import { sleep } from '../../src/main/sleep'
import { FakeCalendarStore } from '../fixtures/fake-calendar-store'
import { FakeGoogleConnections } from '../fixtures/fake-google-connections'
import { stopAllFakeServers } from '../fixtures/fake-jarvis-server'
import { signedInApp } from '../fixtures/signed-in-app'
import { waitUntil } from '../helpers/wait'

const FRESH = { pollMs: 15, syncWaitMs: 400 }
const NOW = () => Date.now()

const created: { stop(): void }[] = []
afterEach(async () => {
  for (const item of created.splice(0)) item.stop()
  await stopAllFakeServers()
})

/** The real client stack over HTTP, wired as the app wires it: an import finishing refreshes the calendar. */
async function googleApp(options: { naiveTimes?: boolean } = {}) {
  const app = await signedInApp()
  app.fake.naiveTimes = options.naiveTimes ?? true
  const store = new FakeCalendarStore()
  app.fake.calendarStore = store
  const google = new FakeGoogleConnections(store)
  app.fake.google = google
  created.push(google)
  const calendar = new CalendarService({ api: new CalendarApi(app.api), now: NOW })
  const opened: string[] = []
  const service = new GoogleConnectionService({
    api: new GoogleConnectionApi(app.api),
    now: NOW,
    clock: app.api.clock,
    sleep,
    openConsent: async (url) => (opened.push(url), true),
    onCalendarChanged: () => void calendar.refreshIfShown(),
    ...FRESH
  })
  const stopCalendar = runWhileSignedIn(app.manager, calendar)
  const stopGoogle = runWhileSignedIn(app.manager, service)
  created.push({ stop: () => (stopGoogle(), stopCalendar()) })
  await calendar.navigate('today')
  app.fake.calls.length = 0
  const run = async (action: Parameters<typeof service.command>[0]) => {
    const result = await service.command(action)
    if (!result.ok) throw new Error(result.error.code)
    return result.value
  }
  const googleTitles = () =>
    calendar
      .getSnapshot()
      .days.flatMap((day) => day.events)
      .filter((event) => event.source === 'google')
      .map((event) => event.title)
  const requests = (prefix: string) =>
    app.fake.calls.filter((call) => call.path.startsWith(prefix)).length
  return { ...app, store, google, calendar, service, opened, run, googleTitles, requests }
}

describe('connecting Google over HTTP', () => {
  it('opens the consent page, notices the consent, imports, and the Google events appear in the calendar', async () => {
    const t = await googleApp()
    await t.run('refresh')
    expect(t.service.getSnapshot()).toMatchObject({ read: 'ready', connection: null })
    await t.run('connect')
    expect(t.opened).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?state=fake-state'])
    expect(t.service.getSnapshot().activity).toBe('authorizing')
    // The user agrees in the browser; Google calls the server back. The app is not told.
    t.google.completeConsent()
    await waitUntil(() => t.service.getSnapshot().outcome?.kind === 'synced')
    expect(t.service.getSnapshot()).toMatchObject({
      activity: 'none',
      connection: { status: 'active' }
    })
    expect(t.service.getSnapshot().connection?.lastSyncedAt).not.toBeNull()
    expect(t.google.syncs).toHaveLength(1)
    // And the calendar was read again by itself.
    await waitUntil(() => t.googleTitles().length === 1)
    expect(t.googleTitles()).toEqual(['구글 일정'])
  })

  it('works the same when the server sends times with a zone', async () => {
    const t = await googleApp({ naiveTimes: false })
    await t.run('connect')
    t.google.completeConsent()
    await waitUntil(() => t.service.getSnapshot().outcome?.kind === 'synced')
    expect(t.service.getSnapshot().connection?.lastSyncedAt).not.toBeNull()
  })

  it('gives up when the consent is not finished before the address expires', async () => {
    const t = await googleApp()
    t.google.consentLifetimeMs = 250
    await t.run('connect')
    await waitUntil(() => t.service.getSnapshot().activity === 'none')
    expect(t.service.getSnapshot()).toMatchObject({
      outcome: { kind: 'connect_expired' },
      connection: null
    })
    const reads = t.requests('/calendar/connections')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(t.requests('/calendar/connections')).toBe(reads)
  })

  it('stops waiting when cancelled, and shows the connection on the next read if it was made anyway', async () => {
    const t = await googleApp()
    await t.run('connect')
    await t.run('cancel_connect')
    t.google.completeConsent()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(t.service.getSnapshot()).toMatchObject({
      connection: null,
      outcome: { kind: 'connect_cancelled' }
    })
    expect(t.google.syncs).toHaveLength(0)
    await t.run('refresh')
    expect(t.service.getSnapshot().connection).toMatchObject({ status: 'active' })
  })

  it('bears a failing server while waiting', async () => {
    const t = await googleApp()
    await t.run('connect')
    t.google.readFaults.push(503, 503, 503)
    t.google.completeConsent()
    await waitUntil(() => t.service.getSnapshot().outcome?.kind === 'synced')
    expect(t.service.getSnapshot()).toMatchObject({ connection: { status: 'active' }, error: null })
  })

  it('connects again over an expired connection, by a newer one only', async () => {
    const t = await googleApp()
    t.google.completeConsent(Date.now() - 3_600_000)
    t.google.expireCredentials()
    await t.run('refresh')
    expect(t.service.getSnapshot().connection).toMatchObject({ status: 'reconnect_required' })
    await t.run('connect')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(t.service.getSnapshot().activity).toBe('authorizing')
    t.google.completeConsent()
    await waitUntil(() => t.service.getSnapshot().outcome?.kind === 'synced')
    expect(t.service.getSnapshot().connection).toMatchObject({ status: 'active' })
  })

  it('renews an expired session and goes on', async () => {
    const t = await googleApp()
    t.fake.revokedAccess.add(t.tokens.get() ?? '')
    await t.run('refresh')
    expect(t.service.getSnapshot()).toMatchObject({ read: 'ready', error: null })
    expect(t.fake.count('/auth/refresh')).toBeGreaterThanOrEqual(1)
  })
})

describe('importing over HTTP', () => {
  it('imports when asked, and refreshes the calendar when the server’s time moves', async () => {
    const t = await googleApp()
    t.google.completeConsent()
    t.google.row!.last_synced_at = Date.now() - 5 * 60_000
    await t.run('refresh')
    expect(t.google.syncs).toHaveLength(0)
    await t.run('sync')
    await waitUntil(() => t.service.getSnapshot().outcome?.kind === 'synced')
    expect(t.google.syncs).toHaveLength(1)
    await waitUntil(() => t.googleTitles().length === 1)
  })

  it('imports by itself when the tab is opened and the last import is old', async () => {
    const t = await googleApp()
    t.google.completeConsent()
    t.google.row!.last_synced_at = Date.now() - 40 * 60_000
    await t.run('refresh')
    await waitUntil(() => t.service.getSnapshot().outcome?.kind === 'synced')
    expect(t.google.syncs).toHaveLength(1)
    // Opening it again at once does not import again.
    await t.run('refresh')
    expect(t.google.syncs).toHaveLength(1)
  })

  it('does not call an import done when the server never says so', async () => {
    const t = await googleApp()
    t.google.syncMode = 'silent'
    t.google.completeConsent()
    t.google.row!.last_synced_at = Date.now() - 5 * 60_000
    await t.run('refresh')
    await t.run('sync')
    await waitUntil(() => t.service.getSnapshot().activity === 'none')
    expect(t.service.getSnapshot()).toMatchObject({ outcome: { kind: 'sync_unconfirmed' } })
    expect(t.googleTitles()).toEqual([])
  })

  it('waits for a slow import', async () => {
    const t = await googleApp()
    t.google.syncMode = 'slow'
    t.google.syncDelayMs = 150
    t.google.completeConsent()
    t.google.row!.last_synced_at = Date.now() - 5 * 60_000
    await t.run('refresh')
    await t.run('sync')
    expect(t.service.getSnapshot().activity).toBe('syncing')
    await waitUntil(() => t.service.getSnapshot().outcome?.kind === 'synced')
  })

  it('learns the connection has to be made again', async () => {
    const t = await googleApp()
    t.google.completeConsent()
    t.google.row!.last_synced_at = Date.now() - 5 * 60_000
    await t.run('refresh')
    t.google.expireCredentials()
    // The window still thinks it is active; the fresh read before importing finds out.
    const state = await t.run('sync')
    expect(state).toMatchObject({ activity: 'none', connection: { status: 'reconnect_required' } })
    expect(t.google.syncs).toHaveLength(0)
  })

  it('stops asking when the user signs out in the middle of an import', async () => {
    const t = await googleApp()
    t.google.syncMode = 'silent'
    t.google.completeConsent()
    t.google.row!.last_synced_at = Date.now() - 5 * 60_000
    await t.run('refresh')
    await t.run('sync')
    await t.service.stop()
    const reads = t.requests('/calendar/connections')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(t.requests('/calendar/connections')).toBe(reads)
    expect(t.service.getSnapshot()).toMatchObject({ read: 'idle', connection: null })
  })
})

describe('disconnecting over HTTP', () => {
  it('removes the connection and the Google events, and keeps the user’s own', async () => {
    const t = await googleApp()
    t.store.add({
      title: '내 일정',
      start_at: Date.parse('2026-10-22T05:00:00Z'),
      end_at: Date.parse('2026-10-22T06:00:00Z')
    })
    t.google.completeConsent()
    t.google.row!.last_synced_at = Date.now() - 5 * 60_000
    await t.run('refresh')
    await t.run('sync')
    await waitUntil(() => t.googleTitles().length === 1)
    await t.run('disconnect')
    expect(t.service.getSnapshot()).toMatchObject({
      connection: null,
      outcome: { kind: 'disconnected' }
    })
    await waitUntil(() => t.googleTitles().length === 0)
    const titles = t.calendar
      .getSnapshot()
      .days.flatMap((day) => day.events.map((event) => event.title))
    expect(titles).toEqual(['내 일정'])
    expect(t.google.disconnects).toHaveLength(1)
  })

  it('may be repeated after it failed, and ends the same', async () => {
    const t = await googleApp()
    t.google.completeConsent()
    t.google.row!.last_synced_at = Date.now() - 5 * 60_000
    await t.run('refresh')
    await t.run('disconnect')
    expect(t.service.getSnapshot().connection).toBeNull()
    // The window still holds an old copy of the state, and asks again.
    t.google.row!.status = 'disconnected'
    expect(await t.run('refresh')).toMatchObject({ connection: null, read: 'ready' })
  })
})
