import { describe, expect, it, vi } from 'vitest'
import { nodeCommandRunner } from '../../src/main/platform/command-runner'
import type { CommandResult, CommandRunner } from '../../src/main/platform/command-runner'
import { MacAppControl } from '../../src/main/platform/macos-app-control'
import { createUnsupportedAppControl } from '../../src/main/platform/unsupported-app-control'
import type { Result } from '../../src/shared/contracts/common'

type Apps = { id: string; name: string }[]
const installedApps: Apps = [
  { id: 'com.apple.calculator', name: 'Calculator' },
  { id: 'com.apple.Safari', name: 'Safari' },
  { id: 'com.example.zeta', name: 'Zeta' }
]

/** A scripted OS: the running set and frontmost app change as `open` is called. */
function fakeMac(
  options: {
    running?: string[]
    front?: string | null
    openCode?: number
    /** When true, `open` is accepted but the app never shows up / never gets focus. */
    ignoreOpen?: boolean
    installed?: Apps
    scriptCode?: number
  } = {}
) {
  const running = new Set(options.running ?? ['com.apple.Safari'])
  let front: string | null = options.front === undefined ? 'com.apple.Safari' : options.front
  const commands: { file: string; args: readonly string[] }[] = []
  const runner: CommandRunner = {
    async run(file, args): Promise<Result<CommandResult>> {
      commands.push({ file, args })
      if (file === '/usr/bin/open') {
        const id = args[1]
        if ((options.openCode ?? 0) === 0 && !options.ignoreOpen) {
          running.add(id)
          front = id
        }
        return { ok: true, value: { code: options.openCode ?? 0, stdout: '', stderr: '' } }
      }
      const script = String(args[3])
      if ((options.scriptCode ?? 0) !== 0)
        return { ok: true, value: { code: options.scriptCode!, stdout: '', stderr: 'err' } }
      if (script.includes('NSFileManager'))
        return {
          ok: true,
          value: { code: 0, stdout: JSON.stringify(options.installed ?? installedApps), stderr: '' }
        }
      return {
        ok: true,
        value: {
          code: 0,
          stdout: JSON.stringify({
            running: [...running].map((id, index) => ({ id, name: id, pid: 100 + index })),
            front: front ? { id: front, pid: front === 'com.jarvis.self' ? 1 : 200 } : null
          }),
          stderr: ''
        }
      }
    }
  }
  let nowMs = 0
  const openUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined)
  const control = new MacAppControl({
    runner,
    openUrl,
    selfPid: 1,
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
    opens: () => commands.filter((command) => command.file === '/usr/bin/open')
  }
}

