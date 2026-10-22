import { describe, expect, it, vi } from 'vitest'
import type { CalendarAnswer, CalendarApiPort } from '../../src/main/calendar/calendar-api'
import { CalendarService, UnavailableCalendar } from '../../src/main/calendar/calendar-service'
import { CalendarSnapshotSchema } from '../../src/shared/contracts/calendar'
import type { CalendarEvent } from '../../src/shared/contracts/calendar'
import type { Result } from '../../src/shared/contracts/common'

const NOW = Date.parse('2026-10-22T03:22:14Z') // 12:22 on the 22nd in Seoul

const failure = (message = '서버에 연결하지 못했어요.') =>
  ({ ok: false, error: { code: 'unavailable', message } }) as const
const answer = (events: CalendarAnswer['events'] = [], todos: CalendarAnswer['todos'] = []) =>
  ({ ok: true, value: { events, todos } }) as const
const meeting: CalendarAnswer['events'][number] = {
  id: '1',
  title: '회의',
  source: 'jarvis',
  cancelled: false,
  allDay: false,
  startMs: Date.parse('2026-10-22T05:00:00Z'),
  endMs: Date.parse('2026-10-22T06:00:00Z')
}

/** A calendar API whose answers the test hands out, one at a time or all at once. */
function fakeApi() {
  type Window = { fromMs: number; toMs: number }
  const zones: (() => Promise<Result<string>>)[] = []
  const reads: ((window: Window, signal?: AbortSignal) => Promise<Result<CalendarAnswer>>)[] = []
  const asked: Window[] = []
  const signals: (AbortSignal | undefined)[] = []
  let zoneCalls = 0
  const api: CalendarApiPort = {
    async timeZone(signal) {
      signals.push(signal)
      zoneCalls += 1
      return (zones.shift() ?? (async () => ({ ok: true, value: 'Asia/Seoul' }) as const))()
    },
    async events(window, signal) {
      asked.push(window)
      signals.push(signal)
      return (reads.shift() ?? (async () => answer()))(window, signal)
    }
  }
  return { api, zones, reads, asked, signals, zoneCalls: () => zoneCalls }
}

