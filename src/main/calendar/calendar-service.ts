import type {
  CalendarDay,
  CalendarEditOutcome,
  CalendarEvent,
  CalendarEventDraft,
  CalendarNavigation,
  CalendarSnapshot,
  CalendarView
} from '../../shared/contracts/calendar'
import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import type { CalendarApiPort, ChangeOutcome } from './calendar-api'
import { buildDays, serverWindow, shiftView, viewOf } from './calendar-view'
import { prepareEvent } from './event-draft'
import { addDays, isTimeZone, localDateKey } from './zoned-time'

/** What the calendar tab talks to; the window reaches it only through IPC. */
export interface CalendarPort {
  getSnapshot(): CalendarSnapshot
  subscribe(listener: (event: CalendarEvent) => void): Unsubscribe
  navigate(navigation: CalendarNavigation): Promise<Result<CalendarSnapshot>>
  createEvent(draft: CalendarEventDraft): Promise<Result<CalendarEditOutcome>>
  updateEvent(eventId: string, draft: CalendarEventDraft): Promise<Result<CalendarEditOutcome>>
  deleteEvent(eventId: string): Promise<Result<CalendarEditOutcome>>
}

type Change =
  | { kind: 'create'; draft: CalendarEventDraft }
  | { kind: 'update'; eventId: string; draft: CalendarEventDraft }
  | { kind: 'delete'; eventId: string }

export interface CalendarServiceOptions {
  api: CalendarApiPort
  /** Wall clock in milliseconds. */
  now(): number
}

interface Remembered {
  days: CalendarDay[]
  loadedAt: number
}

const MAX_REMEMBERED_VIEWS = 30

const noUser = {
  ok: false,
  error: { code: 'authentication_required', message: '로그인한 뒤에 일정을 볼 수 있어요.' }
} as const

function viewFor(
  navigation: CalendarNavigation,
  current: CalendarView | null,
  today: string
): CalendarView {
  switch (navigation) {
    case 'today':
      return viewOf('day', today)
    case 'tomorrow':
      return viewOf('day', addDays(today, 1))
    case 'this_week':
      return viewOf('week', today)
    case 'this_month':
      return viewOf('month', today)
    case 'previous':
      return current ? shiftView(current, -1) : viewOf('day', today)
    case 'next':
      return current ? shiftView(current, 1) : viewOf('day', today)
    case 'refresh':
      return current ?? viewOf('day', today)
  }
}

/**
 * The calendar tab's state for the signed-in user. It reads the user's time zone and the events of
 * one view at a time, keeps what it last read for each view it has shown, and tells the window
 * what is current. A failure is never an empty calendar: it is `failed`, with the last good
 * answer for the same days and when that was. Signing out, or another account signing in, drops
 * everything, and an answer that arrives for an earlier request or user is thrown away.
 */
export class CalendarService implements CalendarPort {
  private userId: string | null = null
  private revision = 0
  private run = 0
  private abort: AbortController | null = null
  private status: CalendarSnapshot['status'] = 'idle'
  private view: CalendarView | null = null
  private timeZone: string | null = null
  private days: CalendarDay[] = []
  private loadedAt: number | null = null
  private lastSuccessAt: number | null = null
  private error: ClientError | null = null
  private remembered = new Map<string, Remembered>()
  /** The change being sent, if any; only one at a time, so a double press cannot add twice. */
  private changing: symbol | null = null
  private changeAbort: AbortController | null = null
  private readonly listeners = new Set<(event: CalendarEvent) => void>()

  constructor(private readonly options: CalendarServiceOptions) {}

  start(userId: string): void {
    if (this.userId === userId) return
    const switching = this.userId !== null
    this.reset()
    this.userId = userId
    // Another account taking over: the window must not keep drawing the earlier one's days.
    if (switching) this.changed()
  }

  async stop(): Promise<void> {
    if (this.userId === null) return
    this.reset()
    this.userId = null
    this.changed()
  }

  getSnapshot(): CalendarSnapshot {
    return {
      revision: this.revision,
      status: this.status,
      view: this.view,
      timeZone: this.timeZone,
      days: this.days,
      loadedAt: this.loadedAt,
      lastSuccessAt: this.lastSuccessAt,
      error: this.error
    }
  }

