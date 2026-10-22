import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandApi } from '../../src/main/commands/command-api'
import { CommandJournal } from '../../src/main/commands/command-journal'
import { CommandService } from '../../src/main/commands/command-service'
import type { AppControlPort, FolderOpenPort, SystemAudioPort } from '../../src/main/platform/ports'
import { NodeLocalFiles } from '../../src/main/settings/node-local-files'
import { CapabilityRegistry, platformCapabilities } from '../../src/main/tools/capability-registry'
import { ToolExecutor } from '../../src/main/tools/tool-executor'
import { stopAllFakeServers } from '../fixtures/fake-jarvis-server'
import { signedInApp } from '../fixtures/signed-in-app'
import { waitUntil } from '../helpers/wait'

const directories: string[] = []
afterEach(async () => {
  await stopAllFakeServers()
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function fakePorts() {
  const audio = (muted: boolean) =>
    ({ ok: true, value: { kind: 'audio', level: 30, muted, status: 'confirmed' } }) as const
  return {
    folders: {
      open: vi.fn<FolderOpenPort['open']>(async (alias) => ({
        ok: true,
        value: { kind: 'folder', alias, status: 'dispatched' }
      }))
    },
    audio: {
      setVolume: vi.fn<SystemAudioPort['setVolume']>(async () => audio(false)),
      adjustVolume: vi.fn<SystemAudioPort['adjustVolume']>(async () => audio(false)),
      setMuted: vi.fn<SystemAudioPort['setMuted']>(async (muted) => audio(muted))
    },
    app: {
      list: vi.fn<AppControlPort['list']>(async () => ({ ok: true, value: [] })),
      launch: vi.fn<AppControlPort['launch']>(async (appId) => ({
        ok: true,
        value: { kind: 'app', appId, status: 'confirmed' }
      })),
      activate: vi.fn<AppControlPort['activate']>(async (appId) => ({
        ok: true,
        value: { kind: 'app', appId, status: 'confirmed' }
      })),
      restore: vi.fn<AppControlPort['restore']>(),
      getForegroundWindow: vi.fn<AppControlPort['getForegroundWindow']>(),
      switchRecentTask: vi.fn<AppControlPort['switchRecentTask']>(),
      openUrl: vi.fn<AppControlPort['openUrl']>(async (url) => ({
        ok: true,
        value: { kind: 'url', url, status: 'dispatched' }
      }))
    } satisfies AppControlPort
  }
}

/** The app's command path in miniature, over a real connection to the fake server. */
async function commandApp() {
  const app = await signedInApp()
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-commands-'))
  directories.push(directory)
  const ports = fakePorts()
  const executor = new ToolExecutor({
    registry: new CapabilityRegistry(platformCapabilities('darwin')),
    appControl: ports.app,
    folders: ports.folders,
    audio: ports.audio,
    auth: { requireSignedIn: () => ({ ok: true, value: undefined }) },
    clock: { now: () => performance.now() },
    restoreTarget: () => null
  })
  const logs: string[] = []
  // A new service over the same journal directory, as after a restart.
  const makeService = () =>
    new CommandService({
      api: new CommandApi(app.api),
      journal: new CommandJournal({ files: new NodeLocalFiles(directory), now: Date.now }),
      executor,
      platform: 'darwin',
      now: Date.now,
      clock: app.api.clock,
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(ms, 15))
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true }
          )
        }),
      log: (message) => logs.push(message)
    })
  let nextId = 100
  const add = (
    command_type: string,
    args: Record<string, unknown> = {},
    extra: { requested_app_code?: string | null; requested_at?: string; attempt_no?: number } = {}
  ) => {
    const command_id = nextId++
    app.fake.commands.push({
      command_id,
      attempt_no: extra.attempt_no ?? 1,
      command_type,
      requested_app_code: extra.requested_app_code ?? null,
      arguments: args,
      requested_at: extra.requested_at ?? new Date().toISOString()
    })
    return command_id
  }
  const posts = (id: number) =>
    app.fake.calls.filter(
      (call) => call.method === 'POST' && call.path === `/commands/${id}/results`
    )
  return { ...app, ports, add, posts, logs, makeService, directory }
}