function setup(now: () => number = () => NOW) {
  const fake = fakeApi()
  const service = new CalendarService({ api: fake.api, now })
  const events: CalendarEvent[] = []
  service.subscribe((event) => events.push(event))
  return { ...fake, service, events }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('before anyone is signed in', () => {
  it('has asked for nothing, and will not ask', async () => {
    const t = setup()
    expect(t.service.getSnapshot()).toMatchObject({
      status: 'idle',
      view: null,
      days: [],
      error: null
    })
    expect(await t.service.navigate('refresh')).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(t.asked).toHaveLength(0)
    expect(t.zoneCalls()).toBe(0)
  })
})

describe('reading the calendar', () => {
  it('opens on today, in the user time zone, and shows what the server answered', async () => {
    const t = setup()
    t.reads.push(async () => answer([meeting]))
    t.service.start('u1')
    const result = await t.service.navigate('refresh')
    expect(result.ok).toBe(true)
    const snapshot = t.service.getSnapshot()
    expect(snapshot).toMatchObject({
      status: 'ready',
      timeZone: 'Asia/Seoul',
      view: { span: 'day', startDate: '2026-10-22', endDate: '2026-10-22' },
      loadedAt: NOW,
      lastSuccessAt: NOW,
      error: null
    })
    expect(snapshot.days).toHaveLength(1)
    expect(snapshot.days[0]).toMatchObject({
      date: '2026-10-22',
      isToday: true,
      events: [{ title: '회의', startTime: '14:00', endTime: '15:00' }]
    })
    expect(CalendarSnapshotSchema.safeParse(snapshot).success).toBe(true)
  })

  it('asks the server for the period in the user zone, widened for all-day dates', async () => {
    const t = setup()
    t.service.start('u1')
    await t.service.navigate('refresh')
    expect(t.asked).toEqual([
      { fromMs: Date.parse('2026-10-21T15:00:00Z'), toMs: Date.parse('2026-10-23T00:00:00Z') }
    ])
  })

  it('works out today in the zone the server names, not this machine zone', async () => {
    // 03:22Z on the 22nd is still the 21st in Los Angeles.
    const t = setup()
    t.zones.push(async () => ({ ok: true, value: 'America/Los_Angeles' }))
    t.service.start('u1')
    await t.service.navigate('today')
    expect(t.service.getSnapshot().view?.startDate).toBe('2026-10-21')
    expect(t.service.getSnapshot().timeZone).toBe('America/Los_Angeles')
  })

  it('goes to today, tomorrow, this week and back and forth from where it is', async () => {
    const t = setup()
    t.service.start('u1')
    const go = async (navigation: Parameters<typeof t.service.navigate>[0]) => {
      await t.service.navigate(navigation)
      const view = t.service.getSnapshot().view!
      return [view.span, view.startDate, view.endDate]
    }
    expect(await go('tomorrow')).toEqual(['day', '2026-10-23', '2026-10-23'])
    expect(await go('next')).toEqual(['day', '2026-10-24', '2026-10-24'])
    expect(await go('previous')).toEqual(['day', '2026-10-23', '2026-10-23'])
    expect(await go('this_week')).toEqual(['week', '2026-10-19', '2026-10-25'])
    expect(await go('next')).toEqual(['week', '2026-10-26', '2026-11-01'])
    expect(await go('previous')).toEqual(['week', '2026-10-19', '2026-10-25'])
    expect(await go('previous')).toEqual(['week', '2026-10-12', '2026-10-18'])
    expect(await go('today')).toEqual(['day', '2026-10-22', '2026-10-22'])
  })

  it('stays where it is on a refresh, and reads again', async () => {
    const t = setup()
    t.service.start('u1')
    await t.service.navigate('next')
    const before = t.asked.length
    await t.service.navigate('refresh')
    expect(t.service.getSnapshot().view?.startDate).toBe('2026-10-22')
    expect(t.asked.length).toBe(before + 1)
  })

  it('shows the user time zone again on every read, so a change of zone is picked up', async () => {
    const t = setup()
    t.service.start('u1')
    await t.service.navigate('today')
    t.zones.push(async () => ({ ok: true, value: 'UTC' }))
    await t.service.navigate('refresh')
    expect(t.service.getSnapshot().timeZone).toBe('UTC')
  })

  it('says it is loading while it waits, then ready', async () => {
    const t = setup()
    const gate = deferred<Result<CalendarAnswer>>()
    t.reads.push(() => gate.promise)
    t.service.start('u1')
    const pending = t.service.navigate('refresh')
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    expect(t.service.getSnapshot()).toMatchObject({ status: 'loading', loadedAt: null, days: [] })
    gate.resolve(answer())
    await pending
    expect(t.service.getSnapshot().status).toBe('ready')
  })

  it('numbers every change so the window can tell a late one from the latest', async () => {
    const t = setup()
    t.service.start('u1')
    await t.service.navigate('refresh')
    const revisions = t.events.map((event) => event.snapshot.revision)
    expect(revisions.length).toBeGreaterThanOrEqual(3)
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions)
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(t.service.getSnapshot().revision).toBe(revisions.at(-1))
  })

  it('has every snapshot it publishes pass the contract', async () => {
    const t = setup()
    t.reads.push(async () => failure())
    t.service.start('u1')
    await t.service.navigate('refresh')
    await t.service.navigate('next')
    await t.service.stop()
    expect(t.events.length).toBeGreaterThan(4)
    for (const event of t.events)
      expect(CalendarSnapshotSchema.safeParse(event.snapshot).success).toBe(true)
  })
})