  subscribe(listener: (event: CalendarEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Reads the view being shown again, when there is one. For changes that come from elsewhere (the
   * Google import finished): before the calendar was ever opened there is nothing to refresh, and
   * reading it with no view would pick the default one and leave the tab opening on that.
   */
  async refreshIfShown(): Promise<void> {
    if (this.userId === null || this.view === null) return
    await this.navigate('refresh')
  }

  /** Goes to the view and reads it. Resolves when this request is settled or a newer one replaced it. */
  async navigate(navigation: CalendarNavigation): Promise<Result<CalendarSnapshot>> {
    const user = this.userId
    if (user === null) return noUser
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    const token = ++this.run
    const superseded = () => token !== this.run || user !== this.userId
    const done = (): Result<CalendarSnapshot> => ({ ok: true, value: this.getSnapshot() })

    this.status = 'loading'
    this.error = null
    this.changed()

    try {
      const zone = await this.options.api.timeZone(abort.signal)
      if (superseded()) return done()
      if (!zone.ok) return this.fail(zone.error, '시간대를 확인하지 못했어요.', done)
      if (!isTimeZone(zone.value))
        return this.fail(
          { code: 'internal', message: '' },
          '서버가 알려 준 시간대를 이 기기에서 쓸 수 없어요.',
          done
        )
      const timeZone = zone.value
      const today = localDateKey(this.options.now(), timeZone)
      const view = viewFor(navigation, this.view, today)
      const known = this.remembered.get(rememberKey(timeZone, view))
      this.timeZone = timeZone
      this.view = view
      this.days = known ? withToday(known.days, today) : []
      this.loadedAt = known?.loadedAt ?? null
      this.changed()

      const answer = await this.options.api.events(serverWindow(view, timeZone), abort.signal)
      if (superseded()) return done()
      if (!answer.ok) return this.fail(answer.error, null, done)
      const loadedAt = this.options.now()
      const days = buildDays({ view, timeZone, today, ...answer.value })
      this.remember(rememberKey(timeZone, view), { days, loadedAt })
      this.status = 'ready'
      this.days = days
      this.loadedAt = loadedAt
      this.lastSuccessAt = loadedAt
      this.error = null
      this.changed()
      return done()
    } catch {
      if (superseded()) return done()
      return this.fail({ code: 'internal', message: '' }, null, done)
    }
  }

  createEvent(draft: CalendarEventDraft): Promise<Result<CalendarEditOutcome>> {
    return this.change({ kind: 'create', draft })
  }

  updateEvent(eventId: string, draft: CalendarEventDraft): Promise<Result<CalendarEditOutcome>> {
    return this.change({ kind: 'update', eventId, draft })
  }

  deleteEvent(eventId: string): Promise<Result<CalendarEditOutcome>> {
    return this.change({ kind: 'delete', eventId })
  }

  /**
   * Sends one change to the server, and on success reads the calendar again. The time zone is read
   * again first: what the user typed is on the clock of the zone the calendar was drawn in, and a
   * zone that changed meanwhile would move the event. A change is sent once; if it may have gone
   * through without us hearing, that is said (`unknown`) and left to the user to check.
   */
  private async change(change: Change): Promise<Result<CalendarEditOutcome>> {
    const user = this.userId
    if (user === null) return noUser
    const outcome = (
      kind: 'not_saved' | 'unknown',
      error: ClientError
    ): Result<CalendarEditOutcome> => ({
      ok: true,
      value: { outcome: kind, error, snapshot: this.getSnapshot() }
    })
    if (this.changing !== null)
      return outcome('not_saved', {
        code: 'conflict',
        message: '이전 요청을 처리하는 중이에요. 잠시 후 다시 시도해 주세요.'
      })
    const mine = Symbol('change')
    this.changing = mine
    const abort = new AbortController()
    this.changeAbort = abort
    const gone = (): Result<CalendarEditOutcome> => ({
      ok: false,
      error: { code: 'cancelled', message: '로그아웃되어 요청을 취소했어요.' }
    })
    try {
      const zone = await this.options.api.timeZone(abort.signal)
      if (user !== this.userId) return gone()
      if (!zone.ok)
        return outcome('not_saved', {
          code: zone.error.code,
          message: `시간대를 확인하지 못해 저장하지 않았어요. ${zone.error.message}`
        })
      if (!isTimeZone(zone.value))
        return outcome('not_saved', {
          code: 'internal',
          message: '서버가 알려 준 시간대를 이 기기에서 쓸 수 없어 저장하지 않았어요.'
        })
      if (this.timeZone !== null && zone.value !== this.timeZone) {
        await this.navigate('refresh')
        return outcome('not_saved', {
          code: 'conflict',
          message:
            '시간대 설정이 바뀌어 일정을 다시 불러왔어요. 시간을 확인하고 다시 저장해 주세요.'
        })
      }

      const sent = await this.send(change, zone.value, abort.signal)
      if (user !== this.userId) return gone()
      if (sent.kind === 'unknown') return outcome('unknown', sent.error)
      if (sent.kind === 'rejected') {
        // Gone, or not ours to change: what is drawn is out of date.
        if (sent.reason === 'not_found' || sent.reason === 'read_only')
          await this.navigate('refresh')
        return outcome('not_saved', sent.error)
      }
      // Whatever was kept for other days may now be wrong.
      this.remembered = new Map()
      await this.navigate('refresh')
      return { ok: true, value: { outcome: 'saved', snapshot: this.getSnapshot() } }
    } catch {
      if (user !== this.userId) return gone()
      return outcome('unknown', { code: 'internal', message: '요청을 처리하지 못했어요.' })
    } finally {
      if (this.changing === mine) {
        this.changing = null
        this.changeAbort = null
      }
    }
  }

  private async send(
    change: Change,
    timeZone: string,
    signal: AbortSignal
  ): Promise<ChangeOutcome> {
    if (change.kind === 'delete') return this.options.api.deleteEvent(change.eventId, signal)
    const prepared = prepareEvent(change.draft, timeZone)
    if (!prepared.ok) return { kind: 'rejected', reason: 'invalid', error: prepared.error }
    return change.kind === 'create'
      ? this.options.api.createEvent(prepared.value, signal)
      : this.options.api.updateEvent(change.eventId, prepared.value, signal)
  }

  private fail(
    error: ClientError,
    lead: string | null,
    done: () => Result<CalendarSnapshot>
  ): Result<CalendarSnapshot> {
    this.status = 'failed'
    this.error = {
      code: error.code,
      message: [lead, error.message || '일정을 불러오지 못했어요.'].filter(Boolean).join(' ')
    }
    this.changed()
    return done()
  }

  private remember(key: string, value: Remembered): void {
    this.remembered.delete(key)
    this.remembered.set(key, value)
    if (this.remembered.size > MAX_REMEMBERED_VIEWS)
      this.remembered.delete(this.remembered.keys().next().value!)
  }

  /** Back to nothing asked for: another user must never see this user's calendar. */
  private reset(): void {
    this.abort?.abort()
    this.abort = null
    this.changeAbort?.abort()
    this.changeAbort = null
    this.changing = null
    this.run += 1
    this.status = 'idle'
    this.view = null
    this.timeZone = null
    this.days = []
    this.loadedAt = null
    this.lastSuccessAt = null
    this.error = null
    this.remembered = new Map()
  }

  private changed(): void {
    this.revision += 1
    const event: CalendarEvent = { type: 'calendar.state_changed', snapshot: this.getSnapshot() }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        /* A listener that fails must not stop the others. */
      }
    }
  }
}

