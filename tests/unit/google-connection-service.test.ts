import { describe, expect, it, vi } from 'vitest'
import type {
  Authorization,
  Disconnected,
  GoogleConnectionApiPort,
  ServerConnection,
  SyncStart
} from '../../src/main/google-connection/google-connection-api'
import {
  GoogleConnectionService,
  UnavailableGoogleConnection
} from '../../src/main/google-connection/google-connection-service'
import type { Result } from '../../src/shared/contracts/common'
import {
  GoogleConnectionSnapshotSchema,
  type GoogleAction,
  type GoogleConnectionEvent
} from '../../src/shared/contracts/google-connection'
import { waitUntil } from '../helpers/wait'

const T0 = Date.parse('2026-10-22T03:00:00Z')
const MIN = 60_000
const CONSENT = 'https://accounts.google.com/o/oauth2/v2/auth?state=s'

const failure = (message = '서버에 연결하지 못했어요.') =>
  ({ ok: false, error: { code: 'unavailable', message } }) as const
const connectionAt = (overrides: Partial<ServerConnection> = {}): ServerConnection => ({
  id: '31',
  status: 'active',
  connectedAtMs: T0 - 60 * MIN,
  lastSyncedAtMs: T0 - 5 * MIN,
  ...overrides
})

/**
 * A stand-in for the server and the browser. `server` is what the server holds; the test changes it
 * to play what happens elsewhere (the consent finishing, an import finishing). Each call can also
 * be given a scripted answer.
 */
function setup(options: { serverOffsetMs?: number } = {}) {
  const clockState = { now: T0 }
  const server: { connection: ServerConnection | null } = { connection: null }
  const calls: string[] = []
  const reads: (() => Promise<Result<ServerConnection | null>>)[] = []
  const authorizations: (() => Promise<Result<Authorization>>)[] = []
  const syncs: (() => Promise<SyncStart>)[] = []
  const disconnects: (() => Promise<Disconnected>)[] = []
  const signals: AbortSignal[] = []
  const api: GoogleConnectionApiPort = {
    async connection(signal) {
      calls.push('connection')
      if (signal) signals.push(signal)
      return (reads.shift() ?? (async () => ({ ok: true, value: server.connection }) as const))()
    },
    async authorize() {
      calls.push('authorize')
      return (
        authorizations.shift() ??
        (async () =>
          ({
            ok: true,
            value: { url: CONSENT, expiresAtServerMs: clockState.now + 10 * MIN }
          }) as const)
      )()
    },
    async sync(id) {
      calls.push(`sync:${id}`)
      return (syncs.shift() ?? (async () => ({ kind: 'queued' }) as const))()
    },
    async disconnect(id) {
      calls.push(`disconnect:${id}`)
      return (disconnects.shift() ?? (async () => ({ kind: 'done' }) as const))()
    }
  }
  const opened: string[] = []
  let openResult = true
  const changed = vi.fn<() => void>()
  const service = new GoogleConnectionService({
    api,
    now: () => clockState.now,
    clock: { serverTimeAt: (local) => local + (options.serverOffsetMs ?? 0) },
    // Time moves by the wait, but only a moment passes for real, so a test can look in between.
    sleep: async (ms, signal) => {
      clockState.now += ms
      if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1))
    },
    openConsent: async (url) => {
      opened.push(url)
      return openResult
    },
    onCalendarChanged: changed,
    pollMs: 1000,
    syncWaitMs: 20_000
  })
  const events: GoogleConnectionEvent[] = []
  service.subscribe((event) => events.push(event))
  service.start('u1')
  const run = async (action: GoogleAction) => {
    const result = await service.command(action)
    if (!result.ok) throw new Error(result.error.code)
    return result.value
  }
  const snapshot = () => service.getSnapshot()
  const count = (name: string) => calls.filter((call) => call === name).length
  return {
    service,
    server,
    calls,
    reads,
    authorizations,
    syncs,
    disconnects,
    signals,
    opened,
    changed,
    events,
    clock: clockState,
    run,
    snapshot,
    count,
    setOpenResult: (value: boolean) => {
      openResult = value
    }
  }
}