describe('when reading fails', () => {
  it('says so, and does not show an empty calendar', async () => {
    const t = setup()
    t.reads.push(async () => failure('서버에 연결하지 못했어요.'))
    t.service.start('u1')
    await t.service.navigate('refresh')
    expect(t.service.getSnapshot()).toMatchObject({
      status: 'failed',
      days: [],
      loadedAt: null,
      lastSuccessAt: null,
      error: { code: 'unavailable', message: '서버에 연결하지 못했어요.' }
    })
  })

  it('does not guess a time zone: it fails, and asks for no events', async () => {
    const t = setup()
    t.zones.push(async () => failure('서버에 연결하지 못했어요.'))
    t.service.start('u1')
    await t.service.navigate('refresh')
    expect(t.asked).toHaveLength(0)
    expect(t.service.getSnapshot()).toMatchObject({
      status: 'failed',
      view: null,
      days: [],
      timeZone: null,
      error: { code: 'unavailable' }
    })
    expect(t.service.getSnapshot().error?.message).toContain('시간대를 확인하지 못했어요.')
  })

  it.each(['UTC+9', 'Mars/Base', '', ' '])(
    'fails on a time zone this machine cannot use (%j)',
    async (zone) => {
      const t = setup()
      t.zones.push(async () => ({ ok: true, value: zone }))
      t.service.start('u1')
      await t.service.navigate('refresh')
      expect(t.asked).toHaveLength(0)
      expect(t.service.getSnapshot()).toMatchObject({ status: 'failed', days: [] })
      expect(t.service.getSnapshot().error?.message).toContain('시간대')
    }
  )

  it('keeps the last good answer for the same days, marked with when it was read', async () => {
    let now = NOW
    const t = setup(() => now)
    t.reads.push(async () => answer([meeting]))
    t.service.start('u1')
    await t.service.navigate('refresh')
    now = NOW + 120_000
    t.reads.push(async () => failure())
    await t.service.navigate('refresh')
    const snapshot = t.service.getSnapshot()
    expect(snapshot.status).toBe('failed')
    expect(snapshot.days[0]!.events).toHaveLength(1)
    expect(snapshot.loadedAt).toBe(NOW)
    expect(snapshot.lastSuccessAt).toBe(NOW)
  })

  it('shows no days of another view that failed, but still says when it last succeeded', async () => {
    let now = NOW
    const t = setup(() => now)
    t.reads.push(async () => answer([meeting]))
    t.service.start('u1')
    await t.service.navigate('refresh')
    now = NOW + 60_000
    t.reads.push(async () => failure())
    await t.service.navigate('next')
    const snapshot = t.service.getSnapshot()
    expect(snapshot).toMatchObject({
      status: 'failed',
      view: { startDate: '2026-10-23' },
      days: [],
      loadedAt: null,
      lastSuccessAt: NOW
    })
    expect(snapshot.days.every((day) => day.events.length === 0)).toBe(true)
  })

  it('recovers on the next read and clears the error', async () => {
    const t = setup()
    t.reads.push(async () => failure())
    t.service.start('u1')
    await t.service.navigate('refresh')
    await t.service.navigate('refresh')
    expect(t.service.getSnapshot()).toMatchObject({ status: 'ready', error: null })
  })

  it('clears the old error as soon as it tries again', async () => {
    const t = setup()
    t.reads.push(async () => failure())
    t.service.start('u1')
    await t.service.navigate('refresh')
    const gate = deferred<Result<CalendarAnswer>>()
    t.reads.push(() => gate.promise)
    const pending = t.service.navigate('refresh')
    await vi.waitFor(() => expect(t.asked).toHaveLength(2))
    expect(t.service.getSnapshot()).toMatchObject({ status: 'loading', error: null })
    gate.resolve(answer())
    await pending
  })

  it('turns an unexpected throw into a failure', async () => {
    const t = setup()
    t.reads.push(async () => {
      throw new Error('boom')
    })
    t.service.start('u1')
    const result = await t.service.navigate('refresh')
    expect(result).toMatchObject({ ok: true, value: { status: 'failed' } })
    expect(t.service.getSnapshot().error?.message).not.toContain('boom')
  })
})