const rememberKey = (timeZone: string, view: CalendarView): string =>
  `${timeZone}|${view.span}|${view.startDate}`

/** What was read earlier may be from before midnight; which day is today is worked out again. */
const withToday = (days: CalendarDay[], today: string): CalendarDay[] =>
  days.map((day) => ({ ...day, isToday: day.date === today }))

/**
 * Used when there is no server to ask (no address, or the development sign-in stand-in, which the
 * server would not accept): the tab says so instead of showing an empty calendar.
 */
export class UnavailableCalendar implements CalendarPort {
  private readonly snapshot: CalendarSnapshot = {
    revision: 0,
    status: 'failed',
    view: null,
    timeZone: null,
    days: [],
    loadedAt: null,
    lastSuccessAt: null,
    error: {
      code: 'unavailable',
      message: '서버에 연결되지 않은 상태라 일정을 불러올 수 없어요.'
    }
  }

  getSnapshot(): CalendarSnapshot {
    return this.snapshot
  }

  subscribe(): Unsubscribe {
    return () => undefined
  }

  async navigate(): Promise<Result<CalendarSnapshot>> {
    return { ok: true, value: this.snapshot }
  }

  async createEvent(): Promise<Result<CalendarEditOutcome>> {
    return this.refused()
  }

  async updateEvent(): Promise<Result<CalendarEditOutcome>> {
    return this.refused()
  }

  async deleteEvent(): Promise<Result<CalendarEditOutcome>> {
    return this.refused()
  }

  private refused(): Result<CalendarEditOutcome> {
    return {
      ok: true,
      value: {
        outcome: 'not_saved',
        error: { code: 'unavailable', message: '서버에 연결되지 않은 상태라 저장할 수 없어요.' },
        snapshot: this.snapshot
      }
    }
  }
}