describe('before anyone is signed in', () => {
  it('asks for nothing, and will not', async () => {
    const fake = setup()
    await fake.service.stop()
    for (const action of ['refresh', 'connect', 'sync', 'disconnect', 'cancel_connect'] as const)
      expect(await fake.service.command(action)).toMatchObject({
        ok: false,
        error: { code: 'authentication_required' }
      })
    expect(fake.calls).toEqual([])
  })

  it('says there is no server to ask when it has none', async () => {
    const none = new UnavailableGoogleConnection()
    expect(none.getSnapshot()).toMatchObject({ availability: 'unavailable', connection: null })
    expect(await none.command()).toEqual({ ok: true, value: none.getSnapshot() })
    none.subscribe()()
    expect(GoogleConnectionSnapshotSchema.safeParse(none.getSnapshot()).success).toBe(true)
  })
})

describe('reading the connection', () => {
  it('reads that there is none, which is not an error', async () => {
    const t = setup()
    const state = await t.run('refresh')
    expect(state).toMatchObject({ read: 'ready', connection: null, activity: 'none', error: null })
    expect(t.calls).toEqual(['connection'])
  })

  it('reads a connection with its last import time, and does not import when that is recent', async () => {
    const t = setup()
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 - 5 * MIN })
    const state = await t.run('refresh')
    expect(state).toMatchObject({
      read: 'ready',
      activity: 'none',
      connection: { status: 'active', connectedAt: T0 - 60 * MIN, lastSyncedAt: T0 - 5 * MIN }
    })
    expect(t.calls).toEqual(['connection'])
  })

  it('does not show the ID the server uses', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    expect(JSON.stringify(await t.run('refresh'))).not.toContain('"31"')
  })

  it('says it could not read, and does not say "not connected"', async () => {
    const t = setup()
    t.reads.push(async () => failure())
    const state = await t.run('refresh')
    expect(state).toMatchObject({
      read: 'failed',
      connection: null,
      error: { code: 'unavailable' }
    })
  })

  it('keeps what it knew when a later read fails', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    t.reads.push(async () => failure())
    const state = await t.run('refresh')
    expect(state).toMatchObject({ read: 'failed', connection: { status: 'active' } })
    expect(await t.run('refresh')).toMatchObject({ read: 'ready', error: null })
  })

  it('reads again while it is waiting for nothing else, but not while something is going on', async () => {
    const t = setup()
    await t.run('connect')
    const before = t.count('connection')
    await t.run('refresh')
    expect(t.count('connection')).toBe(before)
    expect(t.snapshot().activity).toBe('authorizing')
  })
})

