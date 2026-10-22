import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { CalendarService } from '../../src/main/calendar/calendar-service'
import { registerCalendarIpc } from '../../src/main/ipc/calendar-ipc'
import { createUiBridge } from '../../src/preload/ui-bridge'
import type { CalendarEvent, CalendarEventDraft } from '../../src/shared/contracts/calendar'
import { CALENDAR_CHANNELS } from '../../src/shared/ipc/channels'

const draft: CalendarEventDraft = {
  title: '팀 회의',
  allDay: false,
  startDate: '2026-10-22',
  startTime: '14:00',
  endDate: '2026-10-22',
  endTime: '15:00'
}

function setup() {
  const changes: unknown[][] = []
  const entryUrl = 'file:///jarvis/ui/index.html'
  type Listener = (event: unknown, value: unknown) => void
  const listeners = new Map<string, Set<Listener>>()
  const contents = {
    mainFrame: { url: entryUrl },
    isDestroyed: () => false,
    send: vi.fn<(channel: string, value: unknown) => void>((channel, value) => {
      for (const listener of listeners.get(channel) ?? [])
        listener({ native: true }, structuredClone(value))
    })
  } as unknown as WebContents
  const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc = {
    handle: vi.fn<IpcMain['handle']>((channel, handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn<IpcMain['removeHandler']>((channel) => {
      handlers.delete(channel)
    })
  }
  const service = new CalendarService({
    api: {
      timeZone: async () => ({ ok: true, value: 'Asia/Seoul' }),
      events: async () => ({ ok: true, value: { events: [], todos: [] } }),
      createEvent: async (prepared) => {
        changes.push(['create', prepared])
        return { kind: 'done' }
      },
      updateEvent: async (id, prepared) => {
        changes.push(['update', id, prepared])
        return { kind: 'done' }
      },
      deleteEvent: async (id) => {
        changes.push(['delete', id])
        return { kind: 'done' }
      }
    },
    now: () => Date.parse('2026-10-22T03:00:00Z')
  })
  service.start('u1')
  const dispose = registerCalendarIpc({
    ipc,
    getContents: () => contents,
    entryUrl,
    calendar: service
  })
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(
    async (channel, ...args) => structuredClone(await handlers.get(channel)!(event, ...args))
  )
  const api = createUiBridge(
    {
      invoke,
      on: (channel, listener) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(listener)
      },
      removeListener: (channel, listener) => {
        listeners.get(channel)?.delete(listener)
      }
    },
    'darwin'
  ).calendar
  return {
    api,
    service,
    handlers,
    ipc,
    contents,
    event,
    entryUrl,
    dispose,
    invoke,
    listeners,
    changes
  }
}

describe('calendar IPC and preload boundary', () => {
  it('round-trips navigation and snapshots, and exposes only validated state events', async () => {
    const t = setup()
    const listener = vi.fn<(event: CalendarEvent) => void>()
    t.api.subscribe(listener)
    expect(await t.api.getSnapshot()).toMatchObject({ ok: true, value: { status: 'idle' } })
    expect(await t.api.navigate({ navigation: 'tomorrow' })).toMatchObject({
      ok: true,
      value: { status: 'ready', view: { startDate: '2026-10-23' } }
    })
    expect(listener.mock.calls.at(-1)).toEqual([
      {
        type: 'calendar.state_changed',
        snapshot: t.service.getSnapshot()
      }
    ])
    expect(Object.keys(t.api).sort()).toEqual([
      'createEvent',
      'deleteEvent',
      'getSnapshot',
      'navigate',
      'subscribe',
      'updateEvent'
    ])
    t.dispose()
  })

  it('rejects forged arguments in preload before invoking Main, and again in Main', async () => {
    const t = setup()
    const handle = t.handlers.get(CALENDAR_CHANNELS.navigate)!
    for (const request of [
      null,
      {},
      { navigation: 'delete' },
      { navigation: 'today', userId: 'u2' }
    ]) {
      expect(await t.api.navigate(request as never)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
      expect(t.invoke).not.toHaveBeenCalled()
      expect(await handle(t.event, request)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    }
    for (const args of [[], [{ navigation: 'today' }, 'extra']])
      expect(await handle(t.event, ...args)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    expect(await t.handlers.get(CALENDAR_CHANNELS.snapshot)!(t.event, 'extra')).toMatchObject({
      ok: false
    })
    expect(t.service.getSnapshot().status).toBe('idle')
    t.dispose()
  })

  it('refuses foreign windows, subframes, missing frames and other documents on both channels', async () => {
    const t = setup()
    for (const channel of [
      CALENDAR_CHANNELS.snapshot,
      CALENDAR_CHANNELS.navigate,
      CALENDAR_CHANNELS.create,
      CALENDAR_CHANNELS.update,
      CALENDAR_CHANNELS.delete
    ]) {
      const handle = t.handlers.get(channel)!
      const args =
        channel === CALENDAR_CHANNELS.navigate
          ? [{ navigation: 'today' }]
          : channel === CALENDAR_CHANNELS.create
            ? [{ draft }]
            : channel === CALENDAR_CHANNELS.update
              ? [{ eventId: '1', draft }]
              : channel === CALENDAR_CHANNELS.delete
                ? [{ eventId: '1' }]
                : []
      for (const event of [
        { ...t.event, sender: {} },
        { ...t.event, senderFrame: { url: t.entryUrl } },
        { ...t.event, senderFrame: null }
      ])
        expect(await handle(event as IpcMainInvokeEvent, ...args)).toMatchObject({
          ok: false,
          error: { code: 'permission_denied' }
        })
      Object.assign(t.contents.mainFrame, { url: 'file:///foreign.html' })
      expect(await handle(t.event, ...args)).toMatchObject({
        ok: false,
        error: { code: 'permission_denied' }
      })
      Object.assign(t.contents.mainFrame, { url: t.entryUrl })
    }
    t.dispose()
  })

  it('turns exceptions and invalid Main answers into fixed errors without exposing internals', async () => {
    const t = setup()
    vi.spyOn(t.service, 'navigate').mockRejectedValueOnce(new Error('secret'))
    expect(await t.api.navigate({ navigation: 'today' })).toMatchObject({
      ok: false,
      error: { code: 'internal' }
    })
    vi.spyOn(t.service, 'getSnapshot').mockImplementationOnce(() => {
      throw new Error('secret')
    })
    expect(JSON.stringify(await t.api.getSnapshot())).not.toContain('secret')
    vi.spyOn(t.service, 'getSnapshot').mockReturnValueOnce({ status: 'bogus' } as never)
    expect(await t.api.getSnapshot()).toMatchObject({ ok: false, error: { code: 'internal' } })
    vi.spyOn(t.service, 'navigate').mockResolvedValueOnce({ ok: true, value: {} } as never)
    expect(await t.api.navigate({ navigation: 'today' })).toMatchObject({ ok: false })
    t.invoke.mockResolvedValueOnce({ ok: true, value: { secret: 'secret' } })
    expect(await t.api.getSnapshot()).toMatchObject({ ok: false })
    t.dispose()
  })

  it('discards invalid events, unsubscribes once, and stops pushing to a different document', async () => {
    const t = setup()
    const listener = vi.fn<(event: CalendarEvent) => void>()
    const unsubscribe = t.api.subscribe(listener)
    const receive = [...t.listeners.get(CALENDAR_CHANNELS.event)!][0]!
    receive({}, { type: 'calendar.state_changed', snapshot: { secret: 'secret' } })
    expect(listener).not.toHaveBeenCalled()
    Object.assign(t.contents.mainFrame, { url: 'file:///foreign.html' })
    await t.service.navigate('today')
    expect(listener).not.toHaveBeenCalled()
    Object.assign(t.contents.mainFrame, { url: t.entryUrl })
    unsubscribe()
    unsubscribe()
    receive({}, { type: 'calendar.state_changed', snapshot: t.service.getSnapshot() })
    await t.service.navigate('refresh')
    expect(listener).not.toHaveBeenCalled()
    t.dispose()
    t.dispose()
    expect(t.ipc.removeHandler).toHaveBeenCalledTimes(Object.keys(CALENDAR_CHANNELS).length - 1)
    expect(t.handlers.size).toBe(0)
  })

  it('adds, changes and deletes through the bridge, and gets the calendar back each time', async () => {
    const t = setup()
    t.service.start('u1')
    const created = await t.api.createEvent({ draft })
    expect(created).toMatchObject({
      ok: true,
      value: { outcome: 'saved', snapshot: { status: 'ready' } }
    })
    expect(
      await t.api.updateEvent({ eventId: '551', draft: { ...draft, title: '바뀐 회의' } })
    ).toMatchObject({
      ok: true,
      value: { outcome: 'saved' }
    })
    expect(await t.api.deleteEvent({ eventId: '551' })).toMatchObject({
      ok: true,
      value: { outcome: 'saved' }
    })
    expect(t.changes.map((change) => change[0])).toEqual(['create', 'update', 'delete'])
    expect(t.changes[0]![1]).toMatchObject({
      title: '팀 회의',
      startMs: Date.parse('2026-10-22T05:00:00Z')
    })
    t.dispose()
  })

  it('rejects a malformed change in preload and again in Main, and changes nothing', async () => {
    const t = setup()
    const bad: [string, unknown, unknown][] = [
      ['createEvent', CALENDAR_CHANNELS.create, null],
      ['createEvent', CALENDAR_CHANNELS.create, {}],
      ['createEvent', CALENDAR_CHANNELS.create, { draft: { ...draft, extra: 1 } }],
      ['createEvent', CALENDAR_CHANNELS.create, { draft: { ...draft, startDate: 20261022 } }],
      ['createEvent', CALENDAR_CHANNELS.create, { draft, source: 'google' }],
      ['updateEvent', CALENDAR_CHANNELS.update, { draft }],
      ['updateEvent', CALENDAR_CHANNELS.update, { eventId: '', draft }],
      ['updateEvent', CALENDAR_CHANNELS.update, { eventId: ' 1', draft }],
      ['deleteEvent', CALENDAR_CHANNELS.delete, {}],
      ['deleteEvent', CALENDAR_CHANNELS.delete, { eventId: 1 }],
      ['deleteEvent', CALENDAR_CHANNELS.delete, { eventId: '1', extra: true }]
    ]
    t.service.start('u1')
    for (const [method, channel, request] of bad) {
      const call = (t.api as unknown as Record<string, (r: unknown) => Promise<unknown>>)[method]!
      expect(await call(request)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(await t.handlers.get(channel as string)!(t.event, request)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    }
    expect(t.invoke).not.toHaveBeenCalled()
    for (const channel of [
      CALENDAR_CHANNELS.create,
      CALENDAR_CHANNELS.update,
      CALENDAR_CHANNELS.delete
    ])
      expect(await t.handlers.get(channel)!(t.event)).toMatchObject({ ok: false })
    expect(t.changes).toEqual([])
    t.dispose()
  })

  it('turns an exception or an invalid answer from a change into a fixed error', async () => {
    const t = setup()
    vi.spyOn(t.service, 'createEvent').mockRejectedValueOnce(new Error('secret'))
    const failed = await t.api.createEvent({ draft })
    expect(failed).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(failed)).not.toContain('secret')
    vi.spyOn(t.service, 'deleteEvent').mockResolvedValueOnce({
      ok: true,
      value: { outcome: 'saved', snapshot: { secret: 'secret' } }
    } as never)
    expect(await t.api.deleteEvent({ eventId: '1' })).toMatchObject({ ok: false })
    t.invoke.mockResolvedValueOnce({ ok: true, value: { outcome: 'maybe' } })
    expect(await t.api.updateEvent({ eventId: '1', draft })).toMatchObject({ ok: false })
    t.dispose()
  })

  it('passes "not saved" and "unknown" through with their reasons', async () => {
    const t = setup()
    t.service.start('u1')
    expect(await t.api.createEvent({ draft: { ...draft, title: ' ' } })).toMatchObject({
      ok: true,
      value: {
        outcome: 'not_saved',
        error: { code: 'invalid_input', message: '제목을 입력해 주세요.' }
      }
    })
    vi.spyOn(t.service, 'createEvent').mockResolvedValueOnce({
      ok: true,
      value: {
        outcome: 'unknown',
        error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' },
        snapshot: t.service.getSnapshot()
      }
    })
    expect(await t.api.createEvent({ draft })).toMatchObject({
      ok: true,
      value: { outcome: 'unknown' }
    })
    t.dispose()
  })
})
