import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildDays, viewOf } from '../../src/main/calendar/calendar-view'
import { CalendarView } from '../../src/renderer/ui/features/calendar/calendar-view'
import { DisconnectDialog, GooglePanel } from '../../src/renderer/ui/features/google/google-panel'
import { newestGoogleSnapshot } from '../../src/renderer/ui/features/google/use-google-connection'
import {
  googleLine,
  googleView,
  syncedLabel
} from '../../src/renderer/ui/features/google/view-model'
import type { CalendarSnapshot } from '../../src/shared/contracts/calendar'
import type { GoogleConnectionSnapshot } from '../../src/shared/contracts/google-connection'

const T = Date.parse('2026-10-22T05:32:00Z') // 14:32 in Seoul

const google = (overrides: Partial<GoogleConnectionSnapshot> = {}): GoogleConnectionSnapshot => ({
  revision: 4,
  availability: 'ready',
  read: 'ready',
  connection: { status: 'active', connectedAt: T - 3_600_000, lastSyncedAt: T },
  activity: 'none',
  authorizeUntil: null,
  outcome: null,
  error: null,
  ...overrides
})
const buttons = (snapshot: GoogleConnectionSnapshot) =>
  googleView(snapshot, 'Asia/Seoul').buttons.map((button) => button.action)

describe('the time of the last import', () => {
  it('is the date and time in the user’s zone', () => {
    expect(syncedLabel(T, 'Asia/Seoul')).toBe('10월 22일 14:32')
    expect(syncedLabel(T, 'America/Los_Angeles')).toBe('10월 21일 22:32')
    expect(syncedLabel(Date.parse('2026-10-22T15:05:00Z'), 'Asia/Seoul')).toBe('10월 23일 00:05')
  })

  it('still shows a time when the zone is not known or not usable', () => {
    expect(syncedLabel(T, null)).toMatch(/^\d{1,2}월 \d{1,2}일 \d{2}:\d{2}$/)
    expect(syncedLabel(T, 'UTC+9')).toMatch(/^\d{1,2}월 \d{1,2}일 \d{2}:\d{2}$/)
  })
})

describe('the connection as the settings show it', () => {
  it('offers to connect when there is none', () => {
    const view = googleView(google({ connection: null }), 'Asia/Seoul')
    expect(view).toMatchObject({ chip: '연결 안 됨', tone: 'idle' })
    expect(view.buttons).toEqual([{ action: 'connect', label: '연결', primary: true }])
  })

  it('shows the last import and offers to import now or disconnect when connected', () => {
    const view = googleView(google(), 'Asia/Seoul')
    expect(view).toMatchObject({
      chip: '연결됨',
      tone: 'ok',
      detail: '마지막 동기화 10월 22일 14:32'
    })
    expect(view.buttons.map((button) => button.action)).toEqual(['sync', 'disconnect'])
  })

  it('says there has been no import yet', () => {
    const view = googleView(
      google({ connection: { status: 'active', connectedAt: T, lastSyncedAt: null } }),
      'Asia/Seoul'
    )
    expect(view.detail).toBe('아직 Google 일정을 가져온 적이 없어요.')
  })

  it('offers to connect again, or to disconnect, when the connection has expired', () => {
    const view = googleView(
      google({ connection: { status: 'reconnect_required', connectedAt: T, lastSyncedAt: T } }),
      'Asia/Seoul'
    )
    expect(view).toMatchObject({ chip: '다시 연결 필요', tone: 'warn' })
    expect(view.buttons.map((button) => [button.action, button.label])).toEqual([
      ['connect', '다시 연결'],
      ['disconnect', '연결 해제']
    ])
  })

  it('shows what it is waiting for, with the time it waits until, and offers to cancel', () => {
    const view = googleView(
      google({ connection: null, activity: 'authorizing', authorizeUntil: T }),
      'Asia/Seoul'
    )
    expect(view).toMatchObject({ chip: '연결 중', tone: 'info' })
    expect(view.detail).toContain('브라우저')
    expect(view.detail).toContain('14:32까지')
    expect(view.buttons.map((button) => button.action)).toEqual(['cancel_connect'])
  })

  it('offers nothing while it imports or disconnects, so a second press cannot start another', () => {
    expect(googleView(google({ activity: 'syncing' }), null)).toMatchObject({
      chip: '동기화 중',
      buttons: []
    })
    expect(googleView(google({ activity: 'disconnecting' }), null)).toMatchObject({
      chip: '해제 중',
      buttons: []
    })
  })

  it('says it is checking before it knows, and offers nothing', () => {
    for (const read of ['idle', 'loading'] as const) {
      const view = googleView(google({ connection: null, read }), null)
      expect(view).toMatchObject({ chip: '확인 중', buttons: [] })
    }
  })

  it('says it could not read, and does not offer to connect, with a way to try again', () => {
    const view = googleView(
      google({
        connection: null,
        read: 'failed',
        error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
      }),
      null
    )
    expect(view).toMatchObject({ chip: '확인하지 못함', tone: 'error' })
    expect(
      buttons(
        google({ connection: null, read: 'failed', error: { code: 'unavailable', message: 'x' } })
      )
    ).toEqual(['refresh'])
    expect(view.notice).toEqual({ tone: 'error', text: '서버에 연결할 수 없습니다.' })
  })

  it('says it is not available without a server, and offers nothing', () => {
    expect(
      googleView(google({ availability: 'unavailable', connection: null }), null)
    ).toMatchObject({
      chip: '사용할 수 없음',
      buttons: []
    })
  })

  it('tells what just happened, never calling an unconfirmed import a success', () => {
    const outcome = (kind: NonNullable<GoogleConnectionSnapshot['outcome']>['kind']) =>
      googleView(google({ outcome: { kind, at: T } }), null).notice
    expect(outcome('synced')).toMatchObject({ tone: 'info' })
    expect(outcome('sync_unconfirmed')).toMatchObject({ tone: 'warn' })
    expect(outcome('sync_unconfirmed')?.text).toContain('확인하지 못했어요')
    expect(outcome('sync_unconfirmed')?.text).not.toContain('마쳤')
    expect(outcome('disconnected')?.text).toContain('지웠어요')
    expect(outcome('connect_expired')).toMatchObject({ tone: 'warn' })
    expect(outcome('connect_cancelled')).toMatchObject({ tone: 'info' })
    expect(outcome('connected')).toBeNull()
  })

  it('puts an error before what happened', () => {
    const view = googleView(
      google({
        outcome: { kind: 'synced', at: T },
        error: { code: 'unavailable', message: '실패했어요.' }
      }),
      null
    )
    expect(view.notice).toEqual({ tone: 'error', text: '실패했어요.' })
  })
})

