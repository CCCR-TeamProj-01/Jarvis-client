import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollectionConsentApi } from '../../src/main/commands/collection-consent'
import { createCommandService } from '../../src/main/commands/create-command-service'
import type { AppControlPort, FolderOpenPort, SystemAudioPort } from '../../src/main/platform/ports'
import { CapabilityRegistry, platformCapabilities } from '../../src/main/tools/capability-registry'
import { ToolExecutor } from '../../src/main/tools/tool-executor'
import { ToolNotices } from '../../src/main/tools/tool-notices'
import type { ToolNotice } from '../../src/main/tools/tool-notices'
import { UiEventSchema } from '../../src/shared/contracts/interaction'
import { stopAllFakeServers } from '../fixtures/fake-jarvis-server'
import { signedInApp } from '../fixtures/signed-in-app'
import { MemoryFiles } from '../helpers/memory-files'
import { waitUntil } from '../helpers/wait'

afterEach(stopAllFakeServers)

const CHROME = 'com.google.Chrome'

/** The app's command path as it is built in the app, over a real connection, listening where the window and overlay do. */
async function noticeApp(options: { consent?: boolean } = {}) {
  const app = await signedInApp()
  const running = new Set<string>()
  const apps: AppControlPort = {
    list: vi.fn<AppControlPort['list']>(async () => ({ ok: true, value: [] })),
    launch: vi.fn<AppControlPort['launch']>(async (appId) => {
      running.add(appId)
      return { ok: true, value: { kind: 'app', appId, status: 'confirmed' } }
    }),
    activate: vi.fn<AppControlPort['activate']>(async (appId) =>
      running.has(appId)
        ? { ok: true, value: { kind: 'app', appId, status: 'confirmed' } }
        : {
            ok: false,
            error: { code: 'not_found', message: '앱이 실행 중이 아니라서 전환할 수 없습니다.' }
          }
    ),
    restore: vi.fn<AppControlPort['restore']>(),
    getForegroundWindow: vi.fn<AppControlPort['getForegroundWindow']>(),
    switchRecentTask: vi.fn<AppControlPort['switchRecentTask']>(),
    openUrl: vi.fn<AppControlPort['openUrl']>(async (url) => ({
      ok: true,
      value: { kind: 'url', url, status: 'dispatched' }
    }))
  }
  const executor = new ToolExecutor({
    registry: new CapabilityRegistry(platformCapabilities('darwin')),
    appControl: apps,
    folders: { open: vi.fn<FolderOpenPort['open']>() },
    audio: {
      setVolume: vi.fn<SystemAudioPort['setVolume']>(),
      adjustVolume: vi.fn<SystemAudioPort['adjustVolume']>(),
      setMuted: vi.fn<SystemAudioPort['setMuted']>(async (muted) => ({
        ok: true,
        value: { kind: 'audio', level: 30, muted, status: 'confirmed' }
      }))
    },
    auth: { requireSignedIn: () => ({ ok: true, value: undefined }) },
    clock: { now: () => performance.now() },
    restoreTarget: () => null
  })
  const hub = new ToolNotices()
  const shown: ToolNotice[] = []
  hub.subscribe((notice) => shown.push(notice))
  const service = createCommandService({
    isPackaged: false,
    env: {},
    api: app.api,
    executor,
    files: new MemoryFiles(),
    appControl: apps,
    consent: options.consent === false ? null : new CollectionConsentApi(app.api),
    announce: (notice) => hub.publish(notice),
    platform: 'darwin'
  })!
  let nextId = 300
  const add = (
    command_type: string,
    code: string | null = null,
    args: Record<string, unknown> = {}
  ) => {
    const command_id = nextId++
    app.fake.commands.push({
      command_id,
      attempt_no: 1,
      command_type,
      requested_app_code: code,
      arguments: args,
      requested_at: new Date().toISOString()
    })
    return command_id
  }
  return { ...app, service, add, shown, apps }
}

