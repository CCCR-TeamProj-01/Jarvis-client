import { describe, expect, it, vi } from 'vitest'
import type { CommandApiPort, PendingItem, SendOutcome } from '../../src/main/commands/command-api'
import { CommandJournal } from '../../src/main/commands/command-journal'
import type { CommandResult } from '../../src/main/commands/command-result'
import { CommandService } from '../../src/main/commands/command-service'
import type { CommandFinished } from '../../src/main/commands/command-service'
import { ServerCommandSchema } from '../../src/main/commands/server-command'
import { ToolExecutionReportSchema } from '../../src/shared/contracts/tools'
import type { ToolExecutionReport, ToolInvocation } from '../../src/shared/contracts/tools'
import { MemoryFiles } from '../helpers/memory-files'

const T0 = Date.parse('2026-10-23T03:00:00.000Z')
const CHROME = 'com.google.Chrome'
const signal = () => new AbortController().signal

class FakeApi implements CommandApiPort {
  items: PendingItem[] = []
  outcomes: SendOutcome[] = []
  readonly sent: { commandId: string; result: CommandResult }[] = []
  async pending() {
    return { ok: true as const, value: { items: [...this.items], pollAfterMs: undefined } }
  }
  async send(commandId: string, result: CommandResult): Promise<SendOutcome> {
    this.sent.push({ commandId, result })
    return this.outcomes.shift() ?? { kind: 'stored' }
  }
}

const command = (
  id: number,
  type: string,
  code: string | null = null,
  args: Record<string, unknown> = {},
  requestedAt = new Date(T0).toISOString()
): PendingItem => ({
  kind: 'command',
  command: ServerCommandSchema.parse({
    command_id: id,
    attempt_no: 1,
    command_type: type,
    requested_app_code: code,
    arguments: args,
    requested_at: requestedAt
  })
})

type Outcome = ToolExecutionReport['outcome']
const report = (invocation: ToolInvocation, outcome: Outcome): ToolExecutionReport =>
  ToolExecutionReportSchema.parse({
    requestId: invocation.requestId,
    executionId: invocation.executionId,
    tool: invocation.command.tool,
    outcome,
    cancelRequested: false,
    expired: false
  })
const app = (status: 'confirmed' | 'dispatched' | 'unknown', appId = CHROME): Outcome => ({
  status: 'observed',
  observation: { kind: 'app', appId, status }
})

function setup(options: { onFinished?: (finished: CommandFinished) => void } = {}) {
  const files = new MemoryFiles()
  const api = new FakeApi()
  const finished: CommandFinished[] = []
  const order: string[] = []
  const logs: string[] = []
  let behave: (invocation: ToolInvocation) => Outcome | Promise<Outcome> = () => app('confirmed')
  let thrown = false
  const nowRef = { ms: T0 + 1000 }
  const build = (fresh: { files?: MemoryFiles } = {}) =>
    new CommandService({
      api: {
        pending: api.pending.bind(api),
        send: async (id, result) => {
          order.push('send')
          return api.send(id, result)
        }
      },
      journal: new CommandJournal({ files: fresh.files ?? files, now: () => nowRef.ms }),
      executor: {
        async execute(invocation) {
          order.push('run')
          if (thrown) throw new Error('boom')
          return report(invocation, await behave(invocation))
        }
      },
      platform: 'darwin',
      now: () => nowRef.ms,
      clock: { serverTimeAt: (local) => local },
      sleep: async () => undefined,
      log: (message) => logs.push(message),
      displayName: (osAppId) => (osAppId === CHROME ? 'Google Chrome' : undefined),
      onFinished: (info) => {
        order.push('announce')
        finished.push(info)
        options.onFinished?.(info)
      }
    })
  return {
    api,
    finished,
    order,
    logs,
    nowRef,
    service: build(),
    build,
    files,
    behave: (fn: typeof behave) => (behave = fn),
    throwOnRun: () => (thrown = true)
  }
}