describe('the line in the calendar tab', () => {
  it('says nothing before the connection is known or without a server', () => {
    expect(googleLine(null, 'Asia/Seoul')).toBeNull()
    expect(googleLine(google({ availability: 'unavailable' }), null)).toBeNull()
    expect(googleLine(google({ connection: null, read: 'loading' }), null)).toBeNull()
    expect(googleLine(google({ connection: null, read: 'idle' }), null)).toBeNull()
  })

  it('says when the Google events were last brought in', () => {
    expect(googleLine(google(), 'Asia/Seoul')).toEqual({
      tone: 'info',
      text: 'Google 일정은 10월 22일 14:32에 동기화했어요.',
      openSettings: false
    })
  })

  it('says they have not been brought in yet', () => {
    const line = googleLine(
      google({ connection: { status: 'active', connectedAt: T, lastSyncedAt: null } }),
      null
    )
    expect(line?.text).toBe('Google 일정을 아직 가져오지 않았어요.')
  })

  it('points to the settings when there is no connection or it has expired', () => {
    expect(googleLine(google({ connection: null }), null)).toMatchObject({ openSettings: true })
    expect(
      googleLine(
        google({ connection: { status: 'reconnect_required', connectedAt: T, lastSyncedAt: T } }),
        null
      )
    ).toMatchObject({ tone: 'warn', openSettings: true })
  })

  it('warns that an import may not have finished, and keeps the time of the last good one', () => {
    const line = googleLine(google({ outcome: { kind: 'sync_unconfirmed', at: T } }), 'Asia/Seoul')
    expect(line).toMatchObject({ tone: 'warn', openSettings: true })
    expect(line?.text).toContain('10월 22일 14:32')
    expect(line?.text).toContain('확인하지 못했어요')
  })

  it('says an import is under way, and that a connection is being waited for', () => {
    expect(googleLine(google({ activity: 'syncing' }), null)?.text).toContain('동기화하고 있어요')
    expect(
      googleLine(google({ connection: null, activity: 'authorizing', authorizeUntil: T }), null)
    ).toMatchObject({ openSettings: true })
  })

  it('does not say "not connected" when it could not read', () => {
    const line = googleLine(
      google({ connection: null, read: 'failed', error: { code: 'unavailable', message: 'x' } }),
      null
    )
    expect(line?.text).toContain('확인하지 못했어요')
    expect(line?.text).not.toContain('연결되지 않았어요')
  })
})

