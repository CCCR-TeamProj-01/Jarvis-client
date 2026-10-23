import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollectionSettingsService } from '../../src/main/collection/collection-settings-service'
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
async function activityApp(options: { running?: string[]; viaSettings?: boolean } = {}) {
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
  // With the settings service, the consent is read through it, as the app does, and a change makes the commands read it again.
  const settings = options.viaSettings
    ? new CollectionSettingsService({
        api: new CollectionConsentApi(app.api),
        now: Date.now,
        onChanged: () => service.forgetConsent()
      })
    : null
  settings?.start('uuid-jarvis')
  const service = new CommandService({
    api: new CommandApi(app.api),
    journal: new CommandJournal({ files, now: Date.now }),
    executor,
    platform: 'darwin',
    now: () => Date.now() + shift.ms,
    clock: app.api.clock,
    sleep: async () => undefined,
    activity: {
      consent: settings ?? new CollectionConsentApi(app.api),
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
    settings,
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

describe('withdrawing the consent while the app runs, over HTTP', () => {
  const turn = async (
    t: Awaited<ReturnType<typeof activityApp>>,
    flag: 'activity' | 'external',
    on: boolean
  ) => {
    const result = await t.settings!.command({ action: 'set', flag, on })
    if (!result.ok) throw new Error(result.error.code)
    return result.value
  }

  it('reports nothing for a command that runs after the user turned activity off', async () => {
    const t = await activityApp({ viaSettings: true })
    await t.settings!.command({ action: 'refresh' })
    const first = t.add('apps.launch')
    await t.run(first)
    expect(t.fake.activities).toHaveLength(1)
    const state = await turn(t, 'activity', false)
    expect(state.outcome).toMatchObject({ kind: 'saved', on: false })
    // The server took both flags off in one change, and the revision moved.
    expect(t.fake.settingsChanges).toEqual([
      { activity_collection_enabled: false, external_activity_collection_enabled: false }
    ])
    expect(t.fake.calendarSettings.collection_revision).toBe(4)
    const second = t.add('apps.launch', 'slack')
    await t.run(second)
    expect(t.fake.results.get(second)).toMatchObject({ status: 'success' })
    expect(t.fake.results.get(second)).not.toHaveProperty('activity')
    expect(t.fake.activities).toHaveLength(1)
  })

  it('drops the activity of a result still waiting to be sent when the user turns it off', async () => {
    const t = await activityApp({ viaSettings: true })
    await t.settings!.command({ action: 'refresh' })
    // The result is made under the consent, but cannot be sent yet.
    t.fake.resultFaults = [503]
    const id = t.add('apps.launch')
    await t.service.cycle('uuid-jarvis', new AbortController().signal)
    expect(t.fake.results.has(id)).toBe(false)
    await turn(t, 'activity', false)
    await t.service.cycle('uuid-jarvis', new AbortController().signal)
    await waitUntil(() => t.fake.results.has(id))
    expect(t.fake.results.get(id)).toMatchObject({ status: 'success' })
    expect(t.fake.results.get(id)).not.toHaveProperty('activity')
    expect(t.fake.activities).toEqual([])
  })

  it('stops reporting at once even when the server does not take the withdrawal', async () => {
    const t = await activityApp({ viaSettings: true })
    await t.settings!.command({ action: 'refresh' })
    t.fake.settingsWriteFaults = [503]
    const state = await turn(t, 'activity', false)
    expect(state.outcome).toMatchObject({ kind: 'unconfirmed', on: false })
    // The server still has it on, but nothing is reported from this computer.
    expect(state.settings).toEqual({ activity: true, external: true })
    expect(state.stopped).toEqual({ activity: true, external: true })
    expect(t.fake.calendarSettings.activity_collection_enabled).toBe(true)
    const id = t.add('apps.launch')
    await t.run(id)
    expect(t.fake.results.get(id)).not.toHaveProperty('activity')
    expect(t.fake.activities).toEqual([])
    // Sending it again works; the hold is let go of because the server now says off.
    const again = await turn(t, 'activity', false)
    expect(again).toMatchObject({
      outcome: { kind: 'saved' },
      stopped: { activity: false, external: false }
    })
    expect(t.fake.calendarSettings.activity_collection_enabled).toBe(false)
  })

  it('takes the running apps out of what is reported when only external is turned off', async () => {
    const t = await activityApp({ viaSettings: true })
    await t.settings!.command({ action: 'refresh' })
    await turn(t, 'external', false)
    expect(t.fake.settingsChanges).toEqual([{ external_activity_collection_enabled: false }])
    const id = t.add('apps.launch')
    await t.run(id)
    expect(t.fake.activities).toEqual([
      expect.objectContaining({ commandId: id, eventType: 'launched', runningApps: null })
    ])
  })

  it('reports again once the user turns it back on, under the new revision', async () => {
    const t = await activityApp({ viaSettings: true })
    await t.settings!.command({ action: 'refresh' })
    await turn(t, 'activity', false)
    const off = t.add('apps.launch')
    await t.run(off)
    expect(t.fake.activities).toEqual([])
    const on = await turn(t, 'activity', true)
    expect(on.outcome).toMatchObject({ kind: 'saved', on: true })
    const id = t.add('apps.launch', 'slack')
    await t.run(id)
    expect(t.fake.activities).toEqual([
      expect.objectContaining({ commandId: id, appCode: 'slack' })
    ])
  })

  it('leaves the settings the server holds alone when the user only reads them', async () => {
    const t = await activityApp({ viaSettings: true })
    const state = await t.settings!.command({ action: 'refresh' })
    expect(state).toMatchObject({
      ok: true,
      value: { settings: { activity: true, external: true } }
    })
    expect(t.fake.settingsChanges).toEqual([])
  })
})
