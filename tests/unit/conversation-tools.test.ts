import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../src/main/conversation/conversation-manager'
import type {
  AssistantPort,
  AssistantTools,
  ConversationNotice
} from '../../src/main/conversation/ports'
import type { AppControlPort, FolderOpenPort } from '../../src/main/platform/ports'
import { DevRemoteSpeech } from '../../src/main/speech/remote-speech/dev-remote-speech'
import { CapabilityRegistry, platformCapabilities } from '../../src/main/tools/capability-registry'
import { ToolExecutor } from '../../src/main/tools/tool-executor'
import type { Result } from '../../src/shared/contracts/common'
import type { AppObservation } from '../../src/shared/contracts/tools'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

/** An app control with a few apps, whose launches can be held open. */
function fakeApps() {
  const launched: string[] = []
  const signals: (AbortSignal | undefined)[] = []
  let hold: Promise<void> | null = null
  const apps = [
    { appId: 'com.apple.Safari', displayName: 'Safari', state: 'running' as const },
    { appId: 'com.google.Chrome', displayName: 'Google Chrome', state: 'stopped' as const },
    { appId: 'com.apple.Notes', displayName: 'Notes', state: 'stopped' as const }
  ]
  const control: AppControlPort = {
    list: async () => ({ ok: true, value: apps }),
    launch: vi.fn<AppControlPort['launch']>(async (appId, execution) => {
      launched.push(appId)
      signals.push(execution?.signal)
      if (hold) await hold
      if (execution?.signal?.aborted)
        return { ok: false, error: { code: 'cancelled', message: '취소' } }
      return {
        ok: true,
        value: { kind: 'app', appId, status: 'confirmed' } satisfies AppObservation
      } as Result<AppObservation>
    }),
    activate: async (appId) => ({ ok: true, value: { kind: 'app', appId, status: 'confirmed' } }),
    getForegroundWindow: async () => ({ ok: true, value: null }),
    restore: async (target) => ({
      ok: true,
      value: { kind: 'app', appId: target.appId, status: 'confirmed' }
    }),
    switchRecentTask: async () => ({
      ok: false,
      error: { code: 'unsupported', message: '지원하지 않습니다.' }
    }),
    openUrl: vi.fn<AppControlPort['openUrl']>(async (url) => ({
      ok: true,
      value: { kind: 'url', url, status: 'dispatched' }
    }))
  }
  return {
    control,
    launched,
    signals,
    holdLaunches() {
      let release: () => void = () => undefined
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        hold = null
        release()
      }
    }
  }
}