describe('results of the server’s commands, over HTTP', () => {
  it('shows a command that worked as a success, naming the app as the user knows it', async () => {
    const t = await noticeApp()
    const id = t.add('apps.launch', 'chrome')
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.shown.length === 1)
    await t.service.stop()
    expect(t.shown[0]).toEqual({
      type: 'tool',
      requestId: `cmd-${id}`,
      executionId: `cmd-${id}:1`,
      text: 'Google Chrome을(를) 열었어요.',
      ok: true,
      outcome: 'success'
    })
    // And the server was told as before.
    await waitUntil(() => t.fake.results.has(id))
    expect(t.fake.results.get(id)).toMatchObject({
      status: 'success',
      observation_status: 'confirmed'
    })
  })

  it('shows "switch to an app that is not running" as a failure, with why', async () => {
    const t = await noticeApp()
    t.add('apps.activate', 'chrome')
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.shown.length === 1)
    await t.service.stop()
    expect(t.shown[0]).toMatchObject({
      outcome: 'failure',
      ok: false,
      text: '앱 전환에 실패했어요. 앱이 실행 중이 아니라서 전환할 수 없습니다.'
    })
  })

  it('shows what was only handed over as requested, and what this client cannot do as a failure', async () => {
    const t = await noticeApp()
    t.add('browser.open', null, { url: 'https://example.com/private?token=SECRET' })
    t.add('apps.close', 'chrome')
    t.add('system.mute', null, { muted: true })
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.shown.length === 3)
    await t.service.stop()
    expect(t.shown.map((notice) => notice.outcome)).toEqual(['requested', 'failure', 'success'])
    expect(t.shown[1]!.text).toBe('앱 종료: 이 기기에서는 지원하지 않는 명령이에요.')
    expect(t.shown.map((notice) => notice.text).join(' ')).not.toMatch(/SECRET|private|token/)
  })

  it('shows each command once, though the server sends it again until it has the result', async () => {
    const t = await noticeApp()
    t.add('apps.launch', 'chrome')
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.shown.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 120))
    await t.service.stop()
    expect(t.shown).toHaveLength(1)
    expect(t.apps.launch).toHaveBeenCalledTimes(1)
  })

  it('is something the window takes as a line of its own', async () => {
    const t = await noticeApp()
    const id = t.add('apps.launch', 'chrome')
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.shown.length === 1)
    await t.service.stop()
    const notice = t.shown[0]!
    // What Main sends the window for it passes the window's own contract.
    expect(
      UiEventSchema.safeParse({
        type: 'result.available',
        requestId: notice.requestId,
        role: 'tool',
        text: notice.text,
        outcome: notice.outcome
      }).success
    ).toBe(true)
    expect(notice.requestId).toBe(`cmd-${id}`)
  })

  it('shows nothing for a command whose run was cut short by signing out', async () => {
    const t = await noticeApp()
    // The launch is still going on when the user signs out, and stops as the real one does.
    t.apps.launch = vi.fn<AppControlPort['launch']>(
      (_appId, options) =>
        new Promise((resolve) =>
          options?.signal?.addEventListener(
            'abort',
            () => resolve({ ok: false, error: { code: 'cancelled', message: '취소됐어요.' } }),
            { once: true }
          )
        )
    )
    t.add('apps.launch', 'chrome')
    t.service.start('uuid-jarvis')
    await new Promise((resolve) => setTimeout(resolve, 80))
    await t.service.stop()
    expect(t.shown).toEqual([])
  })
})

describe('the name of an app in a result', () => {
  it('is the name the user knows, not the OS identifier', async () => {
    const t = await noticeApp()
    t.add('apps.launch', 'slack')
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.shown.length === 1)
    await t.service.stop()
    expect(t.shown[0]!.text).toBe('Slack을(를) 열었어요.')
    expect(t.shown[0]!.text).not.toContain(CHROME)
    expect(t.shown[0]!.text).not.toContain('com.tinyspeck')
  })
})

describe('the activity the commands report, as the app wires it', () => {
  it('reports the app that was started when the commands have a consent to go by', async () => {
    const t = await noticeApp()
    const id = t.add('apps.launch', 'chrome')
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.fake.results.has(id))
    await t.service.stop()
    expect(t.fake.activities).toEqual([
      expect.objectContaining({ commandId: id, eventType: 'launched', appCode: 'chrome' })
    ])
  })

  it('reports no activity at all when there is no consent to go by', async () => {
    const t = await noticeApp({ consent: false })
    const id = t.add('apps.launch', 'chrome')
    t.service.start('uuid-jarvis')
    await waitUntil(() => t.fake.results.has(id))
    await t.service.stop()
    expect(t.fake.results.get(id)).toMatchObject({ status: 'success' })
    expect(t.fake.results.get(id)).not.toHaveProperty('activity')
    expect(t.fake.activities).toEqual([])
  })
})