describe('MacAppControl.list', () => {
  it('merges installed and running apps by bundle ID, sorted by name', async () => {
    const { control } = fakeMac({ running: ['com.apple.Safari', 'com.example.dev'] })
    const result = await control.list()
    expect(result).toEqual({
      ok: true,
      value: [
        { appId: 'com.apple.calculator', displayName: 'Calculator', state: 'stopped' },
        { appId: 'com.example.dev', displayName: 'com.example.dev', state: 'running' },
        { appId: 'com.apple.Safari', displayName: 'Safari', state: 'running' },
        { appId: 'com.example.zeta', displayName: 'Zeta', state: 'stopped' }
      ]
    })
  })

  it('reports a failing OS query as unavailable rather than an empty list', async () => {
    const { control } = fakeMac({ scriptCode: 1 })
    expect(await control.list()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('rejects garbage from the OS', async () => {
    const control = new MacAppControl({
      runner: {
        run: async () => ({ ok: true, value: { code: 0, stdout: 'not json', stderr: '' } })
      },
      openUrl: async () => undefined,
      selfPid: 1,
      delay: async () => undefined,
      now: () => 0
    })
    expect(await control.list()).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('reads the installed-app scan once within its lifetime', async () => {
    const { control, commands } = fakeMac()
    await control.list()
    await control.list()
    const scans = commands.filter((command) => String(command.args[3]).includes('NSFileManager'))
    expect(scans).toHaveLength(1)
  })
})

describe('MacAppControl.launch', () => {
  it('starts a stopped app and confirms it is running', async () => {
    const { control, opens } = fakeMac()
    expect(await control.launch('com.apple.calculator')).toEqual({
      ok: true,
      value: { kind: 'app', appId: 'com.apple.calculator', status: 'confirmed' }
    })
    expect(opens()).toEqual([{ file: '/usr/bin/open', args: ['-b', 'com.apple.calculator'] }])
  })

  it('does not relaunch an app that is already running', async () => {
    const { control, opens } = fakeMac()
    expect(await control.launch('com.apple.Safari')).toMatchObject({
      ok: true,
      value: { status: 'confirmed' }
    })
    expect(opens()).toHaveLength(0)
  })

  it('says dispatched, not confirmed, when the app never appears', async () => {
    const { control } = fakeMac({ ignoreOpen: true })
    expect(await control.launch('com.apple.calculator')).toMatchObject({
      ok: true,
      value: { status: 'dispatched' }
    })
  })

  it('refuses IDs that are not installed or running, and malformed IDs, without running anything', async () => {
    const { control, opens } = fakeMac()
    expect(await control.launch('com.example.unknown')).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    for (const bad of [
      '',
      '-a /bin/sh',
      '--args',
      '../../bin/sh',
      'a b',
      'com.apple;rm',
      '/Applications/X.app'
    ])
      expect(await control.launch(bad)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    expect(opens()).toHaveLength(0)
  })

  it('reports a refusal by the OS', async () => {
    const { control } = fakeMac({ openCode: 1 })
    expect(await control.launch('com.apple.calculator')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
  })

  it('does not launch when already cancelled, and stops waiting if cancelled afterwards', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const first = fakeMac()
    expect(
      await first.control.launch('com.apple.calculator', { signal: aborted.signal })
    ).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(first.opens()).toHaveLength(0)

    const later = fakeMac({ ignoreOpen: true })
    const controller = new AbortController()
    const pending = later.control.launch('com.apple.calculator', { signal: controller.signal })
    controller.abort()
    // The request was already sent, so the effect is reported rather than hidden.
    expect(await pending).toMatchObject({ ok: true, value: { status: 'dispatched' } })
  })
})

describe('MacAppControl.activate and restore', () => {
  it('brings a running app forward and confirms the focus change', async () => {
    const { control, opens } = fakeMac({ running: ['com.apple.Safari', 'com.apple.calculator'] })
    expect(await control.activate('com.apple.calculator')).toMatchObject({
      ok: true,
      value: { appId: 'com.apple.calculator', status: 'confirmed' }
    })
    expect(opens()).toHaveLength(1)
  })

  it('reports dispatched when the OS does not hand over focus', async () => {
    const { control } = fakeMac({
      running: ['com.apple.Safari', 'com.apple.calculator'],
      ignoreOpen: true
    })
    expect(await control.activate('com.apple.calculator')).toMatchObject({
      ok: true,
      value: { status: 'dispatched' }
    })
  })

  it('will not start an app just because it was asked to switch to it', async () => {
    const { control, opens } = fakeMac()
    expect(await control.activate('com.apple.calculator')).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    expect(opens()).toHaveLength(0)
  })

  it('restores by bringing the recorded app forward, ignoring window IDs it cannot honour', async () => {
    const { control } = fakeMac({ running: ['com.apple.Safari', 'com.apple.calculator'] })
    expect(await control.restore({ appId: 'com.apple.calculator', windowId: '42' })).toMatchObject({
      ok: true,
      value: { appId: 'com.apple.calculator' }
    })
  })
})

describe('MacAppControl foreground and URLs', () => {
  it('returns the frontmost app but never Jarvis itself', async () => {
    const mac = fakeMac({ front: 'com.apple.Safari' })
    expect(await mac.control.getForegroundWindow()).toEqual({
      ok: true,
      value: { appId: 'com.apple.Safari' }
    })
    mac.running.add('com.jarvis.self')
    mac.setFront('com.jarvis.self')
    expect(await mac.control.getForegroundWindow()).toEqual({ ok: true, value: null })
    mac.setFront(null)
    expect(await mac.control.getForegroundWindow()).toEqual({ ok: true, value: null })
  })

  it('hands http(s) URLs to the browser and says only that it was dispatched', async () => {
    const { control, openUrl } = fakeMac()
    expect(await control.openUrl('https://example.com/a?b=1')).toEqual({
      ok: true,
      value: { kind: 'url', url: 'https://example.com/a?b=1', status: 'dispatched' }
    })
    expect(openUrl).toHaveBeenCalledWith('https://example.com/a?b=1')
  })

  it('rejects other schemes and malformed URLs before any handoff', async () => {
    const { control, openUrl } = fakeMac()
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://x.test/',
      ' https://x.test/',
      'nope'
    ])
      expect(await control.openUrl(url)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('reports a browser handoff failure', async () => {
    const { control, openUrl } = fakeMac()
    openUrl.mockRejectedValueOnce(new Error('no browser'))
    expect(await control.openUrl('https://example.com/')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
  })

  it('leaves recent-task switching to the input adapter', async () => {
    const { control } = fakeMac()
    expect(
      await control.switchRecentTask({
        generation: { sessionId: 's', revision: 0 },
        sequence: 0,
        deadlineMs: 0
      })
    ).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })
})

describe('createUnsupportedAppControl', () => {
  it('fails app operations as unsupported but still opens URLs', async () => {
    const openUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined)
    const control = createUnsupportedAppControl(openUrl)
    for (const result of [
      await control.list(),
      await control.launch('x'),
      await control.activate('x')
    ])
      expect(result).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(await control.getForegroundWindow()).toEqual({ ok: true, value: null })
    expect(await control.openUrl('https://example.com/')).toMatchObject({ ok: true })
    expect(await control.openUrl('file:///x')).toMatchObject({ ok: false })
    expect(openUrl).toHaveBeenCalledTimes(1)
  })
})

describe('nodeCommandRunner', () => {
  it('captures output and exit code without a shell', async () => {
    expect(await nodeCommandRunner.run('/bin/echo', ['hello; echo injected'])).toEqual({
      ok: true,
      value: { code: 0, stdout: 'hello; echo injected\n', stderr: '' }
    })
    expect(await nodeCommandRunner.run('/usr/bin/false', [])).toMatchObject({
      ok: true,
      value: { code: 1 }
    })
  })

  it('reports a missing executable, a timeout and a cancel as failures', async () => {
    expect(await nodeCommandRunner.run('/definitely/not/here', [])).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(await nodeCommandRunner.run('/bin/sleep', ['5'], { timeoutMs: 50 })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    const controller = new AbortController()
    controller.abort()
    expect(
      await nodeCommandRunner.run('/bin/echo', ['x'], { signal: controller.signal })
    ).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
  })
})
