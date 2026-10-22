import type { Result } from '../../shared/contracts/common'
import type {
  AppDescriptor,
  AppObservation,
  TaskSwitchObservation,
  UrlObservation,
  WindowReference
} from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'
import { failure, handOffUrl, observed, parseJson, pollUntil } from './app-control-support'
import type { PollClock } from './app-control-support'
import type { CommandRunner } from './command-runner'
import type { AppControlPort, InputExecutionOptions } from './ports'

const OSASCRIPT = '/usr/bin/osascript'
const OPEN = '/usr/bin/open'

/**
 * Installed apps. Foundation reads Info.plist in both XML and binary form and needs no
 * Automation (Apple Events) permission. The script takes no input, so nothing can be injected.
 */
const INSTALLED_APPS_SCRIPT = `
ObjC.import('Foundation')
function run() {
  var fm = $.NSFileManager.defaultManager
  var home = $.NSHomeDirectory().js
  var roots = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', home + '/Applications']
  var out = []
  for (var r = 0; r < roots.length; r++) {
    var names = fm.contentsOfDirectoryAtPathError(roots[r], $())
    if (!names || names.isNil()) continue
    for (var i = 0; i < names.count; i++) {
      var name = ObjC.unwrap(names.objectAtIndex(i))
      if (name.slice(-4) !== '.app') continue
      var info = $.NSDictionary.dictionaryWithContentsOfFile(roots[r] + '/' + name + '/Contents/Info.plist')
      if (!info || info.isNil()) continue
      var id = ObjC.unwrap(info.objectForKey('CFBundleIdentifier'))
      if (!id) continue
      var display = ObjC.unwrap(info.objectForKey('CFBundleDisplayName')) || ObjC.unwrap(info.objectForKey('CFBundleName')) || name.slice(0, -4)
      out.push({ id: id, name: display })
    }
  }
  return JSON.stringify(out)
}
`

/** Running regular apps and the frontmost one. Also needs no special permission. */
const RUNNING_APPS_SCRIPT = `
ObjC.import('AppKit')
function run() {
  var ws = $.NSWorkspace.sharedWorkspace
  var apps = ws.runningApplications
  var out = []
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i)
    if (app.activationPolicy !== $.NSApplicationActivationPolicyRegular) continue
    var id = ObjC.unwrap(app.bundleIdentifier)
    if (!id) continue
    out.push({ id: id, name: ObjC.unwrap(app.localizedName), pid: app.processIdentifier })
  }
  var front = ws.frontmostApplication
  return JSON.stringify({
    running: out,
    front: front && !front.isNil() ? { id: ObjC.unwrap(front.bundleIdentifier), pid: front.processIdentifier } : null
  })
}
`

/** Bundle identifiers: reverse-DNS style. Rejecting anything else keeps option-like input out of `open`. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/

interface RunningSnapshot {
  running: { id: string; name: string; pid: number }[]
  front: { id: string; pid: number } | null
}

interface MacAppControlOptions extends PollClock {
  runner: CommandRunner
  /** Hands a validated URL to the default browser (Electron `shell.openExternal`). */
  openUrl(url: string): Promise<void>
  /** This process, so Jarvis itself is never reported as the app to return to. */
  selfPid: number
  /** Lifetime of the installed-app scan. Running state is always read fresh. */
  catalogTtlMs?: number
  launchConfirmMs?: number
  activateConfirmMs?: number
}

/**
 * App control for macOS. App IDs are bundle identifiers, resolved only against apps the OS reports
 * as installed or running. Commands use fixed executables and argument arrays, never a shell.
 */
export class MacAppControl implements AppControlPort {
  private installed: { at: number; apps: { id: string; name: string }[] } | null = null

  constructor(private readonly options: MacAppControlOptions) {}