describe('importing on its own', () => {
  it('starts an import when the last one is older than half an hour, and shows it done when the server’s time moves', async () => {
    const t = setup()
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 - 31 * MIN })
    const state = await t.run('refresh')
    expect(state).toMatchObject({ activity: 'syncing', read: 'ready' })
    expect(t.calls).toEqual(['connection', 'sync:31'])
    // The server finishes.
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 + 1000 })
    await waitUntil(() => t.snapshot().activity === 'none')
    expect(t.snapshot()).toMatchObject({
      outcome: { kind: 'synced' },
      connection: { lastSyncedAt: T0 + 1000 },
      error: null
    })
    expect(t.changed).toHaveBeenCalledTimes(1)
  })

  it('does not import at exactly half an hour less a moment, and does at half an hour', async () => {
    const fresh = setup()
    fresh.server.connection = connectionAt({ lastSyncedAtMs: T0 - 30 * MIN + 1 })
    await fresh.run('refresh')
    expect(fresh.count('sync:31')).toBe(0)
    const stale = setup()
    stale.server.connection = connectionAt({ lastSyncedAtMs: T0 - 30 * MIN })
    await stale.run('refresh')
    expect(stale.count('sync:31')).toBe(1)
  })

  it('imports when it never has', async () => {
    const t = setup()
    t.server.connection = connectionAt({ lastSyncedAtMs: null })
    await t.run('refresh')
    expect(t.count('sync:31')).toBe(1)
  })

  it('judges how old the last import is on the server’s clock, not this machine’s', async () => {
    // This machine is five minutes behind the server: the import is 35 minutes old, not 30 minus a moment.
    const behind = setup({ serverOffsetMs: 5 * MIN })
    behind.server.connection = connectionAt({ lastSyncedAtMs: T0 - 26 * MIN })
    await behind.run('refresh')
    expect(behind.count('sync:31')).toBe(1)
    // And ahead: the same import is only 25 minutes old.
    const ahead = setup({ serverOffsetMs: -5 * MIN })
    ahead.server.connection = connectionAt({ lastSyncedAtMs: T0 - 26 * MIN })
    await ahead.run('refresh')
    expect(ahead.count('sync:31')).toBe(0)
  })

  it('does not start one on its own more than once in half an hour, whatever came of the last', async () => {
    const t = setup()
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 - 40 * MIN })
    await t.run('refresh')
    // The server never moves: after the wait it is unconfirmed.
    await waitUntil(() => t.snapshot().activity === 'none')
    expect(t.snapshot().outcome).toMatchObject({ kind: 'sync_unconfirmed' })
    const started = t.count('sync:31')
    t.clock.now += 5 * MIN
    await t.run('refresh')
    expect(t.count('sync:31')).toBe(started)
    t.clock.now += 40 * MIN
    await t.run('refresh')
    expect(t.count('sync:31')).toBe(started + 1)
  })

  it('does not import a connection that has to be made again', async () => {
    const t = setup()
    t.server.connection = connectionAt({ status: 'reconnect_required', lastSyncedAtMs: null })
    const state = await t.run('refresh')
    expect(state.connection).toMatchObject({ status: 'reconnect_required' })
    expect(t.count('sync:31')).toBe(0)
  })
})