describe('telling that a command is done', () => {
  it('says a command that ran and was seen to work was a success, naming the app as the user knows it', async () => {
    const t = setup()
    t.api.items = [command(1, 'apps.launch', 'chrome')]
    await t.service.cycle('u1', signal())
    expect(t.finished).toEqual([
      {
        commandId: '1',
        attemptNo: 1,
        text: 'Google Chrome을(를) 열었어요.',
        ok: true,
        outcome: 'success'
      }
    ])
  })

  it('does not call a request that was only handed over a success', async () => {
    const t = setup()
    t.behave(() => app('dispatched'))
    t.api.items = [command(1, 'apps.launch', 'chrome')]
    await t.service.cycle('u1', signal())
    expect(t.finished[0]).toMatchObject({
      outcome: 'requested',
      text: 'Google Chrome 실행을 요청했어요.'
    })
  })

  it('says it could not be told when the result is not known', async () => {
    const t = setup()
    t.behave(() => app('unknown'))
    t.api.items = [command(1, 'apps.activate', 'chrome')]
    await t.service.cycle('u1', signal())
    expect(t.finished[0]).toMatchObject({ outcome: 'unknown', ok: false })
  })

  it('says a command that failed did, with the reason, so "switch to an app that is not running" is not silent', async () => {
    const t = setup()
    t.behave(() => ({
      status: 'failed',
      effect: 'none',
      error: { code: 'not_found', message: '앱이 실행 중이 아니라서 전환할 수 없습니다.' }
    }))
    t.api.items = [command(1, 'apps.activate', 'chrome')]
    await t.service.cycle('u1', signal())
    expect(t.finished[0]).toEqual({
      commandId: '1',
      attemptNo: 1,
      text: '앱 전환에 실패했어요. 앱이 실행 중이 아니라서 전환할 수 없습니다.',
      ok: false,
      outcome: 'failure'
    })
  })

  it('says a command this client does not run was refused, and which one it was', async () => {
    const t = setup()
    t.api.items = [command(1, 'apps.close', 'chrome')]
    await t.service.cycle('u1', signal())
    expect(t.finished[0]).toEqual({
      commandId: '1',
      attemptNo: 1,
      text: '앱 종료: 이 기기에서는 지원하지 않는 명령이에요.',
      ok: false,
      outcome: 'failure'
    })
    // Nothing ran.
    expect(t.order).not.toContain('run')
  })

  it('says a command with bad arguments was refused', async () => {
    const t = setup()
    t.api.items = [command(1, 'system.volume', null, { mode: 'set', level: 500 })]
    await t.service.cycle('u1', signal())
    expect(t.finished[0]).toMatchObject({ outcome: 'failure' })
    expect(t.finished[0]!.text).toMatch(/^볼륨 조절: /)
  })

  it('says a command that came too late was not run', async () => {
    const t = setup()
    t.api.items = [command(1, 'apps.launch', 'chrome', {}, new Date(T0 - 5 * 60_000).toISOString())]
    await t.service.cycle('u1', signal())
    expect(t.finished[0]).toMatchObject({
      outcome: 'failure',
      text: '앱 실행: 요청 시간이 지나 실행하지 않았어요.'
    })
    expect(t.order).not.toContain('run')
  })

  it('says it could not be told whether a command that was cut short ran', async () => {
    const t = setup()
    t.throwOnRun()
    t.api.items = [command(1, 'system.mute', null, { muted: true })]
    await t.service.cycle('u1', signal())
    expect(t.finished[0]).toEqual({
      commandId: '1',
      attemptNo: 1,
      text: '음소거: 명령이 실행됐는지 확인하지 못했어요.',
      ok: false,
      outcome: 'unknown'
    })
  })

  it('says one for each command, in the order they ran, also after one that failed', async () => {
    const t = setup()
    t.api.items = [
      command(1, 'apps.close', 'chrome'),
      command(2, 'apps.launch', 'chrome'),
      command(3, 'system.mute', null, { muted: true })
    ]
    await t.service.cycle('u1', signal())
    expect(t.finished.map((entry) => [entry.commandId, entry.outcome])).toEqual([
      ['1', 'failure'],
      ['2', 'success'],
      ['3', 'unknown']
    ])
  })

  it('says it when the command is done, before the result goes to the server', async () => {
    const t = setup()
    t.api.items = [command(1, 'apps.launch', 'chrome')]
    await t.service.cycle('u1', signal())
    expect(t.order).toEqual(['run', 'announce', 'send'])
  })
})

