import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import { collectionIsOn } from '../../shared/contracts/collection'
import type {
  CollectionCommandRequest,
  CollectionEvent,
  CollectionFlag,
  CollectionSnapshot,
  CollectionValues
} from '../../shared/contracts/collection'
import type { CollectionConsent } from '../commands/activity'
import type {
  CollectionChange,
  CollectionConsentPort,
  CollectionSettingsApiPort
} from '../commands/collection-consent'

/** What the settings tab talks to; the window reaches it only through IPC. */
export interface CollectionSettingsPort {
  getSnapshot(): CollectionSnapshot
  subscribe(listener: (event: CollectionEvent) => void): Unsubscribe
  command(request: CollectionCommandRequest): Promise<Result<CollectionSnapshot>>
}

export interface CollectionSettingsServiceOptions {
  api: CollectionSettingsApiPort
  /** Wall-clock milliseconds. */
  now(): number
  /** What is collected may now differ: whoever holds a consent read earlier must read it again. */
  onChanged(): void
}

const noUser = {
  ok: false,
  error: {
    code: 'authentication_required',
    message: '로그인한 뒤에 활동 기록 설정을 바꿀 수 있어요.'
  }
} as const

const NOT_STOPPED: CollectionValues = { activity: false, external: false }

interface Context {
  signal: AbortSignal
  /** False once this work was replaced, cancelled, or the user signed out or changed. */
  alive(): boolean
}

/**
 * The user's consent to collect app activity. A withdrawal is applied on this computer first:
 * nothing more is collected or reported from then on, and then the server is told. Turning
 * something on happens only when the server has said so. What the server holds is the basis: a
 * withdrawal it did not take stays in force on this computer for as long as the app runs, and is
 * shown as not applied at the server, so the user can send it again. Only one change happens at a
 * time, none is sent twice by the app, and signing out or another account signing in drops it all.
 *
 * It is also what the commands read the consent through, so a withdrawal reaches them at once.
 */
export class CollectionSettingsService implements CollectionSettingsPort, CollectionConsentPort {
  private userId: string | null = null
  private revision = 0
  private run = 0
  private abort: AbortController | null = null
  private read_: CollectionSnapshot['read'] = 'idle'
  private settings: CollectionValues | null = null
  private stopped: CollectionValues = NOT_STOPPED
  private saving = false
  private outcome: CollectionSnapshot['outcome'] = null
  private error: ClientError | null = null
  private readonly listeners = new Set<(event: CollectionEvent) => void>()

  constructor(private readonly options: CollectionSettingsServiceOptions) {}

  start(userId: string): void {
    if (this.userId === userId) return
    const switching = this.userId !== null
    this.reset()
    this.userId = userId
    // Another account taking over: the window must not keep drawing the earlier one's settings.
    if (switching) this.changed()
  }

  async stop(): Promise<void> {
    if (this.userId === null) return
    this.reset()
    this.userId = null
    this.changed()
  }

  getSnapshot(): CollectionSnapshot {
    return {
      revision: this.revision,
      availability: 'ready',
      read: this.read_,
      settings: this.settings,
      stopped: this.stopped,
      saving: this.saving,
      outcome: this.outcome,
      error: this.error
    }
  }