describe('importing when asked', () => {
  it('reads the connection first, then starts, then says done when the server’s time moves', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    t.calls.length = 0
    const state = await t.run('sync')
    expect(state.activity).toBe('syncing')
    expect(t.calls).toEqual(['connection', 'sync:31'])
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 + 5000 })
    await waitUntil(() => t.snapshot().outcome?.kind === 'synced')
    expect(t.snapshot()).toMatchObject({
      activity: 'none',
      connection: { lastSyncedAt: T0 + 5000 }
    })
    expect(t.changed).toHaveBeenCalledTimes(1)
  })

  it('does not call an import finished when the time has not moved', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    await t.run('sync')
    await waitUntil(() => t.snapshot().activity === 'none')
    expect(t.snapshot()).toMatchObject({
      outcome: { kind: 'sync_unconfirmed' },
      connection: { lastSyncedAt: T0 - 5 * MIN }
    })
    expect(t.changed).not.toHaveBeenCalled()
  })

  it('does not call it finished when the time moved backwards or stayed', async () => {
    const t = setup()
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 - 5 * MIN })
    await t.run('refresh')
    await t.run('sync')
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 - 6 * MIN })
    await waitUntil(() => t.snapshot().activity === 'none')
    expect(t.snapshot().outcome?.kind).toBe('sync_unconfirmed')
  })

  it('takes the first import as moved, from nothing to a time', async () => {
    const t = setup()
    t.server.connection = connectionAt({ lastSyncedAtMs: null })
    await t.run('refresh')
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 + 1 })
    await waitUntil(() => t.snapshot().outcome?.kind === 'synced')
    expect(t.snapshot().connection).toMatchObject({ lastSyncedAt: T0 + 1 })
  })

  it('compares with what the server holds when the import starts, not with an older read', async () => {
    const t = setup()
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 - 5 * MIN })
    await t.run('refresh')
    // Someone else imported in the meantime.
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 - 1 * MIN })
    await t.run('sync')
    await waitUntil(() => t.snapshot().activity === 'none')
    expect(t.snapshot().outcome?.kind).toBe('sync_unconfirmed')
  })

  it('says the connection has to be made again when the server says so, and does not wait', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    t.syncs.push(async () => ({ kind: 'reconnect_required' }))
    const state = await t.run('sync')
    expect(state).toMatchObject({ activity: 'none', connection: { status: 'reconnect_required' } })
    expect(t.changed).not.toHaveBeenCalled()
  })

  it('learns when the connection is gone', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    t.syncs.push(async () => ({ kind: 'not_found' }))
    expect(await t.run('sync')).toMatchObject({ activity: 'none', connection: null })
  })

  it('reports a failure to start, with its reason', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    t.syncs.push(async () => ({
      kind: 'failed',
      error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
    }))
    expect(await t.run('sync')).toMatchObject({
      activity: 'none',
      error: { message: '서버에 연결할 수 없습니다.' }
    })
  })

  it('does nothing when there is no connection, or when the read of it failed', async () => {
    const t = setup()
    await t.run('refresh')
    await t.run('sync')
    expect(t.calls).toEqual(['connection'])
    const u = setup()
    u.server.connection = connectionAt()
    await u.run('refresh')
    u.reads.push(async () => failure())
    expect(await u.run('sync')).toMatchObject({ read: 'failed', activity: 'none' })
    expect(u.count('sync:31')).toBe(0)
  })

  it('stops waiting when the connection is removed from somewhere else', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    await t.run('sync')
    t.server.connection = null
    await waitUntil(() => t.snapshot().activity === 'none')
    expect(t.snapshot()).toMatchObject({ connection: null, outcome: null })
    expect(t.changed).not.toHaveBeenCalled()
  })

  it('stops waiting when the connection stops being usable', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    await t.run('sync')
    t.server.connection = connectionAt({ status: 'reconnect_required' })
    await waitUntil(() => t.snapshot().activity === 'none')
    expect(t.snapshot().connection).toMatchObject({ status: 'reconnect_required' })
  })

  it('bears a few reads that fail while waiting, and gives up on many', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    await t.run('sync')
    for (let i = 0; i < 4; i += 1) t.reads.push(async () => failure())
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 + 1 })
    await waitUntil(() => t.snapshot().outcome?.kind === 'synced')

    const u = setup()
    u.server.connection = connectionAt()
    await u.run('refresh')
    await u.run('sync')
    for (let i = 0; i < 12; i += 1) u.reads.push(async () => failure('끊겼어요.'))
    await waitUntil(() => u.snapshot().activity === 'none')
    expect(u.snapshot()).toMatchObject({
      outcome: { kind: 'sync_unconfirmed' },
      error: { message: '끊겼어요.' }
    })
  })

  it('counts only failed reads in a row while waiting for an import', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    await t.run('sync')
    // Fourteen polls, within the wait for an import.
    for (let i = 0; i < 7; i += 1)
      t.reads.push(
        async () => failure(),
        async () => ({ ok: true, value: connectionAt() })
      )
    await waitUntil(() => t.reads.length === 0)
    expect(t.snapshot()).toMatchObject({ activity: 'syncing', error: null })
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 + 1 })
    await waitUntil(() => t.snapshot().outcome?.kind === 'synced')
  })

  it('takes one thing at a time', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    await t.run('sync')
    const syncs = t.count('sync:31')
    await t.run('sync')
    await t.run('connect')
    await t.run('disconnect')
    expect(t.count('sync:31')).toBe(syncs)
    expect(t.count('authorize')).toBe(0)
    expect(t.count('disconnect:31')).toBe(0)
    expect(t.snapshot().activity).toBe('syncing')
  })
})