describe('showing what was read before', () => {
  it('shows a view read earlier while it reads it again', async () => {
    const t = setup()
    t.reads.push(async () => answer([meeting]))
    t.service.start('u1')
    await t.service.navigate('refresh')
    const gate = deferred<Result<CalendarAnswer>>()
    t.reads.push(() => gate.promise)
    const pending = t.service.navigate('refresh')
    await vi.waitFor(() => expect(t.asked).toHaveLength(2))
    expect(t.service.getSnapshot()).toMatchObject({ status: 'loading', loadedAt: NOW })
    expect(t.service.getSnapshot().days[0]!.events).toHaveLength(1)
    gate.resolve(answer())
    await pending
    expect(t.service.getSnapshot().days[0]!.events).toHaveLength(0)
  })

  it('works out which day is today again for what was read before midnight', async () => {
    let now = NOW
    const t = setup(() => now)
    t.service.start('u1')
    await t.service.navigate('tomorrow')
    expect(t.service.getSnapshot().days[0]).toMatchObject({ date: '2026-10-23', isToday: false })
    now = Date.parse('2026-10-22T15:30:00Z') // 00:30 on the 23rd in Seoul
    const gate = deferred<Result<CalendarAnswer>>()
    t.reads.push(() => gate.promise)
    const pending = t.service.navigate('refresh')
    await vi.waitFor(() => expect(t.asked).toHaveLength(2))
    expect(t.service.getSnapshot().days[0]).toMatchObject({ date: '2026-10-23', isToday: true })
    gate.resolve(answer())
    await pending
  })

  it('remembers a bounded number of views', async () => {
    const t = setup()
    t.service.start('u1')
    await t.service.navigate('refresh')
    for (let step = 0; step < 40; step += 1) await t.service.navigate('next')
    // The first view was pushed out, so going back far finds nothing remembered, and does not break.
    for (let step = 0; step < 40; step += 1) await t.service.navigate('previous')
    expect(t.service.getSnapshot()).toMatchObject({
      status: 'ready',
      view: { startDate: '2026-10-22' }
    })
  })
})

describe('requests that overlap', () => {
  it('lets the newest one win, and throws the older answer away', async () => {
    const t = setup()
    const first = deferred<Result<CalendarAnswer>>()
    const second = deferred<Result<CalendarAnswer>>()
    t.reads.push(
      () => first.promise,
      () => second.promise
    )
    t.service.start('u1')
    const older = t.service.navigate('refresh') // today
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    const newer = t.service.navigate('next') // tomorrow
    await vi.waitFor(() => expect(t.asked).toHaveLength(2))
    second.resolve(
      answer([
        {
          ...meeting,
          id: 'new',
          startMs: meeting.startMs + 86_400_000,
          endMs: meeting.endMs + 86_400_000
        }
      ])
    )
    await newer
    first.resolve(answer([{ ...meeting, id: 'old' }]))
    await older
    const snapshot = t.service.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.view?.startDate).toBe('2026-10-23')
    expect(JSON.stringify(snapshot.days)).toContain('new')
    expect(JSON.stringify(snapshot.days)).not.toContain('old')
  })

  it('cancels the request it replaces', async () => {
    const t = setup()
    const gate = deferred<Result<CalendarAnswer>>()
    t.reads.push(() => gate.promise)
    t.service.start('u1')
    const older = t.service.navigate('refresh')
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    const firstSignal = t.signals.at(-1)!
    void t.service.navigate('refresh')
    expect(firstSignal.aborted).toBe(true)
    gate.resolve(answer())
    await older
  })

  it('does not let an older failure replace a newer success', async () => {
    const t = setup()
    const first = deferred<Result<CalendarAnswer>>()
    t.reads.push(
      () => first.promise,
      async () => answer([meeting])
    )
    t.service.start('u1')
    const older = t.service.navigate('refresh')
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    await t.service.navigate('refresh')
    first.resolve(failure())
    await older
    expect(t.service.getSnapshot()).toMatchObject({ status: 'ready', error: null })
  })
})

