import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import type {
  GoogleAction,
  GoogleConnection,
  GoogleConnectionEvent,
  GoogleConnectionSnapshot,
  GoogleOutcome
} from '../../shared/contracts/google-connection'
import type { ServerClock } from '../connection/server-clock'
import type { GoogleConnectionApiPort, ServerConnection } from './google-connection-api'
import { isGoogleConsentUrl } from './google-url'

/** What the connection part of the calendar tab talks to; the window reaches it only through IPC. */
export interface GoogleConnectionPort {
  getSnapshot(): GoogleConnectionSnapshot
  subscribe(listener: (event: GoogleConnectionEvent) => void): Unsubscribe
  command(action: GoogleAction): Promise<Result<GoogleConnectionSnapshot>>
}

export interface GoogleConnectionServiceOptions {
  api: GoogleConnectionApiPort
  /** Wall-clock milliseconds. */
  now(): number
  /** Learned from the server's responses; the server's times are judged on its own clock. */
  clock: Pick<ServerClock, 'serverTimeAt'>
  /** Resolves after `ms`, or early when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** Hands the consent page to the user's browser; false when it could not be opened. */
  openConsent(url: string): Promise<boolean>
  /** What the calendar shows may have changed (an import finished, the copies were removed). */
  onCalendarChanged(): void
  /** How often the server is asked while waiting. */
  pollMs?: number
  /** How long to wait for an import to show as finished. */
  syncWaitMs?: number
  /** How old the last import may be before opening the tab starts another. */
  staleMs?: number
  /** The least time between two imports started by the app on its own. */
  autoRetryMs?: number
}

const DEFAULT_POLL_MS = 2_000
const DEFAULT_SYNC_WAIT_MS = 60_000
const DEFAULT_STALE_MS = 30 * 60_000
const DEFAULT_AUTO_RETRY_MS = 30 * 60_000
/** The consent address lives ten minutes; a server clock far off must not make the wait unbounded. */
const MAX_CONSENT_WAIT_MS = 15 * 60_000
/** Reads in a row that may fail while waiting before the wait is given up. */
const MAX_FAILED_READS = 5

const noUser = {
  ok: false,
  error: {
    code: 'authentication_required',
    message: '로그인한 뒤에 Google 캘린더를 연결할 수 있어요.'
  }
} as const

const toConnection = (server: ServerConnection | null): GoogleConnection | null =>
  server === null
    ? null
    : {
        status: server.status,
        connectedAt: server.connectedAtMs,
        lastSyncedAt: server.lastSyncedAtMs
      }

interface Context {
  signal: AbortSignal
  /** False once this work was replaced, cancelled, or the user signed out or changed. */
  alive(): boolean
}

/**
 * The Google Calendar connection of the signed-in user. It starts the consent in the browser and
 * learns that it finished by reading the connection from the server, starts imports and learns
 * that one finished by the server's `last_synced_at` moving (the server gives no result for an
 * import), and removes the connection. Nothing is assumed: an import is `synced` only when the
 * server says it has moved, a consent that never finishes expires, and what cannot be read is an
 * error, not "not connected". Only one thing happens at a time, and signing out or another
 * account signing in drops everything, including a wait in progress.
 */
export class GoogleConnectionService implements GoogleConnectionPort {
  private userId: string | null = null
  private revision = 0
  private run = 0
  private abort: AbortController | null = null
  private read: GoogleConnectionSnapshot['read'] = 'idle'
  private connection: GoogleConnection | null = null
  /** The server's ID for the connection; it is not shown to the window. */
  private serverId: string | null = null
  private activity: GoogleConnectionSnapshot['activity'] = 'none'
  private authorizeUntil: number | null = null
  private outcome: GoogleConnectionSnapshot['outcome'] = null
  private error: ClientError | null = null
  private lastSyncStartedAt: number | null = null
  private background: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(event: GoogleConnectionEvent) => void>()

  constructor(private readonly options: GoogleConnectionServiceOptions) {}

  start(userId: string): void {
    if (this.userId === userId) return
    const switching = this.userId !== null
    this.reset()
    this.userId = userId
    // Another account taking over: the window must not keep drawing the earlier one's connection.
    if (switching) this.changed()
  }

  async stop(): Promise<void> {
    if (this.userId === null) return
    const background = this.background
    this.reset()
    this.userId = null
    this.changed()
    await background
  }

  getSnapshot(): GoogleConnectionSnapshot {
    return {
      revision: this.revision,
      availability: 'ready',
      read: this.read,
      connection: this.connection,
      activity: this.activity,
      authorizeUntil: this.authorizeUntil,
      outcome: this.outcome,
      error: this.error
    }
  }

