import type { FakeCalendarStore } from './fake-calendar-store'

/**
 * The Google Calendar connection part of the Jarvis server, following the real one as read from its
 * code (app/api/routes/calendar_connections.py) on 2026-10-22:
 *
 * - the consent finishes between the browser and the server; the app is never told
 * - there is one connection per user; connecting again overwrites it
 * - an import is accepted (202) and done in the background; nothing says when it is done, and one
 *   that fails (the server keeps no refreshed token) changes nothing and says nothing
 * - disconnecting removes the credentials and the imported events, and doing it again is no error
 */
export interface StoredConnection {
  connection_id: number
  status: 'connected' | 'reconnect_required' | 'disconnected'
  connected_at: number
  last_synced_at: number | null
}

export type SyncMode = 'works' | 'silent' | 'slow'

export class FakeGoogleConnections {
  row: StoredConnection | null = null
  /** How an import goes: it finishes, it never does and nothing says so, or it finishes after `syncDelayMs`. */
  syncMode: SyncMode = 'works'
  syncDelayMs = 40
  /** How long a consent address lives. */
  consentLifetimeMs = 10 * 60_000
  /** What an import brings from Google. */
  googleEvents: { title: string; start_date: string; end_date: string }[] = [
    { title: '구글 일정', start_date: '2026-10-22', end_date: '2026-10-23' }
  ]
  readonly authorizations: number[] = []
  readonly syncs: number[] = []
  readonly disconnects: number[] = []
  /** Statuses for the next reads of the connection (consumed in order), or 'ok'. */
  readFaults: (number | 'ok')[] = []
  private nextId = 31
  private timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly store: FakeCalendarStore) {}

  /** What happens at the server when the user agrees in the browser and Google calls it back. */
  completeConsent(at = Date.now()): void {
    if (this.row) {
      Object.assign(this.row, { status: 'connected', connected_at: at })
      return
    }
    this.row = {
      connection_id: this.nextId++,
      status: 'connected',
      connected_at: at,
      last_synced_at: null
    }
  }

  /** The server can no longer use the stored credentials. */
  expireCredentials(): void {
    if (this.row) this.row.status = 'reconnect_required'
  }

  list(naive: boolean) {
    const time = (ms: number | null) => {
      if (ms === null) return null
      const iso = new Date(ms).toISOString()
      return naive ? iso.replace('Z', '') : iso
    }
    const rows = this.row && this.row.status !== 'disconnected' ? [this.row] : []
    return {
      items: rows.map((row) => ({
        connection_id: row.connection_id,
        provider: 'google',
        status: row.status === 'connected' ? 'active' : 'reconnect_required',
        connected_at: time(row.connected_at),
        last_synced_at: time(row.last_synced_at)
      }))
    }
  }

  authorize(naive: boolean) {
    this.authorizations.push(Date.now())
    const expires = new Date(Date.now() + this.consentLifetimeMs).toISOString()
    return {
      authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=fake-state',
      expires_at: naive ? expires.replace('Z', '') : expires
    }
  }

  sync(id: number): { status: number; payload: unknown } {
    if (!this.row || this.row.connection_id !== id || this.row.status === 'disconnected')
      return { status: 404, payload: { error: { code: 'RESOURCE_NOT_FOUND', message: 'x' } } }
    if (this.row.status === 'reconnect_required')
      return {
        status: 409,
        payload: { error: { code: 'CALENDAR_RECONNECT_REQUIRED', message: 'x' } }
      }
    this.syncs.push(id)
    if (this.syncMode !== 'silent') {
      const timer = setTimeout(
        () => {
          this.timers.delete(timer)
          this.importNow()
        },
        this.syncMode === 'slow' ? this.syncDelayMs : 0
      )
      this.timers.add(timer)
    }
    return { status: 202, payload: { sync_id: 'sync_fake', status: 'queued' } }
  }

  disconnect(id: number): { status: number; payload?: unknown } {
    if (!this.row || this.row.connection_id !== id)
      return { status: 404, payload: { error: { code: 'RESOURCE_NOT_FOUND', message: 'x' } } }
    this.disconnects.push(id)
    for (let index = this.store.events.length - 1; index >= 0; index -= 1)
      if (this.store.events[index]!.source === 'google') this.store.events.splice(index, 1)
    this.row.status = 'disconnected'
    return { status: 204 }
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  private importNow(): void {
    if (!this.row || this.row.status !== 'connected') return
    for (const event of this.googleEvents)
      if (
        !this.store.events.some(
          (stored) => stored.source === 'google' && stored.title === event.title
        )
      )
        this.store.add({ ...event, source: 'google', is_all_day: true })
    this.row.last_synced_at = Math.max(Date.now(), (this.row.last_synced_at ?? 0) + 1)
  }
}