  subscribe(listener: (event: CollectionEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async command(request: CollectionCommandRequest): Promise<Result<CollectionSnapshot>> {
    if (this.userId === null) return noUser
    if (request.action === 'refresh') await this.refresh()
    else await this.set(request.flag, request.on)
    return { ok: true, value: this.getSnapshot() }
  }

  /**
   * The consent the commands go by: what the server holds, minus what was withdrawn here. A server
   * that cannot be asked gives no consent at all, so nothing is collected on a guess.
   */
  async read(signal?: AbortSignal): Promise<Result<CollectionConsent>> {
    const answer = await this.options.api.read(signal)
    if (!answer.ok) return answer
    const server = answer.value
    const activityEnabled = server.activityEnabled && !this.stopped.activity
    return {
      ok: true,
      value: {
        activityEnabled,
        externalEnabled: activityEnabled && server.externalEnabled && !this.stopped.external,
        revision: server.revision
      }
    }
  }

  // --- the actions -----------------------------------------------------------------------------

  private async refresh(): Promise<void> {
    if (this.busy()) return
    const context = this.begin()
    this.outcome = null
    this.read_ = 'loading'
    this.error = null
    this.changed()
    await this.readSettings(context)
  }

  private async set(flag: CollectionFlag, on: boolean): Promise<void> {
    if (this.busy()) return
    // What is known must be what the server holds: a switch is never flipped from a guess.
    if (this.settings === null)
      return this.refuse(flag, on, {
        code: 'unavailable',
        message: '현재 설정을 읽은 뒤에 바꿀 수 있어요. 새로 고침해 주세요.'
      })
    if (flag === 'external' && on && !collectionIsOn('activity', this.settings, this.stopped))
      return this.refuse(flag, on, {
        code: 'invalid_input',
        message: '자비스 활동 수집을 먼저 켜야 외부 앱 활동 수집을 켤 수 있어요.'
      })
    const context = this.begin()
    this.saving = true
    this.outcome = null
    // Turning activity off takes external with it; external is never left on without activity.
    const change: CollectionChange =
      flag === 'activity'
        ? on
          ? { activity: true }
          : { activity: false, external: false }
        : { external: on }
    if (!on) {
      // A withdrawal holds here from now on, whatever the server says to it.
      this.stopped =
        flag === 'activity'
          ? { activity: true, external: true }
          : { ...this.stopped, external: true }
      this.options.onChanged()
    }
    this.changed()
    const result = await this.options.api.change(change, context.signal)
    if (!context.alive()) return
    if (result.kind === 'done') return this.adopt(result.value, flag, on)
    this.saving = false
    if (result.kind === 'unknown') {
      // The server may have taken it. Reading shows which; what was withdrawn stays withdrawn here until it says off.
      this.outcome = { kind: 'unconfirmed', flag, on, at: this.options.now(), error: result.error }
      this.read_ = 'loading'
      this.changed()
      await this.readSettings(context)
      return
    }
    this.outcome = { kind: 'failed', flag, on, at: this.options.now(), error: result.error }
    // A refused turning-on changed nothing; a refused withdrawal is still in force here.
    this.changed()
  }

  // --- reading and state -----------------------------------------------------------------------

  private async readSettings(context: Context): Promise<void> {
    const answer = await this.options.api.read(context.signal)
    if (!context.alive()) return
    if (!answer.ok) {
      this.read_ = 'failed'
      this.error = answer.error
      return this.changed()
    }
    this.read_ = 'ready'
    this.error = null
    this.take(answer.value)
    this.changed()
  }

  /** What the server answered to a change: its values are the ones shown, and what it confirmed off is no longer only a local stop. */
  private adopt(value: CollectionConsent, flag: CollectionFlag, on: boolean): void {
    this.saving = false
    this.read_ = 'ready'
    this.error = null
    this.take(value)
    // Turning on is confirmed: it is no longer held back here.
    if (on) this.stopped = { ...this.stopped, [flag]: false }
    this.outcome = { kind: 'saved', flag, on, at: this.options.now(), error: null }
    this.options.onChanged()
    this.changed()
  }

  /** The server's values replace what was known; a flag it shows off no longer needs a local stop. */
  private take(value: CollectionConsent): void {
    this.settings = { activity: value.activityEnabled, external: value.externalEnabled }
    this.stopped = {
      activity: this.stopped.activity && value.activityEnabled,
      external: this.stopped.external && value.externalEnabled
    }
  }

  private busy(): boolean {
    return this.saving || this.read_ === 'loading'
  }

  /** A change that was not made at all: only the line of text changes. */
  private refuse(flag: CollectionFlag, on: boolean, error: ClientError): void {
    this.outcome = { kind: 'failed', flag, on, at: this.options.now(), error }
    this.changed()
  }

  private begin(): Context {
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    // Every start, stop and new piece of work changes `run`, so this covers a change of user too.
    const token = ++this.run
    return { signal: abort.signal, alive: () => token === this.run }
  }

  /** Back to nothing asked for: another user must never see this user's settings, nor be held to their stop. */
  private reset(): void {
    this.abort?.abort()
    this.abort = null
    this.run += 1
    this.read_ = 'idle'
    this.settings = null
    this.stopped = NOT_STOPPED
    this.saving = false
    this.outcome = null
    this.error = null
  }

  private changed(): void {
    this.revision += 1
    const event: CollectionEvent = {
      type: 'collection.state_changed',
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
 * server would not accept): the tab says so instead of offering anything.
 */
export class UnavailableCollectionSettings implements CollectionSettingsPort {
  private readonly snapshot: CollectionSnapshot = {
    revision: 0,
    availability: 'unavailable',
    read: 'idle',
    settings: null,
    stopped: NOT_STOPPED,
    saving: false,
    outcome: null,
    error: null
  }

  getSnapshot(): CollectionSnapshot {
    return this.snapshot
  }

  subscribe(): Unsubscribe {
    return () => undefined
  }

  async command(): Promise<Result<CollectionSnapshot>> {
    return { ok: true, value: this.snapshot }
  }
}
