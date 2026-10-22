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

/**
 * Installed apps as the Start menu lists them. Each has an AppUserModelID (AUMID), the stable ID
 * used everywhere else. Desktop apps are tied to the program their Start menu shortcut runs so a
 * running process can be matched to them; packaged apps are matched by their package family. The
 * script takes no input, so nothing can be injected.
 */
const INSTALLED_APPS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$links = @{}
$roots = @((Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue | ForEach-Object {
    if (-not $links.ContainsKey($_.BaseName)) { $links[$_.BaseName] = $_.FullName }
  }
}
$out = foreach ($app in Get-StartApps) {
  $target = $null
  if ($app.AppID -notlike '*!*' -and $links.ContainsKey($app.Name)) {
    try { $target = $shell.CreateShortcut($links[$app.Name]).TargetPath } catch { $target = $null }
  }
  [pscustomobject]@{ id = $app.AppID; name = $app.Name; target = $target }
}
ConvertTo-Json -InputObject @($out) -Compress
`

/**
 * Programs that own a visible window, and the one in front. A packaged app's window is a frame
 * hosted by ApplicationFrameHost, so the process behind the hosted window is reported instead.
 * Cloaked windows (hidden by the shell, for example suspended apps) do not count.
 */
const RUNNING_APPS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class JarvisWin {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  static uint PidOf(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }
  static bool Cloaked(IntPtr hwnd) { int value; return DwmGetWindowAttribute(hwnd, 14, out value, 4) == 0 && value != 0; }
  static bool IsFrame(IntPtr hwnd) {
    StringBuilder name = new StringBuilder(64);
    GetClassName(hwnd, name, name.Capacity);
    return name.ToString() == "ApplicationFrameWindow";
  }
  static uint HostedPid(IntPtr frame) {
    uint host = PidOf(frame), inner = 0;
    EnumChildWindows(frame, delegate (IntPtr child, IntPtr l) {
      uint pid = PidOf(child);
      if (pid != host) { inner = pid; return false; }
      return true;
    }, IntPtr.Zero);
    return inner != 0 ? inner : host;
  }
  public static uint[] WindowPids() {
    HashSet<uint> pids = new HashSet<uint>();
    EnumWindows(delegate (IntPtr hwnd, IntPtr l) {
      if (!IsWindowVisible(hwnd) || GetWindowTextLength(hwnd) == 0 || Cloaked(hwnd)) return true;
      pids.Add(IsFrame(hwnd) ? HostedPid(hwnd) : PidOf(hwnd));
      return true;
    }, IntPtr.Zero);
    uint[] result = new uint[pids.Count];
    pids.CopyTo(result);
    return result;
  }
  public static uint ForegroundPid() {
    IntPtr hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero) return 0;
    return IsFrame(hwnd) ? HostedPid(hwnd) : PidOf(hwnd);
  }
}
'@
$front = [JarvisWin]::ForegroundPid()
$windowed = @{}
foreach ($id in [JarvisWin]::WindowPids()) { $windowed[[int]$id] = $true }
$running = @(Get-Process | Where-Object { $_.Path -and ($windowed.ContainsKey($_.Id) -or $_.Id -eq $front) } |
  ForEach-Object { [pscustomobject]@{ pid = $_.Id; path = $_.Path } })
$frontPath = $null
foreach ($p in $running) { if ($p.pid -eq $front) { $frontPath = $p.path } }
ConvertTo-Json -InputObject ([pscustomobject]@{
  running = $running
  front = if ($frontPath) { [pscustomobject]@{ pid = [int]$front; path = $frontPath } } else { $null }
}) -Compress -Depth 4
`

/**
 * An AUMID is free text chosen by each app. Anything outside the OS's own list is refused anyway;
 * this keeps control characters, characters no file name may hold, surrounding whitespace and
 * absurd lengths away from the OS call.
 */
function isAddressableId(id: string): boolean {
  if (id.length === 0 || id.length > 512 || id !== id.trim()) return false
  for (const char of id) if (char < ' ' || '"<>|*?'.includes(char)) return false
  return true
}

/** `<name>_<version>_<arch>_<resource>_<publisher id>` under WindowsApps gives the package family. */
const PACKAGE_FOLDER = /\\WindowsApps\\([^\\_]+)_[^\\_]+_[^\\_]+_[^\\_]*_([^\\]+)\\/i

interface StartApp {
  id: string
  name: string
  /** The program the Start menu shortcut runs; null for packaged apps and when it cannot be read. */
  target: string | null
}

interface WindowedProcess {
  pid: number
  path: string
}

interface RunningSnapshot {
  running: WindowedProcess[]
  front: WindowedProcess | null
}

interface WindowsAppControlOptions extends PollClock {
  runner: CommandRunner
  /** Hands a validated URL to the default browser (Electron `shell.openExternal`). */
  openUrl(url: string): Promise<void>
  /** This process, so Jarvis itself is never reported as the app to return to. */
  selfPid: number
  /** The Windows directory, where PowerShell and the shell launcher live. */
  systemRoot?: string
  /** Lifetime of the installed-app scan. Running state is always read fresh. */
  catalogTtlMs?: number
  launchConfirmMs?: number
  activateConfirmMs?: number
}

const encodeScript = (source: string) => Buffer.from(source, 'utf16le').toString('base64')

/**
 * App control for Windows. App IDs are AppUserModelIDs, resolved only against apps the Start menu
 * lists. Commands use fixed executables and argument arrays, never a shell. An app whose process
 * cannot be told apart from others is reported as `unknown` and its effects are never confirmed.
 */
export class WindowsAppControl implements AppControlPort {
  private installed: { at: number; apps: StartApp[] } | null = null

  constructor(private readonly options: WindowsAppControlOptions) {}

  async list(options?: LocalExecutionOptions): Promise<Result<AppDescriptor[]>> {
    const [installed, running] = await Promise.all([
      this.installedApps(options),
      this.runningApps(options)
    ])
    if (!installed.ok) return installed
    if (!running.ok) return running
    const apps = installed.value.map<AppDescriptor>((app) => ({
      appId: app.id,
      displayName: app.name,
      state: this.stateOf(app, running.value)
    }))
    return { ok: true, value: apps.sort((a, b) => a.displayName.localeCompare(b.displayName)) }
  }

  async launch(appId: string, options?: LocalExecutionOptions): Promise<Result<AppObservation>> {
    const checked = await this.resolve(appId, options)
    if (!checked.ok) return checked
    // "Open" an app that is already running means bringing it to the front, not leaving it as it is.
    if (checked.value.state === 'running') return this.bringForward(checked.value.app, options)

    const opened = await this.open(appId, options)
    if (!opened.ok) return opened
    // Handing the request over only says it was accepted; confirm the process really appeared.
    if (checked.value.state === 'unknown') return observed(appId, 'dispatched')
    const confirmed = await pollUntil(
      async () => {
        const snapshot = await this.runningApps(options)
        return snapshot.ok && this.stateOf(checked.value.app, snapshot.value) === 'running'
      },
      this.options.launchConfirmMs ?? 8_000,
      this.options,
      options
    )
    return observed(appId, confirmed ? 'confirmed' : 'dispatched')
  }

  async activate(appId: string, options?: LocalExecutionOptions): Promise<Result<AppObservation>> {
    const checked = await this.resolve(appId, options)
    if (!checked.ok) return checked
    if (checked.value.state === 'stopped')
      return failure('not_found', '앱이 실행 중이 아니라서 전환할 수 없습니다.')
    return this.bringForward(checked.value.app, options)
  }

  /** Asks the OS to put an app in front and says whether it did. */
  private async bringForward(
    app: StartApp,
    options?: LocalExecutionOptions
  ): Promise<Result<AppObservation>> {
    const opened = await this.open(app.id, options)
    if (!opened.ok) return opened
    const target = this.targetOf(app)
    // Without a program to look for, a change of the front app cannot be attributed to this one.
    if (!target) return observed(app.id, 'dispatched')
    // Windows may decline to move focus (for example while another app holds it); say so honestly.
    const confirmed = await pollUntil(
      async () => {
        const snapshot = await this.runningApps(options)
        return snapshot.ok && snapshot.value.front !== null && matches(target, snapshot.value.front)
      },
      this.options.activateConfirmMs ?? 2_000,
      this.options,
      options
    )
    return observed(app.id, confirmed ? 'confirmed' : 'dispatched')
  }

  async getForegroundWindow(): Promise<Result<WindowReference | null>> {
    // Read the front window first: the app scan below is slow and Jarvis may take focus meanwhile.
    const snapshot = await this.runningApps()
    if (!snapshot.ok) return snapshot
    const front = snapshot.value.front
    // Jarvis's own window in front means there is nothing meaningful to return to.
    if (!front || front.pid === this.options.selfPid) return { ok: true, value: null }
    const installed = await this.installedApps()
    if (!installed.ok) return installed
    const app = installed.value.find((candidate) => {
      const target = this.targetOf(candidate)
      return target !== null && matches(target, front)
    })
    return { ok: true, value: app ? { appId: app.id } : null }
  }

  /** Window-level restore is not offered; only the app is brought forward on Windows. */
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

  private get systemRoot(): string {
    return this.options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows'
  }

  /** How to tell this app's process from others, or null when that is not possible. */
  private targetOf(app: StartApp): ProcessTarget | null {
    const bang = app.id.indexOf('!')
    if (bang > 0) return { kind: 'package', family: app.id.slice(0, bang).toLowerCase() }
    // The file manager has no shortcut of its own but is always this program.
    if (app.id === 'Microsoft.Windows.Explorer')
      return { kind: 'program', path: `${this.systemRoot}\\explorer.exe`.toLowerCase() }
    return app.target ? { kind: 'program', path: app.target.toLowerCase() } : null
  }

  private stateOf(app: StartApp, snapshot: RunningSnapshot): AppDescriptor['state'] {
    const target = this.targetOf(app)
    if (!target) return 'unknown'
    return snapshot.running.some((proc) => matches(target, proc)) ? 'running' : 'stopped'
  }

  /** Only an app the Start menu lists can be addressed. */
  private async resolve(
    appId: string,
    options?: LocalExecutionOptions
  ): Promise<Result<{ app: StartApp; state: AppDescriptor['state'] }>> {
    if (!isAddressableId(appId)) return failure('invalid_input', '앱 ID 형식이 올바르지 않습니다.')
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const installed = await this.installedApps(options)
    if (!installed.ok) return installed
    const app = installed.value.find((candidate) => candidate.id === appId)
    if (!app) return failure('not_found', '설치된 앱 목록에서 찾을 수 없습니다.')
    const running = await this.runningApps(options)
    if (!running.ok) return running
    return { ok: true, value: { app, state: this.stateOf(app, running.value) } }
  }

  private async open(appId: string, options?: LocalExecutionOptions): Promise<Result<void>> {
    const result = await this.options.runner.run(
      `${this.systemRoot}\\explorer.exe`,
      [`shell:AppsFolder\\${appId}`],
      { signal: options?.signal, timeoutMs: 10_000 }
    )
    if (!result.ok) return result
    // The shell launcher reports 1 even when it handed the request over, so only other codes fail.
    if (result.value.code !== 0 && result.value.code !== 1)
      return failure('unavailable', '앱을 열지 못했습니다. 시스템이 요청을 거부했습니다.')
    return { ok: true, value: undefined }
  }

  private async installedApps(options?: LocalExecutionOptions): Promise<Result<StartApp[]>> {
    const ttl = this.options.catalogTtlMs ?? 60_000
    if (this.installed && this.options.now() - this.installed.at < ttl)
      return { ok: true, value: this.installed.apps }
    const result = await this.script(INSTALLED_APPS_SCRIPT, 20_000, options)
    if (!result.ok) return result
    const listed = parseJson<unknown>(result.value)
    if (!Array.isArray(listed) || !listed.every(isStartApp))
      return failure('internal', '설치된 앱 목록을 해석하지 못했습니다.')
    // Apps that cannot be addressed safely are left out, and a repeated ID is listed once.
    const byId = new Map<string, StartApp>()
    for (const app of listed)
      if (isAddressableId(app.id) && !byId.has(app.id))
        byId.set(app.id, {
          id: app.id,
          name: app.name.trim() || app.id,
          target: app.target ?? null
        })
    const apps = this.withDistinctTargets([...byId.values()])
    this.installed = { at: this.options.now(), apps }
    return { ok: true, value: apps }
  }

  /**
   * A program is only evidence for one app when that app alone runs it. Shortcuts to shared hosts
   * (a command prompt, the file manager, an installer) and to documents say nothing about which
   * of the apps is running, so those apps are treated as not recognisable.
   */
  private withDistinctTargets(apps: StartApp[]): StartApp[] {
    const uses = new Map<string, number>()
    for (const app of apps)
      if (app.target)
        uses.set(app.target.toLowerCase(), (uses.get(app.target.toLowerCase()) ?? 0) + 1)
    const fileManager = `${this.systemRoot}\\explorer.exe`.toLowerCase()
    return apps.map((app) => {
      const target = app.target?.toLowerCase()
      const usable =
        target !== undefined &&
        target.endsWith('.exe') &&
        target !== fileManager &&
        uses.get(target) === 1
      return usable ? app : { ...app, target: null }
    })
  }

  private async runningApps(options?: LocalExecutionOptions): Promise<Result<RunningSnapshot>> {
    const result = await this.script(RUNNING_APPS_SCRIPT, 10_000, options)
    if (!result.ok) return result
    const snapshot = parseJson<RunningSnapshot>(result.value)
    if (
      !snapshot ||
      !Array.isArray(snapshot.running) ||
      !snapshot.running.every(isProcess) ||
      (snapshot.front !== null && !isProcess(snapshot.front))
    )
      return failure('internal', '실행 중인 앱 목록을 해석하지 못했습니다.')
    return { ok: true, value: snapshot }
  }

  private async script(
    source: string,
    timeoutMs: number,
    options?: LocalExecutionOptions
  ): Promise<Result<string>> {
    const result = await this.options.runner.run(
      `${this.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodeScript(source)
      ],
      { signal: options?.signal, timeoutMs }
    )
    if (!result.ok) return result
    if (result.value.code !== 0) return failure('unavailable', '앱 정보를 읽지 못했습니다.')
    return { ok: true, value: result.value.stdout.trim() }
  }
}

type ProcessTarget = { kind: 'package'; family: string } | { kind: 'program'; path: string }

function matches(target: ProcessTarget, proc: WindowedProcess): boolean {
  if (target.kind === 'program') return proc.path.toLowerCase() === target.path
  const family = PACKAGE_FOLDER.exec(proc.path)
  return family !== null && `${family[1]}_${family[2]}`.toLowerCase() === target.family
}

function isStartApp(value: unknown): value is { id: string; name: string; target?: string | null } {
  const app = value as { id?: unknown; name?: unknown; target?: unknown } | null
  return (
    typeof app?.id === 'string' &&
    app.id.length > 0 &&
    typeof app.name === 'string' &&
    (app.target === undefined || app.target === null || typeof app.target === 'string')
  )
}

function isProcess(value: unknown): value is WindowedProcess {
  const proc = value as { pid?: unknown; path?: unknown } | null
  return typeof proc?.pid === 'number' && typeof proc.path === 'string'
}