describe('connecting', () => {
  it('asks the server where, opens exactly that address in the browser, and waits', async () => {
    const t = setup()
    const state = await t.run('connect')
    expect(t.opened).toEqual([CONSENT])
    expect(state).toMatchObject({ activity: 'authorizing', error: null, outcome: null })
    expect(state.authorizeUntil).toBe(T0 + 10 * MIN)
    expect(t.calls.slice(0, 2)).toEqual(['connection', 'authorize'])
  })

  it('judges when the address expires on the server’s clock', async () => {
    const t = setup({ serverOffsetMs: 2 * MIN })
    t.authorizations.push(async () => ({
      ok: true,
      value: { url: CONSENT, expiresAtServerMs: T0 + 2 * MIN + 10 * MIN }
    }))
    // The server is two minutes ahead, so that is ten minutes from now, not twelve.
    expect((await t.run('connect')).authorizeUntil).toBe(T0 + 10 * MIN)
  })

  it('does not wait longer than fifteen minutes, whatever the server says', async () => {
    const t = setup()
    t.authorizations.push(async () => ({
      ok: true,
      value: { url: CONSENT, expiresAtServerMs: T0 + 24 * 60 * MIN }
    }))
    expect((await t.run('connect')).authorizeUntil).toBe(T0 + 15 * MIN)
  })

  it('is connected when a newer connection appears, and then imports at once', async () => {
    const t = setup()
    await t.run('connect')
    t.server.connection = connectionAt({ connectedAtMs: T0 + 1000, lastSyncedAtMs: null })
    await waitUntil(() => t.count('sync:31') === 1)
    expect(t.snapshot()).toMatchObject({
      read: 'ready',
      connection: { status: 'active' },
      authorizeUntil: null
    })
    t.server.connection = connectionAt({ connectedAtMs: T0 + 1000, lastSyncedAtMs: T0 + 5000 })
    await waitUntil(() => t.snapshot().outcome?.kind === 'synced')
    expect(t.changed).toHaveBeenCalledTimes(1)
  })

  it('is connected again, over a connection that had to be made again, only by a newer one', async () => {
    const t = setup()
    t.server.connection = connectionAt({
      status: 'reconnect_required',
      connectedAtMs: T0 - 60 * MIN
    })
    await t.run('refresh')
    await t.run('connect')
    // Still the old connection: not done.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.snapshot().activity).toBe('authorizing')
    expect(t.count('sync:31')).toBe(0)
    t.server.connection = connectionAt({ connectedAtMs: T0 + 1000, lastSyncedAtMs: null })
    await waitUntil(() => t.count('sync:31') === 1)
  })

  it('does not take an old active connection for the one being made', async () => {
    const t = setup()
    t.server.connection = connectionAt({ connectedAtMs: T0 - 60 * MIN })
    await t.run('connect')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.snapshot().activity).toBe('authorizing')
    expect(t.count('sync:31')).toBe(0)
  })

  it('gives up when the address expires, and stops asking', async () => {
    const t = setup()
    t.authorizations.push(async () => ({
      ok: true,
      value: { url: CONSENT, expiresAtServerMs: T0 + 5000 }
    }))
    await t.run('connect')
    await waitUntil(() => t.snapshot().activity === 'none')
    expect(t.snapshot()).toMatchObject({
      outcome: { kind: 'connect_expired' },
      authorizeUntil: null
    })
    const reads = t.count('connection')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.count('connection')).toBe(reads)
  })

  it('stops waiting when the user cancels, and stops asking', async () => {
    const t = setup()
    await t.run('connect')
    const state = await t.run('cancel_connect')
    expect(state).toMatchObject({
      activity: 'none',
      authorizeUntil: null,
      outcome: { kind: 'connect_cancelled' }
    })
    const reads = t.count('connection')
    t.server.connection = connectionAt({ connectedAtMs: T0 + 1000, lastSyncedAtMs: null })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.count('connection')).toBe(reads)
    expect(t.count('sync:31')).toBe(0)
    // What the user finished in the browser anyway shows up on the next read.
    expect(await t.run('refresh')).toMatchObject({ connection: { status: 'active' } })
  })

  it('does nothing when cancelling while not waiting', async () => {
    const t = setup()
    expect(await t.run('cancel_connect')).toMatchObject({ activity: 'none', outcome: null })
  })

  it('will not open an address that is not Google’s', async () => {
    for (const url of [
      'https://evil.example/auth',
      'http://accounts.google.com/auth',
      'file:///etc/passwd',
      'javascript:alert(1)',
      ''
    ]) {
      const t = setup()
      t.authorizations.push(async () => ({ ok: true, value: { url, expiresAtServerMs: T0 + MIN } }))
      const state = await t.run('connect')
      expect(t.opened).toEqual([])
      expect(state).toMatchObject({ activity: 'none', error: { code: 'internal' } })
    }
  })

  it('says so when the browser cannot be opened, and does not wait', async () => {
    const t = setup()
    t.setOpenResult(false)
    const state = await t.run('connect')
    expect(state).toMatchObject({ activity: 'none', error: { code: 'unavailable' } })
    expect(state.error?.message).toContain('브라우저')
  })

  it('says so when the server cannot give an address, and opens nothing', async () => {
    const t = setup()
    t.authorizations.push(async () => failure('서버를 쓸 수 없어요.'))
    const state = await t.run('connect')
    expect(t.opened).toEqual([])
    expect(state).toMatchObject({ activity: 'none', error: { message: '서버를 쓸 수 없어요.' } })
  })

  it('bears a few failed reads while waiting, and gives up on many', async () => {
    const t = setup()
    await t.run('connect')
    for (let i = 0; i < 3; i += 1) t.reads.push(async () => failure())
    t.server.connection = connectionAt({ connectedAtMs: T0 + 1000, lastSyncedAtMs: null })
    await waitUntil(() => t.count('sync:31') === 1)

    const u = setup()
    await u.run('connect')
    for (let i = 0; i < 12; i += 1) u.reads.push(async () => failure('끊겼어요.'))
    await waitUntil(() => u.snapshot().activity === 'none')
    expect(u.snapshot()).toMatchObject({ error: { message: '끊겼어요.' }, authorizeUntil: null })
    expect(u.snapshot().outcome).toBeNull()
  })

  it('counts only failed reads in a row, so scattered ones do not end the wait', async () => {
    const t = setup()
    await t.run('connect')
    // Twenty reads, every other one failing: never more than one in a row.
    for (let i = 0; i < 10; i += 1)
      t.reads.push(
        async () => failure(),
        async () => ({ ok: true, value: null })
      )
    await waitUntil(() => t.reads.length === 0)
    expect(t.snapshot()).toMatchObject({ activity: 'authorizing', error: null })
    t.server.connection = connectionAt({ connectedAtMs: T0 + 1000, lastSyncedAtMs: null })
    await waitUntil(() => t.count('sync:31') === 1)
  })

  it('opens the browser once, however often it is asked', async () => {
    const t = setup()
    await Promise.all([t.run('connect'), t.run('connect')])
    await t.run('connect')
    expect(t.opened).toHaveLength(1)
    expect(t.count('authorize')).toBe(1)
  })
})