  async list(options?: LocalExecutionOptions): Promise<Result<AppDescriptor[]>> {
    const [installed, running] = await Promise.all([
      this.installedApps(options),
      this.runningApps(options)
    ])
    if (!installed.ok) return installed
    if (!running.ok) return running
    const runningIds = new Set(running.value.running.map((app) => app.id))
    const byId = new Map<string, AppDescriptor>()
    for (const app of installed.value)
      byId.set(app.id, {
        appId: app.id,
        displayName: app.name,
        state: runningIds.has(app.id) ? 'running' : 'stopped'
      })
    // Running apps outside the scanned folders (for example launched from elsewhere) still count.
    for (const app of running.value.running)
      if (!byId.has(app.id))
        byId.set(app.id, { appId: app.id, displayName: app.name, state: 'running' })
    return {
      ok: true,
      value: [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
    }
  }

  async launch(appId: string, options?: LocalExecutionOptions): Promise<Result<AppObservation>> {
    const checked = await this.resolve(appId, options)
    if (!checked.ok) return checked
    // "Open" an app that is already running means bringing it to the front, not leaving it as it is.
    if (checked.value.running) return this.bringForward(appId, options)

    const opened = await this.open(appId, options)
    if (!opened.ok) return opened
    // `open` only reports that the request was accepted; confirm the process really appeared.
    const confirmed = await pollUntil(
      async () => {
        const snapshot = await this.runningApps(options)
        return snapshot.ok && snapshot.value.running.some((app) => app.id === appId)
      },
      this.options.launchConfirmMs ?? 5_000,
      this.options,
      options
    )
    return observed(appId, confirmed ? 'confirmed' : 'dispatched')
  }

  async activate(appId: string, options?: LocalExecutionOptions): Promise<Result<AppObservation>> {
    const checked = await this.resolve(appId, options)
    if (!checked.ok) return checked
    if (!checked.value.running)
      return failure('not_found', '앱이 실행 중이 아니라서 전환할 수 없습니다.')
    return this.bringForward(appId, options)
  }

  /** Asks the OS to put a running app in front and says whether it did. */
  private async bringForward(
    appId: string,
    options?: LocalExecutionOptions
  ): Promise<Result<AppObservation>> {
    const opened = await this.open(appId, options)
    if (!opened.ok) return opened
    // The OS may decline to move focus (for example while another app holds it); say so honestly.
    const confirmed = await pollUntil(
      async () => {
        const snapshot = await this.runningApps(options)
        return snapshot.ok && snapshot.value.front?.id === appId
      },
      this.options.activateConfirmMs ?? 1_500,
      this.options,
      options
    )
    return observed(appId, confirmed ? 'confirmed' : 'dispatched')
  }

  async getForegroundWindow(): Promise<Result<WindowReference | null>> {
    const snapshot = await this.runningApps()
    if (!snapshot.ok) return snapshot
    const front = snapshot.value.front
    // Jarvis's own window in front means there is nothing meaningful to return to.
    if (!front || front.pid === this.options.selfPid) return { ok: true, value: null }
    return { ok: true, value: { appId: front.id } }
  }

  /** Window-level restore needs Accessibility; only the app is brought forward on macOS. */
  restore(
    target: WindowReference,
    options?: LocalExecutionOptions
  ): Promise<Result<AppObservation>> {
    return this.activate(target.appId, options)
  }

  async switchRecentTask(_options: InputExecutionOptions): Promise<Result<TaskSwitchObservation>> {
    return failure('unsupported', '최근 작업 전환은 입력 어댑터와 함께 제공됩니다.')
  }

  openUrl(url: string, options?: LocalExecutionOptions): Promise<Result<UrlObservation>> {
    return handOffUrl(url, this.options.openUrl, options)
  }

  // --- internals -------------------------------------------------------------------------------

  /** Only an app the OS reports as installed or running can be addressed. */
  private async resolve(
    appId: string,
    options?: LocalExecutionOptions
  ): Promise<Result<{ running: boolean }>> {
    if (!BUNDLE_ID.test(appId)) return failure('invalid_input', '앱 ID 형식이 올바르지 않습니다.')
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const running = await this.runningApps(options)
    if (!running.ok) return running
    if (running.value.running.some((app) => app.id === appId))
      return { ok: true, value: { running: true } }
    const installed = await this.installedApps(options)
    if (!installed.ok) return installed
    if (!installed.value.some((app) => app.id === appId))
      return failure('not_found', '설치된 앱 목록에서 찾을 수 없습니다.')
    return { ok: true, value: { running: false } }
  }

  private async open(appId: string, options?: LocalExecutionOptions): Promise<Result<void>> {
    const result = await this.options.runner.run(OPEN, ['-b', appId], {
      signal: options?.signal,
      timeoutMs: 10_000
    })
    if (!result.ok) return result
    if (result.value.code !== 0)
      return failure('unavailable', '앱을 열지 못했습니다. 시스템이 요청을 거부했습니다.')
    return { ok: true, value: undefined }
  }

  private async installedApps(options?: LocalExecutionOptions) {
    const ttl = this.options.catalogTtlMs ?? 60_000
    if (this.installed && this.options.now() - this.installed.at < ttl)
      return { ok: true, value: this.installed.apps } as const
    const result = await this.script(INSTALLED_APPS_SCRIPT, options)
    if (!result.ok) return result
    const apps = parseJson<{ id: string; name: string }[]>(result.value)
    if (!Array.isArray(apps) || !apps.every(isNamedApp))
      return failure('internal', '설치된 앱 목록을 해석하지 못했습니다.')
    this.installed = { at: this.options.now(), apps }
    return { ok: true, value: apps } as const
  }

  private async runningApps(options?: LocalExecutionOptions): Promise<Result<RunningSnapshot>> {
    const result = await this.script(RUNNING_APPS_SCRIPT, options)
    if (!result.ok) return result
    const snapshot = parseJson<RunningSnapshot>(result.value)
    if (!snapshot || !Array.isArray(snapshot.running))
      return failure('internal', '실행 중인 앱 목록을 해석하지 못했습니다.')
    return { ok: true, value: snapshot }
  }

  private async script(source: string, options?: LocalExecutionOptions): Promise<Result<string>> {
    const result = await this.options.runner.run(OSASCRIPT, ['-l', 'JavaScript', '-e', source], {
      signal: options?.signal,
      timeoutMs: 10_000
    })
    if (!result.ok) return result
    if (result.value.code !== 0) return failure('unavailable', '앱 정보를 읽지 못했습니다.')
    return { ok: true, value: result.value.stdout.trim() }
  }
}

function isNamedApp(value: unknown): value is { id: string; name: string } {
  const app = value as { id?: unknown; name?: unknown } | null
  return typeof app?.id === 'string' && app.id.length > 0 && typeof app.name === 'string'
}
