import type { ClientError, Result, Unsubscribe } from '../../shared/contracts/common'
import { trimmedDeviceName } from '../../shared/contracts/devices'
import type {
  AppItem,
  DeviceCommandRequest,
  DeviceItem,
  DeviceManagementEvent,
  DeviceManagementSnapshot,
  DeviceOutcome,
  OutcomeSubject
} from '../../shared/contracts/devices'
import type { ServerClock } from '../connection/server-clock'
import type {
  Change,
  DeviceManagementApiPort,
  ServerApp,
  ServerDevice
} from './device-management-api'

/** What the settings tab talks to; the window reaches it only through IPC. */
export interface DeviceManagementPort {
  getSnapshot(): DeviceManagementSnapshot
  subscribe(listener: (event: DeviceManagementEvent) => void): Unsubscribe
  command(request: DeviceCommandRequest): Promise<Result<DeviceManagementSnapshot>>
}

export interface DeviceManagementServiceOptions {
  api: DeviceManagementApiPort
  /** Wall-clock milliseconds. */
  now(): number
  /** Learned from the server's responses; the server's times are judged on its own clock. */
  clock: Pick<ServerClock, 'serverTimeAt'>
  /** Ends this computer's session the way a sign-out does: blocking first, then cleaning up. */
  endLocalSession(): Promise<unknown>
  /** How many pages of apps are read at most. */
  maxAppPages?: number
}

/** Seen this recently counts as online (the server's own hint). */
const ONLINE_WITHIN_MS = 60_000
const DEFAULT_MAX_APP_PAGES = 5

const noUser = {
  ok: false,
  error: {
    code: 'authentication_required',
    message: '로그인한 뒤에 기기를 관리할 수 있어요.'
  }
} as const

const UNCONFIRMED: ClientError = {
  code: 'unavailable',
  message: '서버의 응답을 받지 못해 결과를 확인하지 못했어요. 목록을 다시 읽어 확인해 주세요.'
}

interface Context {
  signal: AbortSignal
  /** False once this work was replaced, cancelled, or the user signed out or changed. */
  alive(): boolean
}

/**
 * The devices of the signed-in account and the apps of this device. It shows only what the server
 * has said: a change reaches the list when the server confirmed it, a change whose answer was lost
 * is reported as unconfirmed and the list is read again, and what cannot be read is an error, not
 * an empty list. Only one change happens at a time, none is sent twice, and signing out or another
 * account signing in drops everything, including answers still on their way.
 */
export class DeviceManagementService implements DeviceManagementPort {
  private userId: string | null = null
  private revision = 0
  private run = 0
  private abort: AbortController | null = null
  private devices: DeviceManagementSnapshot['devices'] = { read: 'idle', items: [], error: null }
  private apps: DeviceManagementSnapshot['apps'] = {
    read: 'idle',
    items: [],
    truncated: false,
    error: null
  }
  private activity: DeviceManagementSnapshot['activity'] = 'none'
  private target: string | null = null
  private outcome: DeviceManagementSnapshot['outcome'] = null
  private readonly listeners = new Set<(event: DeviceManagementEvent) => void>()

  constructor(private readonly options: DeviceManagementServiceOptions) {}

  start(userId: string): void {
    if (this.userId === userId) return
    const switching = this.userId !== null
    this.reset()
    this.userId = userId
    // Another account taking over: the window must not keep drawing the earlier one's devices.
    if (switching) this.changed()
  }

  async stop(): Promise<void> {
    if (this.userId === null) return
    this.reset()
    this.userId = null
    this.changed()
  }

  getSnapshot(): DeviceManagementSnapshot {
    return {
      revision: this.revision,
      availability: 'ready',
      devices: this.devices,
      apps: this.apps,
      activity: this.activity,
      target: this.target,
      outcome: this.outcome
    }
  }