describe('disconnecting', () => {
  it('removes the connection, forgets it, and tells the calendar to read again', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    const state = await t.run('disconnect')
    expect(t.calls.at(-1)).toBe('disconnect:31')
    expect(state).toMatchObject({
      connection: null,
      activity: 'none',
      outcome: { kind: 'disconnected' },
      error: null
    })
    expect(t.changed).toHaveBeenCalledTimes(1)
  })

  it('ends the same when there was nothing left to remove', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    t.disconnects.push(async () => ({ kind: 'not_found' }))
    expect(await t.run('disconnect')).toMatchObject({
      connection: null,
      outcome: { kind: 'disconnected' }
    })
  })

  it('keeps the connection and says why when it fails, and can be tried again', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    t.disconnects.push(async () => ({
      kind: 'failed',
      error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
    }))
    const failed = await t.run('disconnect')
    expect(failed).toMatchObject({
      activity: 'none',
      connection: { status: 'active' },
      error: { message: '서버에 연결할 수 없습니다.' }
    })
    expect(t.changed).not.toHaveBeenCalled()
    expect(await t.run('disconnect')).toMatchObject({ connection: null, error: null })
  })

  it('does nothing when there is no connection', async () => {
    const t = setup()
    await t.run('refresh')
    await t.run('disconnect')
    expect(t.calls).toEqual(['connection'])
  })

  it('can remove a connection that has to be made again', async () => {
    const t = setup()
    t.server.connection = connectionAt({ status: 'reconnect_required' })
    await t.run('refresh')
    expect(await t.run('disconnect')).toMatchObject({ connection: null })
  })
})

