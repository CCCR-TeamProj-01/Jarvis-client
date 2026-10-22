import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollectionConsentApi } from '../../src/main/commands/collection-consent'
import { CommandApi } from '../../src/main/commands/command-api'
import { CommandJournal } from '../../src/main/commands/command-journal'
import { CommandService } from '../../src/main/commands/command-service'
import type { AppControlPort, FolderOpenPort, SystemAudioPort } from '../../src/main/platform/ports'
import { CapabilityRegistry, platformCapabilities } from '../../src/main/tools/capability-registry'
import { ToolExecutor } from '../../src/main/tools/tool-executor'
import { stopAllFakeServers } from '../fixtures/fake-jarvis-server'
import { signedInApp } from '../fixtures/signed-in-app'
import { MemoryFiles } from '../helpers/memory-files'
import { waitUntil } from '../helpers/wait'

afterEach(stopAllFakeServers)

const CHROME = 'com.google.Chrome'
const VSCODE = 'com.microsoft.VSCode'

/** The command path with activity, over a real connection to a stand-in that follows the real server's rules. */
async function activityApp(options: { running?: string[] } = {}) {
  const app = await signedInApp()
  let running = options.running ?? [VSCODE, 'org.example.Secret']
  const apps: AppControlPort = {
    list: vi.fn<AppControlPort['list']>(async () => ({
      ok: true,
      value: running.map((appId) => ({ appId, displayName: appId, state: 'running' as const }))
    })),
    launch: vi.fn<AppControlPort['launch']>(async (appId) => {
      running = [...running, appId]
      return { ok: true, value: { kind: 'app', appId, status: 'confirmed' } }
    }),
    activate: vi.fn<AppControlPort['activate']>(async (appId) => ({
      ok: true,
      value: { kind: 'app', appId, status: 'confirmed' }
    })),
    restore: vi.fn<AppControlPort['restore']>(),
    getForegroundWindow: vi.fn<AppControlPort['getForegroundWindow']>(),
    switchRecentTask: vi.fn<AppControlPort['switchRecentTask']>(),
    openUrl: vi.fn<AppControlPort['openUrl']>()
  }
  const executor = new ToolExecutor({
    registry: new CapabilityRegistry(platformCapabilities('darwin')),
    appControl: apps,
    folders: { open: vi.fn<FolderOpenPort['open']>() },
    audio: {
      setVolume: vi.fn<SystemAudioPort['setVolume']>(),
      adjustVolume: vi.fn<SystemAudioPort['adjustVolume']>(),
      setMuted: vi.fn<SystemAudioPort['setMuted']>()
    },
    auth: { requireSignedIn: () => ({ ok: true, value: undefined }) },
    clock: { now: () => performance.now() },
    restoreTarget: () => null
  })
  const files = new MemoryFiles()
  const logs: string[] = []
  /** Time the service sees, moved on by tests that need what was read before to be old. */
  const shift = { ms: 0 }
  let ids = 0
  const service = new CommandService({
    api: new CommandApi(app.api),
    journal: new CommandJournal({ files, now: Date.now }),
    executor,
    platform: 'darwin',
    now: () => Date.now() + shift.ms,
    clock: app.api.clock,
    sleep: async () => undefined,
    activity: {
      consent: new CollectionConsentApi(app.api),
      runningApps: async (signal) => {
        const listed = await apps.list(signal ? { signal } : undefined)
        if (!listed.ok) return { ok: false, error: listed.error }
        return {
          ok: true,
          value: listed.value
            .filter((entry) => entry.state === 'running')
            .map((entry) => entry.appId)
        }
      },
      createId: () => `act_test_${++ids}`
    },
    log: (message) => logs.push(message)
  })
  let nextId = 100
  const add = (command_type: string, code: string | null = 'chrome') => {
    const command_id = nextId++
    app.fake.commands.push({
      command_id,
      attempt_no: 1,
      command_type,
      requested_app_code: code,
      arguments: {},
      requested_at: new Date().toISOString()
    })
    return command_id
  }
  const run = async (id: number) => {
    await service.cycle('uuid-jarvis', new AbortController().signal)
    await waitUntil(() => app.fake.results.has(id))
  }
  return {
    ...app,
    apps,
    service,
    add,
    run,
    logs,
    shift,
    setRunning: (value: string[]) => (running = value)
  }
}

