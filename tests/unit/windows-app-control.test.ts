import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandRunner } from '../../src/main/platform/command-runner'
import { WindowsAppControl } from '../../src/main/platform/windows-app-control'
import type { Result } from '../../src/shared/contracts/common'

const CALC = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'
const CALC_PATH =
  'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.2607.0.0_x64__8wekyb3d8bbwe\\CalculatorApp.exe'
const CHROME = 'Chrome'
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const NOTION = 'com.electron.notion'
const NOTION_PATH = 'C:\\Users\\me\\AppData\\Local\\Programs\\Notion\\Notion.exe'
const EXPLORER = 'Microsoft.Windows.Explorer'
const EXPLORER_PATH = 'C:\\WINDOWS\\Explorer.EXE'
const MYSTERY = 'Vendor.Mystery'
const SELF_PID = 1

interface StartApp {
  id: string
  name: string
  target: string | null
}

const installedApps: StartApp[] = [
  { id: CALC, name: '계산기', target: null },
  { id: CHROME, name: 'Chrome', target: CHROME_PATH },
  { id: NOTION, name: 'Notion', target: NOTION_PATH },
  { id: EXPLORER, name: '파일 탐색기', target: null },
  { id: MYSTERY, name: 'Mystery', target: null }
]

/** A scripted OS: the shell launcher starts the app (or not) and moves it to the front. */
function fakeWindows(
  options: {
    running?: Record<string, string>
    front?: string | null
    /** Exit code of the shell launcher. */
    openCode?: number
    /** When true, the request is accepted but the app never shows up / never gets focus. */
    ignoreOpen?: boolean
    installed?: StartApp[]
    scriptCode?: number
  } = {}
) {
  const pathOf: Record<string, string> = {
    [CALC]: CALC_PATH,
    [CHROME]: CHROME_PATH,
    [NOTION]: NOTION_PATH,
    [EXPLORER]: EXPLORER_PATH
  }
  const running = new Map<string, number>(
    Object.keys(options.running ?? { [CHROME]: CHROME_PATH }).map((id, index) => [id, 100 + index])
  )
  let front: string | null = options.front === undefined ? CHROME : options.front
  const commands: { file: string; args: readonly string[] }[] = []
  const decode = (args: readonly string[]) =>
    Buffer.from(String(args[args.length - 1]), 'base64').toString('utf16le')
  const runner: CommandRunner = {
    async run(file, args): Promise<Result<CommandResult>> {
      commands.push({ file, args })
      if (file.endsWith('explorer.exe')) {
        const id = args[0].replace('shell:AppsFolder\\', '')
        if (!options.ignoreOpen && (options.openCode ?? 1) <= 1) {
          if (!running.has(id)) running.set(id, 500 + running.size)
          front = id
        }
        return { ok: true, value: { code: options.openCode ?? 1, stdout: '', stderr: '' } }
      }
      if ((options.scriptCode ?? 0) !== 0)
        return { ok: true, value: { code: options.scriptCode!, stdout: '', stderr: 'err' } }
      if (decode(args).includes('Get-StartApps'))
        return {
          ok: true,
          value: { code: 0, stdout: JSON.stringify(options.installed ?? installedApps), stderr: '' }
        }
      const processes = [...running].map(([id, pid]) => ({
        pid,
        path: pathOf[id] ?? `C:\\x\\${id}.exe`
      }))
      const frontPid = front === null ? null : (running.get(front) ?? SELF_PID)
      const frontPath = front === null ? null : (pathOf[front] ?? `C:\\x\\${front}.exe`)
      return {
        ok: true,
        value: {
          code: 0,
          stdout: JSON.stringify({
            running: processes,
            front: frontPid === null ? null : { pid: frontPid, path: frontPath }
          }),
          stderr: ''
        }
      }
    }
  }
  let nowMs = 0
  const openUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined)
  const control = new WindowsAppControl({
    runner,
    openUrl,
    selfPid: SELF_PID,
    systemRoot: 'C:\\WINDOWS',
    delay: async (ms) => {
      nowMs += ms
    },
    now: () => nowMs
  })
  return {
    control,
    commands,
    openUrl,
    running,
    setFront: (id: string | null) => {
      front = id
    },
    opens: () => commands.filter((command) => command.file.endsWith('explorer.exe')),
    scans: () =>
      commands.filter(
        (command) =>
          command.file.endsWith('powershell.exe') &&
          Buffer.from(String(command.args[command.args.length - 1]), 'base64')
            .toString('utf16le')
            .includes('Get-StartApps')
      )
  }
}