  subscribe(listener: (event: DeviceManagementEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Does what was asked as far as the server's answer, and returns the state then. */
  async command(request: DeviceCommandRequest): Promise<Result<DeviceManagementSnapshot>> {
    if (this.userId === null) return noUser
    switch (request.action) {
      case 'refresh':
        await this.refresh()
        break
      case 'rename_device':
        await this.rename(request.deviceId, request.name)
        break
      case 'sign_out_device':
        await this.signOutDevice(request.deviceId)
        break
      case 'sign_out_all':
        await this.signOutAll()
        break
      case 'set_app_allowed':
        await this.setAppAllowed(request.appId, request.allowed)
        break
    }
    return { ok: true, value: this.getSnapshot() }
  }

  // --- the actions -----------------------------------------------------------------------------

  /** Reads both lists again. */
  private async refresh(): Promise<void> {
    if (this.busy()) return
    const context = this.begin()
    this.outcome = null
    this.devices = { ...this.devices, read: 'loading', error: null }
    this.apps = { ...this.apps, read: 'loading', error: null }
    this.changed()
    await Promise.all([this.readDevices(context), this.readApps(context)])
  }

  private async rename(deviceId: string, requested: string): Promise<void> {
    if (this.busy()) return
    const name = trimmedDeviceName(requested)
    if (!this.devices.items.some((device) => device.id === deviceId))
      return this.refuse(
        'device',
        'not_found',
        '이 기기를 목록에서 찾을 수 없어요. 목록을 다시 읽어 주세요.'
      )
    const context = this.startChange('renaming', deviceId)
    const result = await this.options.api.rename(deviceId, name, context.signal)
    if (!context.alive()) return
    if (result.kind === 'done') {
      // The name the server holds, not the one that was asked for.
      this.devices = {
        ...this.devices,
        items: this.devices.items.map((device) =>
          device.id === deviceId ? { ...device, name: result.value.name } : device
        )
      }
      return this.finish('renamed')
    }
    await this.settle(context, result, 'devices')
  }

  private async signOutDevice(deviceId: string): Promise<void> {
    if (this.busy()) return
    const device = this.devices.items.find((item) => item.id === deviceId)
    if (!device)
      return this.refuse(
        'device',
        'not_found',
        '이 기기를 목록에서 찾을 수 없어요. 목록을 다시 읽어 주세요.'
      )
    // This computer is signed out the way every sign-out is, not through the server's list.
    if (device.current)
      return this.refuse(
        'device',
        'invalid_input',
        '이 기기는 여기서 로그아웃할 수 없어요. 계정의 로그아웃을 사용해 주세요.'
      )
    const context = this.startChange('signing_out_device', deviceId)
    const result = await this.options.api.signOutDevice(deviceId, context.signal)
    if (!context.alive()) return
    if (result.kind === 'done') return this.finish('device_signed_out')
    await this.settle(context, result, 'devices')
  }

  /**
   * Ends every session of the account. This computer signs out only after the server said it
   * ended them; until then, and when it says no, the user stays signed in.
   */
  private async signOutAll(): Promise<void> {
    if (this.busy()) return
    const context = this.startChange('signing_out_all', null)
    const result = await this.options.api.signOutAll(context.signal)
    if (!context.alive()) return
    if (result.kind === 'done') {
      // The session this computer holds has just ended at the server too. Signing out here stops
      // this service, so nothing after the call is drawn.
      await this.options.endLocalSession()
      if (!context.alive()) return
      return this.finish(null)
    }
    if (result.kind === 'not_found')
      return this.fail({
        code: 'not_found',
        message: '모든 기기에서 로그아웃하지 못했어요. 잠시 후 다시 시도해 주세요.'
      })
    this.fail(result.error, result.kind === 'unknown')
  }

  private async setAppAllowed(appId: string, allowed: boolean): Promise<void> {
    if (this.busy()) return
    if (!this.apps.items.some((app) => app.id === appId))
      return this.refuse(
        'app',
        'not_found',
        '이 앱을 목록에서 찾을 수 없어요. 목록을 다시 읽어 주세요.'
      )
    const context = this.startChange('setting_app', appId)
    const result = await this.options.api.setAppAllowed(appId, allowed, context.signal)
    if (!context.alive()) return
    if (result.kind === 'done') {
      // The value the server holds, not the one that was asked for.
      const now = result.value.allowed
      this.apps = {
        ...this.apps,
        items: this.apps.items.map((app) => (app.id === appId ? { ...app, allowed: now } : app))
      }
      return this.finish(now ? 'app_allowed' : 'app_blocked')
    }
    await this.settle(context, result, 'apps')
  }

  // --- reading ---------------------------------------------------------------------------------

  private async readDevices(context: Context): Promise<void> {
    const answer = await this.options.api.devices(context.signal)
    if (!context.alive()) return
    if (!answer.ok) {
      // What was shown before stays, marked as not current by the failed read.
      this.devices = { ...this.devices, read: 'failed', error: answer.error }
      return this.changed()
    }
    const serverNow = this.options.clock.serverTimeAt(this.options.now()) ?? this.options.now()
    this.devices = {
      read: 'ready',
      items: answer.value.map((device) => toDevice(device, serverNow)),
      error: null
    }
    this.changed()
  }

  private async readApps(context: Context): Promise<void> {
    const items: AppItem[] = []
    let cursor: string | null = null
    let truncated = false
    const maxPages = this.options.maxAppPages ?? DEFAULT_MAX_APP_PAGES
    for (let page = 0; ; page += 1) {
      const answer = await this.options.api.apps(cursor, context.signal)
      if (!context.alive()) return
      if (!answer.ok) {
        // A partly read list is never presented as the whole one.
        this.apps = { ...this.apps, read: 'failed', error: answer.error }
        return this.changed()
      }
      items.push(...answer.value.items.map(toApp))
      cursor = answer.value.next
      if (cursor === null) {
        truncated = answer.value.more
        break
      }
      if (page + 1 >= maxPages) {
        truncated = true
        break
      }
    }
    this.apps = { read: 'ready', items, truncated, error: null }
    this.changed()
  }

  // --- state -----------------------------------------------------------------------------------

  private busy(): boolean {
    return (
      this.activity !== 'none' || this.devices.read === 'loading' || this.apps.read === 'loading'
    )
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

  /** Begins a change: what it is about is shown while it runs. */
  private startChange(
    activity: DeviceManagementSnapshot['activity'],
    target: string | null
  ): Context {
    const context = this.begin()
    this.activity = activity
    this.target = target
    this.outcome = null
    this.changed()
    return context
  }

  /** An answer that is not a success: the list the change was about is read again when the outcome is unknown or the thing is gone. */
  private async settle(
    context: Context,
    result: Exclude<Change<unknown>, { kind: 'done' }>,
    list: 'devices' | 'apps'
  ): Promise<void> {
    if (result.kind === 'rejected') return this.fail(result.error, false)
    this.fail(
      result.kind === 'not_found' ? null : result.error,
      result.kind === 'unknown',
      result.kind === 'not_found'
    )
    // The list is read again so it shows what the server holds now.
    if (list === 'devices') {
      this.devices = { ...this.devices, read: 'loading', error: null }
      this.changed()
      await this.readDevices(context)
    } else {
      this.apps = { ...this.apps, read: 'loading', error: null }
      this.changed()
      await this.readApps(context)
    }
  }

  /** A request that was not made at all: nothing is sent and nothing changes but the line of text. */
  private refuse(subject: OutcomeSubject, code: ClientError['code'], message: string): void {
    this.outcome = { kind: 'failed', subject, at: this.options.now(), error: { code, message } }
    this.changed()
  }

  private finish(kind: DeviceOutcome | null): void {
    const subject = subjectOf(this.activity)
    this.activity = 'none'
    this.target = null
    this.outcome = kind === null ? null : { kind, subject, at: this.options.now(), error: null }
    this.changed()
  }

  /** The change failed. `unknown`: it may have been made. `gone`: what it was about was not there. */
  private fail(error: ClientError | null, unknown = false, gone = false): void {
    const kind: DeviceOutcome = gone ? goneKind(this.activity) : unknown ? 'unconfirmed' : 'failed'
    const subject = subjectOf(this.activity)
    this.activity = 'none'
    this.target = null
    this.outcome = {
      kind,
      subject,
      at: this.options.now(),
      error: gone ? null : unknown ? UNCONFIRMED : error
    }
    this.changed()
  }

  /** Back to nothing asked for: another user must never see this user's devices. */
  private reset(): void {
    this.abort?.abort()
    this.abort = null
    this.run += 1
    this.devices = { read: 'idle', items: [], error: null }
    this.apps = { read: 'idle', items: [], truncated: false, error: null }
    this.activity = 'none'
    this.target = null
    this.outcome = null
  }

  private changed(): void {
    this.revision += 1
    const event: DeviceManagementEvent = {
      type: 'devices.state_changed',
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

function subjectOf(activity: DeviceManagementSnapshot['activity']): OutcomeSubject {
  return activity === 'setting_app' ? 'app' : activity === 'signing_out_all' ? 'account' : 'device'
}

function goneKind(activity: DeviceManagementSnapshot['activity']): DeviceOutcome {
  return activity === 'setting_app' ? 'app_gone' : 'device_gone'
}

function toDevice(device: ServerDevice, serverNow: number): DeviceItem {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    clientVersion: device.clientVersion,
    lastSeenAt: device.lastSeenAtMs,
    current: device.current,
    online:
      device.current ||
      (device.lastSeenAtMs !== null && serverNow - device.lastSeenAtMs <= ONLINE_WITHIN_MS)
  }
}

function toApp(app: ServerApp): AppItem {
  return { id: app.id, appCode: app.appCode, name: app.name, allowed: app.allowed }
}

/**
 * Used when there is no server to ask (no address, or the development sign-in stand-in, which the
 * server would not accept): the tab says so instead of offering anything.
 */
export class UnavailableDeviceManagement implements DeviceManagementPort {
  private readonly snapshot: DeviceManagementSnapshot = {
    revision: 0,
    availability: 'unavailable',
    devices: { read: 'idle', items: [], error: null },
    apps: { read: 'idle', items: [], truncated: false, error: null },
    activity: 'none',
    target: null,
    outcome: null
  }

  getSnapshot(): DeviceManagementSnapshot {
    return this.snapshot
  }

  subscribe(): Unsubscribe {
    return () => undefined
  }

  async command(): Promise<Result<DeviceManagementSnapshot>> {
    return { ok: true, value: this.snapshot }
  }
}