describe('commands from the server', () => {
  it('runs the pending commands on this device and the server stores each result', async () => {
    const { fake, ports, add, makeService } = await commandApp()
    const mute = add('system.mute', { muted: true })
    const folder = add('folder.open', { alias: 'downloads' })
    const launch = add('apps.launch', {}, { requested_app_code: 'chrome' })
    const service = makeService()
    service.start('uuid-jarvis')
    await waitUntil(() => fake.results.size === 3)
    await service.stop()

    expect(ports.audio.setMuted).toHaveBeenCalledExactlyOnceWith(true, expect.anything())
    expect(ports.folders.open).toHaveBeenCalledExactlyOnceWith('downloads', expect.anything())
    expect(ports.app.launch).toHaveBeenCalledExactlyOnceWith('com.google.Chrome', expect.anything())

    expect(fake.results.get(mute)).toMatchObject({
      attempt_no: 1,
      status: 'success',
      observation_status: 'confirmed'
    })
    expect(fake.results.get(folder)).toMatchObject({
      status: 'success',
      observation_status: 'dispatched'
    })
    expect(fake.results.get(launch)).toMatchObject({
      status: 'success',
      observation_status: 'confirmed',
      app: { app_code: 'chrome', os_app_id: 'com.google.Chrome', display_name: 'Google Chrome' }
    })
    for (const result of fake.results.values()) {
      expect(Date.parse(String(result.finished_at))).toBeGreaterThanOrEqual(
        Date.parse(String(result.started_at))
      )
    }
  })

  it('sends nothing about a URL, folder or volume in the result', async () => {
    const { fake, add, makeService } = await commandApp()
    const id = add('browser.open', { url: 'https://example.com/private?token=SECRET' })
    add('system.volume', { mode: 'set', level: 37 })
    const service = makeService()
    service.start('uuid-jarvis')
    await waitUntil(() => fake.results.size === 2)
    await service.stop()
    // The times are left out: a clock that reads 37 (minutes or seconds) is not the volume.
    const withoutTimes = [...fake.results.values()].map(
      ({ started_at: _started, finished_at: _finished, reported_at: _reported, ...rest }) => rest
    )
    expect(JSON.stringify(withoutTimes)).not.toMatch(/SECRET|example\.com|\b37\b/)
    expect(fake.results.get(id)).toMatchObject({
      status: 'success',
      observation_status: 'dispatched'
    })
  })

  it('does not run a command again when the answer to its result was lost', async () => {
    const { fake, ports, add, posts, makeService } = await commandApp()
    const id = add('system.mute', { muted: true })
    fake.resultFaults = ['drop']
    const service = makeService()
    service.start('uuid-jarvis')
    await waitUntil(() => posts(id).length >= 2)
    await service.stop()
    expect(ports.audio.setMuted).toHaveBeenCalledTimes(1)
    // The same body went twice, and the server took it as the same result (not a conflict).
    expect(posts(id)[1]?.body).toEqual(posts(id)[0]?.body)
    expect(fake.results.has(id)).toBe(true)
  })

  it('keeps sending a result through server errors and runs the command only once', async () => {
    const { fake, ports, add, posts, makeService } = await commandApp()
    const id = add('system.mute', { muted: false })
    fake.resultFaults = [503, 503, 500]
    const service = makeService()
    service.start('uuid-jarvis')
    await waitUntil(() => fake.results.has(id))
    await service.stop()
    expect(posts(id).length).toBeGreaterThanOrEqual(4)
    expect(ports.audio.setMuted).toHaveBeenCalledTimes(1)
  })

  it.each([403, 404, 409, 422])(
    'stops sending a result the server answers with %i, and does not run the command when it is listed again',
    async (status) => {
      const { fake, ports, add, posts, makeService, logs } = await commandApp()
      const id = add('system.mute', { muted: true })
      fake.resultFaults = [status]
      const service = makeService()
      service.start('uuid-jarvis')
      await waitUntil(() => logs.includes('서버가 명령 결과를 받지 않아 더 보내지 않아요.'))
      // The server never stored it, so it keeps listing the command. Give the loop time to see it.
      await new Promise((resolve) => setTimeout(resolve, 150))
      await service.stop()
      expect(posts(id)).toHaveLength(1)
      expect(ports.audio.setMuted).toHaveBeenCalledTimes(1)
    }
  )

  it('finishes the work after a restart without running anything twice', async () => {
    const { fake, ports, add, posts, makeService } = await commandApp()
    const id = add('system.mute', { muted: true })
    fake.resultFaults = [503, 503, 503, 503, 503, 503, 503, 503, 503, 503]
    const first = makeService()
    first.start('uuid-jarvis')
    await waitUntil(() => posts(id).length >= 2)
    await first.stop()
    expect(fake.results.has(id)).toBe(false)

    fake.resultFaults = []
    const second = makeService() // the app was restarted; the journal is on disk
    second.start('uuid-jarvis')
    await waitUntil(() => fake.results.has(id))
    await second.stop()
    expect(ports.audio.setMuted).toHaveBeenCalledTimes(1)
  })

  it('reports a command cut off by a restart as unknown, which the server accepts', async () => {
    const { fake, ports, add, makeService, directory } = await commandApp()
    const id = add('system.mute', { muted: true })
    // A journal left by a process that ended while the command ran.
    const before = new CommandJournal({ files: new NodeLocalFiles(directory), now: Date.now })
    await before.forUser('uuid-jarvis').begin({ commandId: String(id), attemptNo: 1 })
    const service = makeService()
    service.start('uuid-jarvis')
    await waitUntil(() => fake.results.has(id))
    await service.stop()
    expect(ports.audio.setMuted).not.toHaveBeenCalled()
    const stored = fake.results.get(id)
    expect(stored).toMatchObject({ status: 'unknown', observation_status: 'unknown' })
    expect(stored).not.toHaveProperty('failure_stage')
  })

  it('does not start a command that has waited too long, and says so', async () => {
    const { fake, ports, add, makeService } = await commandApp()
    const id = add(
      'system.mute',
      { muted: true },
      { requested_at: new Date(Date.now() - 120_000).toISOString() }
    )
    const service = makeService()
    service.start('uuid-jarvis')
    await waitUntil(() => fake.results.has(id))
    await service.stop()
    expect(ports.audio.setMuted).not.toHaveBeenCalled()
    expect(fake.results.get(id)).toMatchObject({
      status: 'failed',
      error_code: 'expired',
      failure_stage: 'timeout'
    })
  })

  it('refuses what it cannot run and still runs the rest', async () => {
    const { fake, ports, add, makeService } = await commandApp()
    const unsupported = add('browser.search', { query: 'x', engine: 'google' })
    const wrong = add('system.volume', { mode: 'set', level: 900 })
    const good = add('system.mute', { muted: true })
    // An item that does not even have the right shape, but names itself.
    const broken = add('system.mute', {})
    ;(fake.commands.find((c) => c.command_id === broken) as { arguments: unknown }).arguments =
      'oops'
    const service = makeService()
    service.start('uuid-jarvis')
    await waitUntil(() => fake.results.size === 4)
    await service.stop()
    expect(fake.results.get(unsupported)).toMatchObject({
      status: 'rejected',
      failure_stage: 'capability'
    })
    expect(fake.results.get(wrong)).toMatchObject({
      status: 'rejected',
      failure_stage: 'validation'
    })
    expect(fake.results.get(broken)).toMatchObject({
      status: 'rejected',
      failure_stage: 'validation'
    })
    expect(fake.results.get(good)).toMatchObject({ status: 'success' })
    expect(ports.audio.setMuted).toHaveBeenCalledTimes(1)
  })

  it('keeps working when the access token was revoked, by renewing the session', async () => {
    const { fake, tokens, add, makeService } = await commandApp()
    const id = add('system.mute', { muted: true })
    fake.revokedAccess.add(tokens.get() ?? '')
    const service = makeService()
    service.start('uuid-jarvis')
    await waitUntil(() => fake.results.has(id))
    await service.stop()
    expect(fake.count('/auth/refresh')).toBeGreaterThanOrEqual(1)
  })

  it('stops asking for commands once stopped', async () => {
    const { fake, makeService } = await commandApp()
    const service = makeService()
    service.start('uuid-jarvis')
    const pending = () =>
      fake.calls.filter((call) => call.path.startsWith('/device/commands/pending')).length
    await waitUntil(() => pending() >= 2)
    await service.stop()
    const seen = pending()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(pending()).toBe(seen)
  })

  it("asks only for this device's commands with the signed-in token", async () => {
    const { fake, makeService } = await commandApp()
    const service = makeService()
    service.start('uuid-jarvis')
    await waitUntil(() =>
      fake.calls.some((call) => call.path.startsWith('/device/commands/pending'))
    )
    await service.stop()
    const call = fake.calls.find((entry) => entry.path.startsWith('/device/commands/pending'))
    expect(call?.method).toBe('GET')
    expect(call?.path).toContain('limit=10')
    expect(call?.authorization).toMatch(/^Bearer acc_/)
  })
})