  subscribe(listener: (event: GoogleConnectionEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Does what was asked as far as the first answer, and returns the state then. */
  async command(action: GoogleAction): Promise<Result<GoogleConnectionSnapshot>> {
    if (this.userId === null) return noUser
    switch (action) {
      case 'refresh':
        await this.refresh()
        break
      case 'connect':
        await this.connect()
        break
      case 'cancel_connect':
        this.cancelConnect()
        break
      case 'sync':
        await this.sync()
        break
      case 'disconnect':
        await this.disconnect()
        break
    }
    return { ok: true, value: this.getSnapshot() }
  }

  // --- the actions -----------------------------------------------------------------------------

  /** Reads the connection, and starts an import when the last one is old. */
  private async refresh(): Promise<void> {
    if (this.busy()) return
    const context = this.begin()
    this.read = 'loading'
    this.error = null
    this.changed()
    const answer = await this.options.api.connection(context.signal)
    if (!context.alive()) return
    if (!answer.ok) return this.failRead(answer.error)
    this.adopt(answer.value)
    this.read = 'ready'
    this.changed()
    if (answer.value && this.worthSyncing(answer.value)) await this.startSync(context, answer.value)
  }

  private async connect(): Promise<void> {
    if (this.busy()) return
    const context = this.begin()
    this.error = null
    // What the server holds now, so that a connection made from here on can be told from it.
    const before = await this.options.api.connection(context.signal)
    if (!context.alive()) return
    const baseline = before.ok
      ? (before.value?.connectedAtMs ?? 0)
      : (this.connection?.connectedAt ?? 0)
    const authorization = await this.options.api.authorize(context.signal)
    if (!context.alive()) return
    if (!authorization.ok) return this.failAction(authorization.error)
    if (!isGoogleConsentUrl(authorization.value.url))
      return this.failAction({
        code: 'internal',
        message: '서버가 알려 준 연결 주소를 열 수 없어 연결을 시작하지 않았어요.'
      })
    const opened = await this.options.openConsent(authorization.value.url)
    if (!context.alive()) return
    if (!opened)
      return this.failAction({
        code: 'unavailable',
        message: '브라우저를 열지 못했어요. 잠시 후 다시 시도해 주세요.'
      })
    const serverNow = this.options.clock.serverTimeAt(this.options.now()) ?? this.options.now()
    const wait = Math.min(
      Math.max(authorization.value.expiresAtServerMs - serverNow, 0),
      MAX_CONSENT_WAIT_MS
    )
    this.activity = 'authorizing'
    this.authorizeUntil = this.options.now() + wait
    this.outcome = null
    this.changed()
    this.background = this.waitForConsent(context, baseline)
  }

  /** Stops waiting for the browser. The consent may still be finished there; the next read shows it. */
  private cancelConnect(): void {
    if (this.activity !== 'authorizing') return
    this.abort?.abort()
    this.run += 1
    this.finish('connect_cancelled')
  }

  /** An import the user asked for. The connection is read again first, for what it holds now. */
  private async sync(): Promise<void> {
    if (this.busy() || this.connection === null) return
    const context = this.begin()
    this.error = null
    this.read = 'loading'
    this.changed()
    const answer = await this.options.api.connection(context.signal)
    if (!context.alive()) return
    if (!answer.ok) return this.failRead(answer.error)
    this.adopt(answer.value)
    this.read = 'ready'
    if (answer.value === null) return this.changed()
    if (answer.value.status !== 'active') return this.changed()
    await this.startSync(context, answer.value)
  }

  private async disconnect(): Promise<void> {
    if (this.busy() || this.connection === null || this.serverId === null) return
    const context = this.begin()
    const id = this.serverId
    this.activity = 'disconnecting'
    this.error = null
    this.outcome = null
    this.changed()
    const result = await this.options.api.disconnect(id, context.signal)
    if (!context.alive()) return
    if (result.kind === 'failed') {
      // Removing twice is the same as once, so it can be tried again; what the server holds is unknown.
      this.activity = 'none'
      this.error = result.error
      return this.changed()
    }
    this.connection = null
    this.serverId = null
    this.finish('disconnected')
    this.options.onCalendarChanged()
  }

  // --- imports and waiting ---------------------------------------------------------------------

  private worthSyncing(server: ServerConnection): boolean {
    if (server.status !== 'active') return false
    const now = this.options.now()
    const staleMs = this.options.staleMs ?? DEFAULT_STALE_MS
    const retryMs = this.options.autoRetryMs ?? DEFAULT_AUTO_RETRY_MS
    if (this.lastSyncStartedAt !== null && now - this.lastSyncStartedAt < retryMs) return false
    if (server.lastSyncedAtMs === null) return true
    // The import time is the server's; how old it is is judged on the server's clock.
    const serverNow = this.options.clock.serverTimeAt(now) ?? now
    return serverNow - server.lastSyncedAtMs >= staleMs
  }

  /** Asks the server to import, then waits for it to show it did. */
  private async startSync(context: Context, server: ServerConnection): Promise<void> {
    this.activity = 'syncing'
    this.outcome = null
    this.error = null
    this.lastSyncStartedAt = this.options.now()
    this.changed()
    const started = await this.options.api.sync(server.id, context.signal)
    if (!context.alive()) return
    if (started.kind === 'queued') {
      this.background = this.waitForSync(context, server.lastSyncedAtMs)
      return
    }
    this.activity = 'none'
    if (started.kind === 'reconnect_required' && this.connection)
      this.connection = { ...this.connection, status: 'reconnect_required' }
    else if (started.kind === 'not_found') {
      this.connection = null
      this.serverId = null
    } else if (started.kind === 'failed') this.error = started.error
    this.changed()
  }

  /** An import has finished when the server's time of the last one has moved past what it was. */
  private async waitForSync(context: Context, before: number | null): Promise<void> {
    const deadline = this.options.now() + (this.options.syncWaitMs ?? DEFAULT_SYNC_WAIT_MS)
    let failed = 0
    while (context.alive()) {
      await this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS, context.signal)
      if (!context.alive()) return
      const answer = await this.options.api.connection(context.signal)
      if (!context.alive()) return
      if (answer.ok) {
        failed = 0
        this.adopt(answer.value)
        const now = answer.value
        // Removed, or no longer usable, from somewhere else: there is nothing left to wait for.
        if (now === null || now.status !== 'active') return this.finish(null)
        if (now.lastSyncedAtMs !== null && (before === null || now.lastSyncedAtMs > before)) {
          this.finish('synced')
          this.options.onCalendarChanged()
          return
        }
      } else if (++failed >= MAX_FAILED_READS) {
        this.activity = 'none'
        this.outcome = { kind: 'sync_unconfirmed', at: this.options.now() }
        this.error = answer.error
        return this.changed()
      }
      if (this.options.now() >= deadline) return this.finish('sync_unconfirmed')
    }
  }

  /** A connection exists, and is newer than the one before, when the consent has been given. */
  private async waitForConsent(context: Context, baseline: number): Promise<void> {
    const until = this.authorizeUntil ?? this.options.now()
    let failed = 0
    while (context.alive()) {
      await this.options.sleep(this.options.pollMs ?? DEFAULT_POLL_MS, context.signal)
      if (!context.alive()) return
      const answer = await this.options.api.connection(context.signal)
      if (!context.alive()) return
      if (answer.ok) {
        failed = 0
        const found = answer.value
        if (found && found.status === 'active' && found.connectedAtMs > baseline) {
          this.adopt(found)
          this.read = 'ready'
          this.authorizeUntil = null
          return this.startSync(context, found)
        }
      } else if (++failed >= MAX_FAILED_READS) {
        this.activity = 'none'
        this.authorizeUntil = null
        this.error = answer.error
        return this.changed()
      }
      if (this.options.now() >= until) return this.finish('connect_expired')
    }
  }

  // --- state -----------------------------------------------------------------------------------

  private busy(): boolean {
    return this.activity !== 'none' || this.read === 'loading'
  }

  /** Starts work that replaces what was going on, tied to this user. */
  private begin(): Context {
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    // Every start, stop and new piece of work changes `run`, so this covers a change of user too.
    const token = ++this.run
    return { signal: abort.signal, alive: () => token === this.run }
  }

  private adopt(server: ServerConnection | null): void {
    this.connection = toConnection(server)
    this.serverId = server?.id ?? null
  }

  private finish(kind: GoogleOutcome | null): void {
    this.activity = 'none'
    this.authorizeUntil = null
    this.outcome = kind === null ? null : { kind, at: this.options.now() }
    this.changed()
  }

  private failRead(error: ClientError): void {
    this.read = 'failed'
    this.error = error
    this.changed()
  }

  private failAction(error: ClientError): void {
    this.activity = 'none'
    this.error = error
    this.changed()
  }

  /** Back to nothing asked for: another user must never see this user's connection. */
  private reset(): void {
    this.abort?.abort()
    this.abort = null
    this.run += 1
    this.read = 'idle'
    this.connection = null
    this.serverId = null
    this.activity = 'none'
    this.authorizeUntil = null
    this.outcome = null
    this.error = null
    this.lastSyncStartedAt = null
  }

  private changed(): void {
    this.revision += 1
    const event: GoogleConnectionEvent = {
      type: 'google.state_changed',
      snapshot: this.getSnapshot()
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        /* A listener that fails must not stop the others. */
      }
    }
  }
}

/**
 * Used when there is no server to ask (no address, or the development sign-in stand-in, which the
 * server would not accept): the tab says so instead of offering a connection.
 */
export class UnavailableGoogleConnection implements GoogleConnectionPort {
  private readonly snapshot: GoogleConnectionSnapshot = {
    revision: 0,
    availability: 'unavailable',
    read: 'idle',
    connection: null,
    activity: 'none',
    authorizeUntil: null,
    outcome: null,
    error: null
  }

  getSnapshot(): GoogleConnectionSnapshot {
    return this.snapshot
  }

  subscribe(): Unsubscribe {
    return () => undefined
  }

  async command(): Promise<Result<GoogleConnectionSnapshot>> {
    return { ok: true, value: this.snapshot }
  }
}