describe('what is not told', () => {
  it('is a command the journal had already seen, which is not run and not shown again', async () => {
    const t = setup()
    t.api.items = [command(1, 'apps.launch', 'chrome')]
    await t.service.cycle('u1', signal())
    t.finished.length = 0
    // The server sends it again, and a new run of the app finds it in the journal.
    await t.build().cycle('u1', signal())
    expect(t.finished).toEqual([])
  })

  it('is a result sent again after the first send failed', async () => {
    const t = setup()
    t.api.outcomes.push({ kind: 'retry' })
    t.api.items = [command(1, 'apps.launch', 'chrome')]
    await t.service.cycle('u1', signal())
    t.api.items = []
    await t.service.cycle('u1', signal())
    expect(t.api.sent).toHaveLength(2)
    expect(t.finished).toHaveLength(1)
  })

  it('is a command whose run was cancelled because the user signed out', async () => {
    const t = setup()
    const abort = new AbortController()
    t.behave(async () => {
      abort.abort()
      return app('confirmed')
    })
    t.api.items = [command(1, 'apps.launch', 'chrome')]
    await t.service.cycle('u1', abort.signal)
    expect(t.finished).toEqual([])
  })
})

describe('when what shows the results fails', () => {
  it('goes on: the command was run and its result is still reported', async () => {
    const t = setup({
      onFinished: () => {
        throw new Error('window closed')
      }
    })
    t.api.items = [command(1, 'apps.launch', 'chrome')]
    await t.service.cycle('u1', signal())
    expect(t.api.sent).toHaveLength(1)
    expect(t.api.sent[0]!.result.status).toBe('success')
    expect(t.logs).toContain('명령 결과를 화면에 알리지 못했어요.')
  })

  it('does not put what went wrong in the log', async () => {
    const t = setup({
      onFinished: () => {
        throw new Error('secret https://example.com/private?token=SECRET')
      }
    })
    t.api.items = [command(1, 'apps.launch', 'chrome')]
    await t.service.cycle('u1', signal())
    expect(t.logs.join(' ')).not.toMatch(/SECRET|example\.com/)
  })
})

describe('what the user is shown', () => {
  it('has no address, path, search word or command type of the server’s, only fixed words and an app name', async () => {
    const t = setup()
    t.behave(() => ({
      status: 'observed',
      observation: {
        kind: 'url',
        url: 'https://example.com/private/path?token=SECRET',
        status: 'dispatched'
      }
    }))
    t.api.items = [
      command(1, 'browser.open', null, { url: 'https://example.com/private/path?token=SECRET' }),
      command(2, 'apps.explode', 'chrome')
    ]
    await t.service.cycle('u1', signal())
    const shown = t.finished.map((entry) => entry.text).join(' | ')
    expect(shown).not.toMatch(/SECRET|private|path|token/)
    expect(shown).not.toContain('apps.explode')
    // The site's name is all that is said of an address.
    expect(t.finished[0]!.text).toContain('example.com')
  })

  it('is told once per command, under one request ID of its own, for a retried attempt too', async () => {
    const seen = vi.fn<(finished: CommandFinished) => void>()
    const t = setup({ onFinished: seen })
    t.api.items = [command(7, 'apps.launch', 'chrome')]
    await t.service.cycle('u1', signal())
    expect(seen).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ commandId: '7', attemptNo: 1 })
    )
  })
})