describe('signing out and switching accounts', () => {
  it('forgets everything on sign-out, and tells the window', async () => {
    const t = setup()
    t.reads.push(async () => answer([meeting]))
    t.service.start('u1')
    await t.service.navigate('refresh')
    await t.service.stop()
    expect(t.service.getSnapshot()).toMatchObject({
      status: 'idle',
      view: null,
      timeZone: null,
      days: [],
      loadedAt: null,
      lastSuccessAt: null,
      error: null
    })
    expect(t.events.at(-1)!.snapshot).toEqual(t.service.getSnapshot())
    expect(await t.service.navigate('refresh')).toMatchObject({ ok: false })
  })

  it('throws away an answer that arrives after sign-out', async () => {
    const t = setup()
    const gate = deferred<Result<CalendarAnswer>>()
    t.reads.push(() => gate.promise)
    t.service.start('u1')
    const pending = t.service.navigate('refresh')
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    const signal = t.signals.at(-1)!
    await t.service.stop()
    expect(signal.aborted).toBe(true)
    gate.resolve(answer([meeting]))
    await pending
    expect(t.service.getSnapshot()).toMatchObject({ status: 'idle', days: [], loadedAt: null })
  })

  it('throws away an answer for the earlier user when another signs in', async () => {
    const t = setup()
    const gate = deferred<Result<CalendarAnswer>>()
    t.reads.push(() => gate.promise)
    t.service.start('u1')
    const pending = t.service.navigate('refresh')
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    t.service.start('u2')
    gate.resolve(answer([meeting]))
    await pending
    expect(JSON.stringify(t.service.getSnapshot())).not.toContain('회의')
    expect(t.service.getSnapshot()).toMatchObject({ status: 'idle', days: [] })
  })

  it('does not show the earlier user what was remembered', async () => {
    const t = setup()
    t.reads.push(async () => answer([meeting]))
    t.service.start('u1')
    await t.service.navigate('refresh')
    t.service.start('u2')
    expect(t.events.at(-1)!.snapshot).toMatchObject({ status: 'idle', days: [] })
    const gate = deferred<Result<CalendarAnswer>>()
    t.reads.push(() => gate.promise)
    const pending = t.service.navigate('refresh')
    await vi.waitFor(() => expect(t.asked).toHaveLength(2))
    expect(t.service.getSnapshot()).toMatchObject({ status: 'loading', days: [], loadedAt: null })
    gate.resolve(answer())
    await pending
  })

  it('does not start over when the same user is announced again', async () => {
    const t = setup()
    t.reads.push(async () => answer([meeting]))
    t.service.start('u1')
    await t.service.navigate('refresh')
    const before = t.service.getSnapshot()
    t.service.start('u1')
    expect(t.service.getSnapshot()).toEqual(before)
  })

  it('can be stopped when nothing was started', async () => {
    const t = setup()
    await t.service.stop()
    expect(t.events).toEqual([])
  })

  it('serves the same user again after a sign-out and sign-in', async () => {
    const t = setup()
    t.service.start('u1')
    await t.service.navigate('refresh')
    await t.service.stop()
    t.service.start('u1')
    expect(await t.service.navigate('refresh')).toMatchObject({
      ok: true,
      value: { status: 'ready' }
    })
  })

  it('keeps going when a listener throws', async () => {
    const t = setup()
    const heard = vi.fn<(event: CalendarEvent) => void>()
    t.service.subscribe(() => {
      throw new Error('listener')
    })
    t.service.subscribe(heard)
    t.service.start('u1')
    await t.service.navigate('refresh')
    expect(heard).toHaveBeenCalled()
    expect(t.service.getSnapshot().status).toBe('ready')
  })

  it('stops telling a listener that unsubscribed', async () => {
    const t = setup()
    const heard = vi.fn<(event: CalendarEvent) => void>()
    const unsubscribe = t.service.subscribe(heard)
    unsubscribe()
    t.service.start('u1')
    await t.service.navigate('refresh')
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('with no server', () => {
  it('says it cannot show a calendar, and never an empty one', async () => {
    const calendar = new UnavailableCalendar()
    expect(calendar.getSnapshot()).toMatchObject({
      status: 'failed',
      days: [],
      error: { code: 'unavailable' }
    })
    expect(await calendar.navigate()).toEqual({ ok: true, value: calendar.getSnapshot() })
    expect(CalendarSnapshotSchema.safeParse(calendar.getSnapshot()).success).toBe(true)
    calendar.subscribe()()
  })
})