describe('the settings panel', () => {
  const render = (
    snapshot: GoogleConnectionSnapshot | null,
    connectionError: string | null = null
  ) =>
    renderToStaticMarkup(
      createElement(GooglePanel, {
        snapshot,
        connectionError,
        timeZone: 'Asia/Seoul',
        onCommand: () => undefined
      })
    )

  it('shows the state, the time of the last import and the buttons', () => {
    const html = render(google())
    expect(html).toContain('Google 캘린더')
    expect(html).toContain('연결됨')
    expect(html).toContain('마지막 동기화 10월 22일 14:32')
    expect(html).toContain('지금 동기화')
    expect(html).toContain('연결 해제')
    expect(html).toContain('원본은')
  })

  it('shows the connect button when there is no connection', () => {
    expect(render(google({ connection: null }))).toContain('>연결<')
  })

  it('turns the buttons off while something is going on, except cancelling the wait', () => {
    const busy = render(google({ activity: 'syncing' }))
    expect(busy).not.toContain('지금 동기화')
    const waiting = render(google({ connection: null, activity: 'authorizing', authorizeUntil: T }))
    expect(waiting).toContain('취소')
    expect(waiting).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*취소/)
    const loading = render(google({ read: 'loading' }))
    expect(loading).toMatch(/<button[^>]*disabled/)
  })

  it('says it could not reach Main, and shows a notice as text', () => {
    expect(render(null, 'Main 프로세스와 연결하지 못했어요.')).toContain(
      'Main 프로세스와 연결하지 못했어요.'
    )
    expect(render(null)).toContain('확인하고 있어요')
    const html = render(
      google({ error: { code: 'unavailable', message: '<img src=x onerror=alert(1)>' } })
    )
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })

  it('does not open the disconnect question until asked', () => {
    expect(render(google())).not.toContain('<dialog')
  })

  it('asks before disconnecting, and says what goes and what stays', () => {
    const html = renderToStaticMarkup(
      createElement(DisconnectDialog, { onConfirm: () => undefined, onClose: () => undefined })
    )
    expect(html).toContain('연결을 해제할까요?')
    expect(html).toContain('가져온 Google 일정이 지워져요')
    expect(html).toContain('자비스에서 만든 일정은 그대로')
    expect(html).toContain('원본도 바뀌지 않아요')
  })
})

describe('the calendar tab’s line about Google', () => {
  const calendar = (events: CalendarSnapshot['days'][number]['events'] = []): CalendarSnapshot => {
    const view = viewOf('day', '2026-10-22')
    const days = buildDays({
      view,
      timeZone: 'Asia/Seoul',
      today: '2026-10-22',
      events: [],
      todos: []
    })
    days[0]!.events = events
    return {
      revision: 3,
      status: 'ready',
      view,
      timeZone: 'Asia/Seoul',
      days,
      loadedAt: T,
      lastSuccessAt: T,
      error: null
    }
  }
  const noop = async () => ({ ok: false, error: { code: 'internal', message: 'x' } }) as const
  const render = (
    state: GoogleConnectionSnapshot | null,
    events?: Parameters<typeof calendar>[0]
  ) =>
    renderToStaticMarkup(
      createElement(CalendarView, {
        snapshot: calendar(events),
        connectionError: null,
        onNavigate: () => undefined,
        onCreate: noop,
        onUpdate: noop,
        onDelete: noop,
        google: state,
        onOpenSettings: () => undefined
      })
    )
  const googleEvent = {
    kind: 'event' as const,
    id: '1',
    title: '구글 일정',
    source: 'google' as const,
    allDay: true,
    startTime: null,
    endTime: null,
    part: null,
    extent: { startDate: '2026-10-22', startTime: null, endDate: '2026-10-22', endTime: null }
  }

  it('shows when the Google events were last brought in', () => {
    expect(render(google())).toContain('Google 일정은 10월 22일 14:32에 동기화했어요.')
  })

  it('has a button to the settings only when there is something to do there', () => {
    expect(render(google())).not.toContain('설정에서 보기')
    expect(render(google({ connection: null }))).toContain('설정에서 보기')
  })

  it('no longer says the state of the import cannot be known once it is known', () => {
    expect(render(google(), [googleEvent])).not.toContain('동기화 상태는 확인할 수 없어요')
  })

  it('still says it cannot be known when the connection is not known', () => {
    expect(render(null, [googleEvent])).toContain('동기화 상태는 확인할 수 없어요')
    expect(render(null, [])).not.toContain('동기화 상태는 확인할 수 없어요')
  })
})

describe('late snapshots', () => {
  it('does not replace a newer state with an older one', () => {
    const newer = google({ revision: 5 })
    const older = google({ revision: 4 })
    expect(newestGoogleSnapshot(newer, older)).toBe(newer)
    expect(newestGoogleSnapshot(older, newer)).toBe(newer)
    expect(newestGoogleSnapshot(null, older)).toBe(older)
  })
})