function setup(
  assistant: AssistantPort,
  options: { signedIn?: boolean; timeoutMs?: number; withTools?: boolean } = {}
) {
  const app = fakeApps()
  const folders = {
    open: vi.fn<FolderOpenPort['open']>(async (alias) => ({
      ok: true,
      value: { kind: 'folder', alias, status: 'dispatched' }
    }))
  }
  const registry = new CapabilityRegistry(platformCapabilities('darwin'))
  const executor = new ToolExecutor({
    registry,
    appControl: app.control,
    folders,
    auth: {
      requireSignedIn: () =>
        options.signedIn === false
          ? {
              ok: false,
              error: { code: 'authentication_required', message: '로그인이 필요합니다.' }
            }
          : { ok: true, value: undefined }
    },
    clock: { now: () => 1000 },
    restoreTarget: () => ({ appId: 'com.apple.Notes' })
  })
  let ids = 0
  const timers: { callback: () => void; cancelled: boolean; ms: number }[] = []
  const manager = new ConversationManager({
    gate: { check: () => ({ ok: true, value: undefined }) },
    assistant,
    ...(options.withTools === false ? {} : { tools: { executor, registry } }),
    clock: { now: () => 1000 },
    createId: () => `id-${++ids}`,
    schedule: (callback, ms) => {
      const timer = { callback, cancelled: false, ms }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    ...(options.timeoutMs ? { policy: { responseTimeoutMs: options.timeoutMs } } : {})
  })
  const notices: ConversationNotice[] = []
  manager.subscribeNotices((notice) => notices.push(notice))
  return { manager, app, folders, notices, timers, executor }
}

describe('conversation with tools (stand-in assistant)', () => {
  it('opens an app by name: lists apps, launches the match and answers from the result', async () => {
    const { manager, app, notices } = setup(new DevRemoteSpeech())
    const result = await manager.submit({ text: '사파리 열어줘', modality: 'text' })
    expect(result).toMatchObject({ ok: true, value: { reply: { text: 'Safari을(를) 열었어요.' } } })
    expect(app.launched).toEqual(['com.apple.Safari'])
    expect(notices.map((notice) => notice.type)).toEqual(['user', 'tool', 'tool', 'assistant'])
    expect(notices[1]).toMatchObject({ text: '앱 3개를 확인했어요.', ok: true })
    expect(notices[2]).toMatchObject({ text: 'Safari을(를) 열었어요.', ok: true })
  })

  it('matches installed names the spoken name only hints at', async () => {
    const { manager, app } = setup(new DevRemoteSpeech())
    await manager.submit({ text: '크롬 실행해줘', modality: 'speech' })
    expect(app.launched).toEqual(['com.google.Chrome'])
  })

  it('says so when no app matches, and launches nothing', async () => {
    const { manager, app } = setup(new DevRemoteSpeech())
    const result = await manager.submit({ text: '포토샵 열어줘', modality: 'text' })
    expect(result).toMatchObject({
      ok: true,
      value: { reply: { text: '포토샵 앱을 찾지 못했어요.' } }
    })
    expect(app.launched).toEqual([])
  })

  it('opens a standard folder by alias and answers from the result', async () => {
    const { manager, folders, notices } = setup(new DevRemoteSpeech())
    const result = await manager.submit({ text: '다운로드 폴더 열어줘', modality: 'text' })
    expect(folders.open).toHaveBeenCalledWith('downloads', expect.anything())
    expect(result).toMatchObject({
      ok: true,
      value: { reply: { text: '다운로드 폴더를 열도록 요청했어요.' } }
    })
    expect(notices.find((notice) => notice.type === 'tool')).toMatchObject({
      text: '다운로드 폴더를 열도록 요청했어요.',
      ok: true
    })
  })

  it('does not take a plain app request for a folder request', async () => {
    const { manager, folders } = setup(new DevRemoteSpeech())
    await manager.submit({ text: '음악 열어줘', modality: 'text' })
    expect(folders.open).not.toHaveBeenCalled()
  })

  it('opens a well-known site in the browser', async () => {
    const { manager, app } = setup(new DevRemoteSpeech())
    const result = await manager.submit({ text: '유튜브 열어줘', modality: 'text' })
    expect(app.control.openUrl).toHaveBeenCalledWith('https://www.youtube.com', expect.anything())
    expect(result).toMatchObject({
      ok: true,
      value: { reply: { text: '유튜브을(를) 브라우저로 열었어요.' } }
    })
  })

  it('reports why nothing happened when the tool is refused, and the answer follows suit', async () => {
    const { manager, app, notices } = setup(new DevRemoteSpeech(), { signedIn: false })
    const result = await manager.submit({ text: '사파리 열어줘', modality: 'text' })
    expect(app.launched).toEqual([])
    expect(result).toMatchObject({
      ok: true,
      value: { reply: { text: '사파리 앱을 열지 못했어요.' } }
    })
    const tool = notices.find((notice) => notice.type === 'tool')
    expect(tool).toMatchObject({ ok: false })
    expect((tool as { text: string }).text).toContain('로그인이 필요합니다')
  })

  it('lists the apps it can see', async () => {
    const { manager } = setup(new DevRemoteSpeech())
    const result = await manager.submit({ text: '어떤 앱이 있어?', modality: 'text' })
    expect(result).toMatchObject({
      ok: true,
      value: { reply: { text: '앱 3개를 찾았어요: Safari, Google Chrome, Notes' } }
    })
  })

  it('goes back to the previous work', async () => {
    const { manager } = setup(new DevRemoteSpeech())
    const result = await manager.submit({ text: '이전 작업으로 돌아가줘', modality: 'speech' })
    expect(result).toMatchObject({
      ok: true,
      value: { reply: { text: '이전 작업으로 돌아가도록 요청했어요.' } }
    })
  })

  it('opens an address it was given, and nothing else', async () => {
    const { manager, app } = setup(new DevRemoteSpeech())
    await manager.submit({ text: 'https://example.com 열어줘', modality: 'text' })
    expect(app.control.openUrl).toHaveBeenCalledWith('https://example.com', expect.anything())
    await manager.submit({ text: 'file:///etc/passwd 열어줘', modality: 'text' })
    expect(app.control.openUrl).toHaveBeenCalledTimes(1)
  })

  it('answers ordinary requests as before', async () => {
    const { manager } = setup(new DevRemoteSpeech())
    const result = await manager.submit({ text: '안녕', modality: 'text' })
    expect(result).toMatchObject({
      ok: true,
      value: { reply: { text: '(개발용 응답) "안녕"을 받았어요.' } }
    })
  })

  it('without tools configured the assistant gets none and falls back to its plain answer', async () => {
    const { manager, app } = setup(new DevRemoteSpeech(), { withTools: false })
    const result = await manager.submit({ text: '사파리 열어줘', modality: 'text' })
    expect(result).toMatchObject({ ok: true })
    expect(app.launched).toEqual([])
  })
})

describe('conversation with tools (lifecycle)', () => {
  /** An assistant that asks for one launch, waits for it and reports how it ended. */
  function launching() {
    const seen: { tools?: AssistantTools; late?: Promise<unknown> } = {}
    const assistant: AssistantPort = {
      respond: async (_turn, _text, options) => {
        seen.tools = options?.tools
        const report = await options!.tools!.execute({
          executionId: 'e1',
          command: { tool: 'apps.launch', arguments: { appId: 'com.apple.Safari' } }
        })
        return { ok: true, value: { text: report.outcome.status } }
      }
    }
    return { assistant, seen }
  }

  it('cancels a tool that is still running when the conversation ends', async () => {
    const { assistant } = launching()
    const { manager, app } = setup(assistant)
    const release = app.holdLaunches()
    const submitted = manager.submit({ text: '열어줘', modality: 'text' })
    await flush()
    expect(app.signals[0]?.aborted).toBe(false)
    await manager.end()
    expect(app.signals[0]?.aborted).toBe(true)
    expect(await submitted).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    release()
  })

  it('cancels a tool that is still running when the request times out', async () => {
    const { assistant } = launching()
    const { manager, app, timers } = setup(assistant, { timeoutMs: 500 })
    const release = app.holdLaunches()
    const submitted = manager.submit({ text: '열어줘', modality: 'text' })
    await flush()
    timers.find((timer) => timer.ms === 500)!.callback()
    expect(await submitted).toMatchObject({ ok: false, error: { code: 'expired' } })
    expect(app.signals[0]?.aborted).toBe(true)
    release()
  })

  it('refuses a call that arrives after the request has ended', async () => {
    const seen: { tools?: AssistantTools } = {}
    const assistant: AssistantPort = {
      respond: async (_turn, _text, options) => {
        seen.tools = options?.tools
        return { ok: true, value: { text: '끝' } }
      }
    }
    const { manager, app } = setup(assistant)
    await manager.submit({ text: '안녕', modality: 'text' })
    const late = await seen.tools!.execute({
      executionId: 'late',
      command: { tool: 'apps.launch', arguments: { appId: 'com.apple.Safari' } }
    })
    expect(late.outcome).toMatchObject({ status: 'not_started', reason: 'cancelled' })
    expect(app.launched).toEqual([])
  })

  it('gives each request its own tools, so one request cannot replay another’s execution ID', async () => {
    const { assistant } = launching()
    const { manager, app } = setup(assistant)
    await manager.submit({ text: '열어줘', modality: 'text' })
    await manager.submit({ text: '또 열어줘', modality: 'text' })
    // Same execution ID in two requests: both run.
    expect(app.launched).toEqual(['com.apple.Safari', 'com.apple.Safari'])
  })
})