describe('WindowsAppControl.list', () => {
  it('lists Start menu apps by AUMID with their state, sorted by name', async () => {
    const { control } = fakeWindows({ running: { [CALC]: CALC_PATH, [EXPLORER]: EXPLORER_PATH } })
    const result = await control.list()
    expect(result.ok && result.value.map((app) => [app.appId, app.state])).toEqual(
      expect.arrayContaining([
        [CALC, 'running'],
        [CHROME, 'stopped'],
        [NOTION, 'stopped'],
        [EXPLORER, 'running'],
        [MYSTERY, 'unknown']
      ])
    )
    const names = result.ok ? result.value.map((app) => app.displayName) : []
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })

  it('matches a packaged app by package family and a desktop app by its program, ignoring case', async () => {
    const { control } = fakeWindows({
      running: { [CALC]: CALC_PATH.toUpperCase().replace('WINDOWSAPPS', 'WindowsApps') }
    })
    const result = await control.list()
    expect(result.ok && result.value.find((app) => app.appId === CALC)?.state).toBe('running')
    const other = fakeWindows({ running: { [CHROME]: CHROME_PATH.toUpperCase() } })
    const listed = await other.control.list()
    expect(listed.ok && listed.value.find((app) => app.appId === CHROME)?.state).toBe('running')
  })

  it('does not take another package for the same app', async () => {
    const { control } = fakeWindows({
      running: {
        'Other.App':
          'C:\\Program Files\\WindowsApps\\Other.WindowsCalculator_1.0.0.0_x64__8wekyb3d8bbwe\\a.exe'
      }
    })
    const result = await control.list()
    expect(result.ok && result.value.find((app) => app.appId === CALC)?.state).toBe('stopped')
  })

  it('leaves out apps whose ID cannot be addressed and lists a repeated ID once', async () => {
    const { control } = fakeWindows({
      installed: [
        { id: CHROME, name: 'Chrome', target: CHROME_PATH },
        { id: CHROME, name: 'Chrome again', target: CHROME_PATH },
        { id: 'bad\nid', name: 'Bad', target: null },
        { id: ' padded ', name: 'Padded', target: null },
        { id: 'a"b', name: 'Quote', target: null }
      ]
    })
    const result = await control.list()
    expect(result).toMatchObject({
      ok: true,
      value: [{ appId: CHROME, displayName: 'Chrome' }]
    })
    expect(result.ok && result.value).toHaveLength(1)
  })

  it('does not recognise apps by a program that other apps, documents or the file manager also use', async () => {
    const { control } = fakeWindows({
      running: { [CHROME]: CHROME_PATH },
      installed: [
        { id: CHROME, name: 'Chrome', target: CHROME_PATH },
        { id: 'Shared.One', name: 'One', target: 'C:\\Windows\\System32\\cmd.exe' },
        { id: 'Shared.Two', name: 'Two', target: 'C:\\Windows\\System32\\cmd.exe' },
        { id: 'Doc.Link', name: 'Docs', target: 'C:\\Docs\\help.chm' },
        { id: 'Folder.Link', name: 'Folder', target: EXPLORER_PATH },
        { id: EXPLORER, name: '파일 탐색기', target: null }
      ]
    })
    const result = await control.list()
    const states = result.ok ? Object.fromEntries(result.value.map((a) => [a.appId, a.state])) : {}
    expect(states).toEqual({
      [CHROME]: 'running',
      'Shared.One': 'unknown',
      'Shared.Two': 'unknown',
      'Doc.Link': 'unknown',
      'Folder.Link': 'unknown',
      [EXPLORER]: 'stopped'
    })
  })

  it('reports a failing OS query as unavailable rather than an empty list', async () => {
    const { control } = fakeWindows({ scriptCode: 1 })
    expect(await control.list()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('rejects garbage from the OS', async () => {
    const control = new WindowsAppControl({
      runner: {
        run: async () => ({ ok: true, value: { code: 0, stdout: 'not json', stderr: '' } })
      },
      openUrl: async () => undefined,
      selfPid: SELF_PID,
      delay: async () => undefined,
      now: () => 0
    })
    expect(await control.list()).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('reads the installed-app scan once within its lifetime', async () => {
    const { control, scans } = fakeWindows()
    await control.list()
    await control.list()
    expect(scans()).toHaveLength(1)
  })

  it('runs PowerShell without a profile or a shell, and the program text only travels encoded', async () => {
    const { control, commands } = fakeWindows()
    await control.list()
    const [first] = commands
    expect(first.file).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(first.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ])
  })
})

describe('WindowsAppControl.launch', () => {
  it('starts a stopped app through the shell and confirms it is running', async () => {
    const { control, opens } = fakeWindows()
    expect(await control.launch(CALC)).toEqual({
      ok: true,
      value: { kind: 'app', appId: CALC, status: 'confirmed' }
    })
    expect(opens()).toEqual([
      { file: 'C:\\WINDOWS\\explorer.exe', args: [`shell:AppsFolder\\${CALC}`] }
    ])
  })

  it('brings an app that is already running to the front instead of leaving it as it is', async () => {
    const { control, opens } = fakeWindows({
      running: { [CHROME]: CHROME_PATH, [NOTION]: NOTION_PATH },
      front: CHROME
    })
    expect(await control.launch(NOTION)).toEqual({
      ok: true,
      value: { kind: 'app', appId: NOTION, status: 'confirmed' }
    })
    expect(opens()).toHaveLength(1)
  })

  it('does not start a second copy of a running app', async () => {
    const { control, running } = fakeWindows({
      running: { [CHROME]: CHROME_PATH, [NOTION]: NOTION_PATH }
    })
    await control.launch(NOTION)
    expect([...running.keys()].filter((id) => id === NOTION)).toHaveLength(1)
  })

  it('says dispatched when a running app cannot be brought forward', async () => {
    const { control } = fakeWindows({
      running: { [CHROME]: CHROME_PATH, [NOTION]: NOTION_PATH },
      ignoreOpen: true
    })
    expect(await control.launch(NOTION)).toMatchObject({
      ok: true,
      value: { status: 'dispatched' }
    })
  })

  it('says dispatched, not confirmed, when the app never appears', async () => {
    const { control } = fakeWindows({ ignoreOpen: true })
    expect(await control.launch(CALC)).toMatchObject({ ok: true, value: { status: 'dispatched' } })
  })

  it('never confirms an app whose process cannot be recognised', async () => {
    const { control, opens } = fakeWindows()
    expect(await control.launch(MYSTERY)).toEqual({
      ok: true,
      value: { kind: 'app', appId: MYSTERY, status: 'dispatched' }
    })
    expect(opens()).toHaveLength(1)
  })

  it('treats the launcher exit code 1 as accepted and other codes as a refusal', async () => {
    expect(await fakeWindows({ openCode: 0 }).control.launch(CALC)).toMatchObject({ ok: true })
    expect(await fakeWindows({ openCode: 1 }).control.launch(CALC)).toMatchObject({ ok: true })
    expect(await fakeWindows({ openCode: 2 }).control.launch(CALC)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
  })

  it('refuses IDs that are not listed, and malformed IDs, without running the launcher', async () => {
    const { control, opens } = fakeWindows()
    expect(await control.launch('Vendor.Unknown')).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    for (const bad of ['', ' Chrome', 'Chrome ', 'a\nb', 'a"b', 'a|b', 'x'.repeat(513)])
      expect(await control.launch(bad)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    expect(opens()).toHaveLength(0)
  })

  it('does not launch when already cancelled, and stops waiting if cancelled afterwards', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const first = fakeWindows()
    expect(await first.control.launch(CALC, { signal: aborted.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(first.opens()).toHaveLength(0)

    const later = fakeWindows({ ignoreOpen: true })
    const controller = new AbortController()
    const pending = later.control.launch(CALC, { signal: controller.signal })
    controller.abort()
    // The request was already sent, so the effect is reported rather than hidden.
    expect(await pending).toMatchObject({ ok: true, value: { status: 'dispatched' } })
  })
})

describe('WindowsAppControl.activate and restore', () => {
  it('brings a running app forward and confirms the focus change', async () => {
    const { control, opens } = fakeWindows({
      running: { [CHROME]: CHROME_PATH, [CALC]: CALC_PATH }
    })
    expect(await control.activate(CALC)).toMatchObject({
      ok: true,
      value: { appId: CALC, status: 'confirmed' }
    })
    expect(opens()).toHaveLength(1)
  })

  it('reports dispatched when Windows does not hand over focus', async () => {
    const { control } = fakeWindows({
      running: { [CHROME]: CHROME_PATH, [CALC]: CALC_PATH },
      ignoreOpen: true
    })
    expect(await control.activate(CALC)).toMatchObject({
      ok: true,
      value: { status: 'dispatched' }
    })
  })

  it('will not start an app just because it was asked to switch to it', async () => {
    const { control, opens } = fakeWindows()
    expect(await control.activate(CALC)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(opens()).toHaveLength(0)
  })

  it('restores by bringing the recorded app forward, ignoring window IDs it cannot honour', async () => {
    const { control } = fakeWindows({ running: { [CHROME]: CHROME_PATH, [CALC]: CALC_PATH } })
    expect(await control.restore({ appId: CALC, windowId: '42' })).toMatchObject({
      ok: true,
      value: { appId: CALC }
    })
  })
})

describe('WindowsAppControl foreground and URLs', () => {
  it('returns the front app by its AUMID', async () => {
    const windows = fakeWindows({
      running: { [CHROME]: CHROME_PATH, [CALC]: CALC_PATH },
      front: CALC
    })
    expect(await windows.control.getForegroundWindow()).toEqual({
      ok: true,
      value: { appId: CALC }
    })
    windows.setFront(CHROME)
    expect(await windows.control.getForegroundWindow()).toEqual({
      ok: true,
      value: { appId: CHROME }
    })
  })

  it('has nothing to return to when Jarvis, nothing, or an unlisted program is in front', async () => {
    const windows = fakeWindows({ running: { [CHROME]: CHROME_PATH } })
    windows.setFront(null)
    expect(await windows.control.getForegroundWindow()).toEqual({ ok: true, value: null })
    // The fake reports the front process as Jarvis's own when it is not among the running ones.
    windows.setFront('com.jarvis.self')
    expect(await windows.control.getForegroundWindow()).toEqual({ ok: true, value: null })
    windows.running.set('Unlisted', 900)
    windows.setFront('Unlisted')
    expect(await windows.control.getForegroundWindow()).toEqual({ ok: true, value: null })
  })

  it('reads the front window before it scans for installed apps', async () => {
    const { control, commands } = fakeWindows()
    await control.getForegroundWindow()
    const decoded = commands.map((command) =>
      Buffer.from(String(command.args[command.args.length - 1]), 'base64').toString('utf16le')
    )
    expect(decoded[0]).toContain('ForegroundPid')
    expect(decoded[1]).toContain('Get-StartApps')
  })

  it('hands http(s) URLs to the browser and says only that it was dispatched', async () => {
    const { control, openUrl } = fakeWindows()
    expect(await control.openUrl('https://example.com/a?b=1')).toEqual({
      ok: true,
      value: { kind: 'url', url: 'https://example.com/a?b=1', status: 'dispatched' }
    })
    expect(openUrl).toHaveBeenCalledWith('https://example.com/a?b=1')
  })

  it('rejects other schemes before any handoff', async () => {
    const { control, openUrl } = fakeWindows()
    for (const url of ['file:///c:/windows/system32/cmd.exe', 'javascript:alert(1)', 'nope'])
      expect(await control.openUrl(url)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('leaves recent-task switching to the input adapter', async () => {
    const { control } = fakeWindows()
    expect(
      await control.switchRecentTask({
        generation: { sessionId: 's', revision: 0 },
        sequence: 0,
        deadlineMs: 0
      })
    ).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })
})