describe('reporting what the user did with apps, over HTTP', () => {
  it('records a launch that started an app, with the running apps the server knows, and nothing else', async () => {
    const t = await activityApp()
    const id = t.add('apps.launch')
    await t.run(id)
    expect(t.fake.results.get(id)).toMatchObject({
      status: 'success',
      observation_status: 'confirmed',
      app: { app_code: 'chrome' }
    })
    expect(t.fake.activities).toEqual([
      {
        commandId: id,
        eventKey: 'act_test_1',
        eventType: 'launched',
        appCode: 'chrome',
        occurredAt: expect.any(String),
        runningApps: ['chrome', 'vscode']
      }
    ])
    // The server was told nothing about the app it has no code for.
    expect(JSON.stringify(t.fake.results.get(id))).not.toContain('Secret')
    expect(JSON.stringify(t.fake.results.get(id))).not.toContain('org.example')
  })

  it('records an app that was already running as brought to the front, not as started', async () => {
    const t = await activityApp({ running: [CHROME, VSCODE] })
    const id = t.add('apps.launch')
    await t.run(id)
    expect(t.fake.activities[0]).toMatchObject({ commandId: id, eventType: 'activated' })
  })

  it('records activating an app as brought to the front', async () => {
    const t = await activityApp({ running: [CHROME] })
    const id = t.add('apps.activate')
    await t.run(id)
    expect(t.fake.activities[0]).toMatchObject({ eventType: 'activated', appCode: 'chrome' })
  })

  it('reads the settings it is told by the server, one read for the command and none more for sending', async () => {
    const t = await activityApp()
    t.fake.calls.length = 0
    const id = t.add('apps.launch')
    await t.run(id)
    expect(t.fake.count('/me/settings')).toBe(1)
    expect(t.fake.calls.filter((call) => call.path === `/commands/${id}/results`)).toHaveLength(1)
  })

  it('sends the revision the server holds, so a recorded activity is one it accepts', async () => {
    const t = await activityApp()
    t.fake.calendarSettings = { ...t.fake.calendarSettings, collection_revision: 17 }
    const id = t.add('apps.launch')
    await t.run(id)
    expect(t.fake.results.get(id)?.activity).toMatchObject({ collection_revision: 17 })
    expect(t.fake.activities).toHaveLength(1)
  })
})

describe('without the user’s consent', () => {
  it('sends no activity, looks at no apps, and the command still runs and is reported', async () => {
    const t = await activityApp()
    t.fake.calendarSettings = {
      ...t.fake.calendarSettings,
      activity_collection_enabled: false,
      external_activity_collection_enabled: false
    }
    const id = t.add('apps.launch')
    await t.run(id)
    expect(t.fake.results.get(id)).toMatchObject({ status: 'success' })
    expect(t.fake.results.get(id)).not.toHaveProperty('activity')
    expect(t.fake.activities).toEqual([])
    expect(t.apps.list).not.toHaveBeenCalled()
    expect(t.apps.launch).toHaveBeenCalledTimes(1)
  })

  it('sends the activity but not the list of apps when only the activity consent is on', async () => {
    const t = await activityApp()
    t.fake.calendarSettings = {
      ...t.fake.calendarSettings,
      external_activity_collection_enabled: false
    }
    const id = t.add('apps.launch')
    await t.run(id)
    expect(t.fake.activities[0]).toMatchObject({ eventType: 'launched', runningApps: null })
    expect(t.fake.results.get(id)?.activity).not.toHaveProperty('running_apps')
    // Looked at once, before the launch, to tell a start from a coming to the front; never after.
    expect(t.apps.list).toHaveBeenCalledTimes(1)
  })

  it('sends no activity when the settings cannot be read, and still reports the command', async () => {
    const t = await activityApp()
    t.fake.calendarSettings = { timezone: 'Asia/Seoul' }
    const id = t.add('apps.launch')
    await t.run(id)
    expect(t.fake.results.get(id)).toMatchObject({ status: 'success' })
    expect(t.fake.results.get(id)).not.toHaveProperty('activity')
    expect(t.fake.activities).toEqual([])
  })
})