describe('signing out and switching accounts', () => {
  it('forgets everything, and tells the window', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    await t.service.stop()
    expect(t.snapshot()).toMatchObject({
      read: 'idle',
      connection: null,
      activity: 'none',
      outcome: null,
      error: null
    })
    expect(t.events.at(-1)!.snapshot).toEqual(t.snapshot())
  })

  it('stops waiting for the consent at once, and cancels what was asked', async () => {
    const t = setup()
    await t.run('connect')
    const signal = t.signals.at(-1)!
    await t.service.stop()
    expect(signal.aborted).toBe(true)
    const reads = t.count('connection')
    t.server.connection = connectionAt({ connectedAtMs: T0 + 1000, lastSyncedAtMs: null })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.count('connection')).toBe(reads)
    expect(t.count('sync:31')).toBe(0)
  })

  it('stops waiting for an import, and does not tell the calendar about its end', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    await t.run('sync')
    await t.service.stop()
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 + 1000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.changed).not.toHaveBeenCalled()
    expect(t.snapshot()).toMatchObject({ activity: 'none', outcome: null })
  })

  it('does not show the earlier user’s connection to the next, nor apply what was in flight for them', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    const gate: { open: () => void } = { open: () => undefined }
    t.reads.push(
      () =>
        new Promise((resolve) => {
          gate.open = () => resolve({ ok: true, value: connectionAt({ lastSyncedAtMs: T0 + 1 }) })
        })
    )
    const pending = t.service.command('refresh')
    await waitUntil(() => t.snapshot().read === 'loading')
    t.service.start('u2')
    expect(t.events.at(-1)!.snapshot).toMatchObject({ read: 'idle', connection: null })
    gate.open()
    await pending
    expect(t.snapshot()).toMatchObject({ read: 'idle', connection: null })
  })

  it('can be used by the same user again after signing out and in', async () => {
    const t = setup()
    await t.service.stop()
    t.service.start('u1')
    expect(await t.run('refresh')).toMatchObject({ read: 'ready' })
  })

  it('does not start over when the same user is announced again', async () => {
    const t = setup()
    t.server.connection = connectionAt()
    await t.run('refresh')
    const before = t.snapshot()
    t.service.start('u1')
    expect(t.snapshot()).toEqual(before)
  })

  it('can be stopped when nothing was started', async () => {
    const fresh = new GoogleConnectionService({
      api: setup().service as never,
      now: Date.now,
      clock: { serverTimeAt: () => null },
      sleep: async () => undefined,
      openConsent: async () => true,
      onCalendarChanged: () => undefined
    })
    await expect(fresh.stop()).resolves.toBeUndefined()
  })
})

describe('what is published', () => {
  it('numbers each change, and every snapshot passes the contract', async () => {
    const t = setup()
    t.server.connection = connectionAt({ lastSyncedAtMs: null })
    await t.run('refresh')
    t.server.connection = connectionAt({ lastSyncedAtMs: T0 + 1 })
    await waitUntil(() => t.snapshot().outcome?.kind === 'synced')
    await t.run('connect')
    await t.run('cancel_connect')
    await t.run('disconnect')
    await t.service.stop()
    const revisions = t.events.map((event) => event.snapshot.revision)
    expect(revisions.length).toBeGreaterThan(6)
    expect(new Set(revisions).size).toBe(revisions.length)
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions)
    for (const event of t.events)
      expect(GoogleConnectionSnapshotSchema.safeParse(event.snapshot).success).toBe(true)
  })

  it('keeps going when a listener throws', async () => {
    const t = setup()
    t.service.subscribe(() => {
      throw new Error('listener')
    })
    const heard = vi.fn<(event: GoogleConnectionEvent) => void>()
    t.service.subscribe(heard)
    await t.run('refresh')
    expect(heard).toHaveBeenCalled()
    expect(t.snapshot().read).toBe('ready')
  })
})