describe('when the settings change while the result waits', () => {
  it('leaves the activity out of a result sent after the consent was withdrawn, and the result is stored', async () => {
    const t = await activityApp()
    const id = t.add('apps.launch')
    // The first send is lost on the way.
    t.fake.resultFaults = [503]
    await t.service.cycle('uuid-jarvis', new AbortController().signal)
    expect(t.fake.results.has(id)).toBe(false)
    // Meanwhile the user turns the collection off, elsewhere.
    t.fake.calendarSettings = {
      ...t.fake.calendarSettings,
      activity_collection_enabled: false,
      collection_revision: 4
    }
    // Long enough since the consent was read that it is read again.
    t.shift.ms = 120_000
    await t.service.cycle('uuid-jarvis', new AbortController().signal)
    await waitUntil(() => t.fake.results.has(id))
    expect(t.fake.results.get(id)).toMatchObject({ status: 'success' })
    expect(t.fake.results.get(id)).not.toHaveProperty('activity')
    expect(t.fake.activities).toEqual([])
  })

  it('does not ask the server to record an activity made under an old revision', async () => {
    const t = await activityApp()
    const id = t.add('apps.launch')
    t.fake.resultFaults = [503]
    await t.service.cycle('uuid-jarvis', new AbortController().signal)
    t.fake.calendarSettings = { ...t.fake.calendarSettings, collection_revision: 9 }
    t.shift.ms = 120_000
    await t.service.cycle('uuid-jarvis', new AbortController().signal)
    await waitUntil(() => t.fake.results.has(id))
    expect(t.fake.results.get(id)).not.toHaveProperty('activity')
  })
})

describe('sending the same result again', () => {
  it('is not a conflict when the activity differs, as on the real server, and is stored once', async () => {
    const t = await activityApp()
    const id = t.add('apps.launch')
    await t.run(id)
    const stored = t.fake.results.get(id)!
    const { activity: _activity, ...withoutActivity } = stored
    const again = await fetch(`${t.baseUrl}/commands/${id}/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.tokens.get()}` },
      body: JSON.stringify(withoutActivity)
    })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ activity_recorded: true })
    expect(t.fake.activities).toHaveLength(1)
  })

  it('does not make an activity afterwards for a result that was stored without one', async () => {
    const t = await activityApp()
    t.fake.calendarSettings = { ...t.fake.calendarSettings, activity_collection_enabled: false }
    const id = t.add('apps.launch')
    await t.run(id)
    t.fake.calendarSettings = { ...t.fake.calendarSettings, activity_collection_enabled: true }
    const stored = t.fake.results.get(id)!
    const again = await fetch(`${t.baseUrl}/commands/${id}/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.tokens.get()}` },
      body: JSON.stringify({
        ...stored,
        activity: {
          event_key: 'act_late',
          event_type: 'launched',
          occurred_at: new Date().toISOString(),
          collection_revision: 3
        }
      })
    })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ activity_recorded: false })
    expect(t.fake.activities).toEqual([])
  })
})

describe('what is not an activity', () => {
  it('is a command that uses no app', async () => {
    const t = await activityApp()
    t.fake.calls.length = 0
    const id = t.add('system.mute', null)
    t.fake.commands.at(-1)!.arguments = { muted: true }
    await t.service.cycle('uuid-jarvis', new AbortController().signal)
    await waitUntil(() => t.fake.results.has(id))
    expect(t.fake.count('/me/settings')).toBe(0)
    expect(t.fake.activities).toEqual([])
  })
})
