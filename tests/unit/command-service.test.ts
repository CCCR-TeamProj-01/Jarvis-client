import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommandApiPort, PendingItem, SendOutcome } from '../../src/main/commands/command-api'
import { CommandJournal } from '../../src/main/commands/command-journal'
import type { CommandResult } from '../../src/main/commands/command-result'
import { CommandService } from '../../src/main/commands/command-service'
import { ServerCommandSchema } from '../../src/main/commands/server-command'
import { ToolExecutionReportSchema } from '../../src/shared/contracts/tools'
import type { ToolExecutionReport, ToolInvocation } from '../../src/shared/contracts/tools'

const T0 = Date.parse('2026-10-22T03:00:00.000Z')

class MemoryFiles {
  contents: string | null = null
  failWrites = false
  async read(): Promise<string | null> {
    return this.contents
  }
  async replace(_name: string, contents: string): Promise<void> {
    if (this.failWrites) throw new Error('write failed')
    this.contents = contents
  }
}

class FakeApi implements CommandApiPort {
  items: PendingItem[] = []
  pendingFailure: { retryAfterMs?: number } | null = null
  pollAfterMs: number | undefined
  /** What each send answers, consumed in order; 'stored' when empty. */
  outcomes: SendOutcome[] = []
  readonly sent: { commandId: string; result: CommandResult }[] = []
  pendingCalls = 0
  async pending() {
    this.pendingCalls += 1
    if (this.pendingFailure)
      return {
        ok: false as const,
        error: { code: 'unavailable' as const, message: 'x' },
        retryAfterMs: this.pendingFailure.retryAfterMs
      }
    return { ok: true as const, value: { items: [...this.items], pollAfterMs: this.pollAfterMs } }
  }
  async send(commandId: string, result: CommandResult): Promise<SendOutcome> {
    this.sent.push({ commandId, result })
    return this.outcomes.shift() ?? { kind: 'stored' }
  }
}

function command(overrides: Record<string, unknown> = {}): PendingItem {
  return {
    kind: 'command',
    command: ServerCommandSchema.parse({
      command_id: 1,
      attempt_no: 1,
      command_type: 'system.mute',
      requested_app_code: null,
      arguments: { muted: true },
      requested_at: new Date(T0).toISOString(),
      ...overrides
    })
  }
}

function setup(options: { now?: () => number; offsetMs?: number | null } = {}) {
  const files = new MemoryFiles()
  const api = new FakeApi()
  const executed: ToolInvocation[] = []
  const signals: (AbortSignal | undefined)[] = []
  let behave: (invocation: ToolInvocation) => ToolExecutionReport | Promise<ToolExecutionReport> = (
    invocation
  ) => observed(invocation)
  const nowRef = { ms: T0 + 1000 }
  const now = options.now ?? (() => nowRef.ms)
  const sleeps: number[] = []
  const logs: string[] = []
  const build = (extra: { files?: MemoryFiles; api?: FakeApi } = {}) =>
    new CommandService({
      api: extra.api ?? api,
      journal: new CommandJournal({ files: extra.files ?? files, now }),
      executor: {
        async execute(invocation, runOptions) {
          executed.push(invocation)
          signals.push(runOptions?.signal)
          return behave(invocation)
        }
      },
      platform: 'darwin',
      now,
      clock: {
        serverTimeAt: (local) =>
          options.offsetMs === null ? null : local + (options.offsetMs ?? 0)
      },
      sleep: async (ms, signal) => {
        sleeps.push(ms)
        if (signal.aborted) return
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
          setTimeout(resolve, 5)
        })
      },
      log: (message) => logs.push(message)
    })
  return {
    files,
    api,
    executed,
    signals,
    sleeps,
    logs,
    nowRef,
    service: build(),
    build,
    behave: (fn: typeof behave) => (behave = fn)
  }
}

function observed(invocation: ToolInvocation): ToolExecutionReport {
  const tool = invocation.command.tool
  const outcome =
    tool === 'system.mute'
      ? ({
          status: 'observed',
          observation: { kind: 'audio', level: 30, muted: true, status: 'confirmed' }
        } as const)
      : tool === 'folder.open'
        ? ({
            status: 'observed',
            observation: { kind: 'folder', alias: 'downloads', status: 'dispatched' }
          } as const)
        : ({
            status: 'observed',
            observation: { kind: 'app', appId: 'com.google.Chrome', status: 'confirmed' }
          } as const)
  return ToolExecutionReportSchema.parse({
    requestId: invocation.requestId,
    executionId: invocation.executionId,
    tool,
    outcome,
    cancelRequested: false,
    expired: false
  })
}

const signal = () => new AbortController().signal

describe('running a command', () => {
  it('runs it once, sends the result and settles it in the journal', async () => {
    const { service, api, executed, build, files } = setup()
    api.items = [command()]
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatchObject({
      executionId: 'cmd-1-1',
      command: { tool: 'system.mute', arguments: { muted: true } }
    })
    expect(api.sent).toHaveLength(1)
    expect(api.sent[0]).toMatchObject({
      commandId: '1',
      result: { attempt_no: 1, status: 'success', observation_status: 'confirmed' }
    })
    // A restart sees it as reported: nothing to send or run.
    const again = build()
    await again.cycle('u1', signal())
    expect(executed).toHaveLength(1)
    expect(api.sent).toHaveLength(1)
    expect(files.contents).toContain('"reported"')
  })

  it('does not run a command it already finished when the server sends it again', async () => {
    const { service, api, executed } = setup()
    api.items = [command()]
    await service.cycle('u1', signal())
    await service.cycle('u1', signal())
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(1)
    expect(api.sent).toHaveLength(1)
  })

  it('runs the commands one after another in the order given, and carries on after a failure', async () => {
    const { service, api, executed, behave } = setup()
    api.items = [
      command({ command_id: 1 }),
      command({ command_id: 2, command_type: 'folder.open', arguments: { alias: 'downloads' } }),
      command({ command_id: 3 })
    ]
    behave((invocation) =>
      invocation.executionId === 'cmd-2-1'
        ? ToolExecutionReportSchema.parse({
            requestId: invocation.requestId,
            executionId: invocation.executionId,
            tool: 'folder.open',
            outcome: {
              status: 'failed',
              error: { code: 'not_found', message: 'x' },
              effect: 'none'
            },
            cancelRequested: false,
            expired: false
          })
        : observed(invocation)
    )
    await service.cycle('u1', signal())
    expect(executed.map((invocation) => invocation.executionId)).toEqual([
      'cmd-1-1',
      'cmd-2-1',
      'cmd-3-1'
    ])
    expect(api.sent.map((entry) => [entry.commandId, entry.result.status])).toEqual([
      ['1', 'success'],
      ['2', 'failed'],
      ['3', 'success']
    ])
  })

  it('never starts a second command before the first has finished', async () => {
    const { service, api, behave } = setup()
    api.items = [command({ command_id: 1 }), command({ command_id: 2 })]
    let running = 0
    let overlapped = false
    behave(async (invocation) => {
      running += 1
      if (running > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 10))
      running -= 1
      return observed(invocation)
    })
    await service.cycle('u1', signal())
    expect(overlapped).toBe(false)
  })

  it('treats a throwing executor as an unknown result and does not run the command again', async () => {
    const { service, api, executed, behave } = setup()
    api.items = [command()]
    behave(() => {
      throw new Error('boom')
    })
    await service.cycle('u1', signal())
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(1)
    expect(api.sent[0]?.result).toMatchObject({ status: 'unknown', observation_status: 'unknown' })
    expect(api.sent[0]?.result.failure_stage).toBeUndefined()
  })
})

describe('stopping in the middle of a round', () => {
  it('does not start the commands after the one that was running when it stopped', async () => {
    const { api, executed, behave, build } = setup()
    const live = build()
    api.items = [command({ command_id: 1 }), command({ command_id: 2 }), command({ command_id: 3 })]
    behave(async (invocation) => {
      // The user signs out while the first command runs.
      void live.stop()
      return observed(invocation)
    })
    live.start('u1')
    await waitUntil(() => executed.length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(executed.map((invocation) => invocation.executionId)).toEqual(['cmd-1-1'])
  })
})

describe('commands that are not run', () => {
  it('refuses a command this client has no tool for, without running anything', async () => {
    const { service, api, executed } = setup()
    api.items = [
      command({ command_type: 'apps.close', requested_app_code: 'chrome', arguments: {} })
    ]
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(0)
    expect(api.sent[0]?.result).toMatchObject({
      status: 'rejected',
      failure_stage: 'capability',
      error_code: 'unsupported'
    })
  })

  it('refuses a command with wrong arguments', async () => {
    const { service, api, executed } = setup()
    api.items = [command({ command_type: 'system.volume', arguments: { mode: 'set', level: 500 } })]
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(0)
    expect(api.sent[0]?.result).toMatchObject({ status: 'rejected', failure_stage: 'validation' })
  })

  it('answers a malformed item that still names itself, and does not run it', async () => {
    const { service, api, executed } = setup()
    api.items = [{ kind: 'malformed', commandId: '9', attemptNo: 2 }]
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(0)
    expect(api.sent[0]).toMatchObject({
      commandId: '9',
      result: { attempt_no: 2, status: 'rejected', failure_stage: 'validation' }
    })
  })

  it('handles the good commands around a malformed one', async () => {
    const { service, api, executed } = setup()
    api.items = [
      command({ command_id: 1 }),
      { kind: 'malformed', commandId: '2', attemptNo: 1 },
      command({ command_id: 3 })
    ]
    await service.cycle('u1', signal())
    expect(executed.map((invocation) => invocation.executionId)).toEqual(['cmd-1-1', 'cmd-3-1'])
    expect(api.sent).toHaveLength(3)
  })
})

describe('commands that arrive too late', () => {
  it('does not start a command older than a minute and reports it as expired', async () => {
    const { service, api, executed, nowRef } = setup()
    api.items = [command({ requested_at: new Date(T0).toISOString() })]
    nowRef.ms = T0 + 61_000
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(0)
    expect(api.sent[0]?.result).toMatchObject({
      status: 'failed',
      error_code: 'expired',
      failure_stage: 'timeout',
      observation_status: 'not_applicable'
    })
  })

  it('still runs a command that is exactly a minute old', async () => {
    const { service, api, executed, nowRef } = setup()
    api.items = [command({ requested_at: new Date(T0).toISOString() })]
    nowRef.ms = T0 + 60_000
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(1)
    expect(api.sent[0]?.result.status).toBe('success')
  })

  it("judges age on the server's clock when this machine's clock is off", async () => {
    // This machine is two minutes behind the server: locally the command looks brand new.
    const behind = setup({ offsetMs: 120_000 })
    behind.api.items = [command({ requested_at: new Date(T0).toISOString() })]
    behind.nowRef.ms = T0 + 1000
    await behind.service.cycle('u1', signal())
    expect(behind.executed).toHaveLength(0)
    expect(behind.api.sent[0]?.result.error_code).toBe('expired')

    // This machine is two minutes ahead: locally the command looks old, but it is fresh.
    const ahead = setup({ offsetMs: -120_000 })
    ahead.api.items = [command({ requested_at: new Date(T0).toISOString() })]
    ahead.nowRef.ms = T0 + 100_000
    await ahead.service.cycle('u1', signal())
    expect(ahead.executed).toHaveLength(1)
  })

  it("falls back to this machine's clock before the server's is known", async () => {
    const { service, api, executed, nowRef } = setup({ offsetMs: null })
    api.items = [command({ requested_at: new Date(T0).toISOString() })]
    nowRef.ms = T0 + 5000
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(1)
  })

  it('does not treat a command dated in the future as expired', async () => {
    const { service, api, executed, nowRef } = setup()
    api.items = [command({ requested_at: new Date(T0 + 600_000).toISOString() })]
    nowRef.ms = T0
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(1)
  })
})

describe('a time the server sends without a zone', () => {
  const original = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Asia/Seoul'
  })
  afterAll(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })
  const naive = (ms: number) => new Date(ms).toISOString().replace('Z', '')

  it('is judged as UTC, so a fresh command runs and a stale one expires whatever this zone is', async () => {
    const fresh = setup()
    fresh.api.items = [command({ requested_at: naive(T0) })]
    fresh.nowRef.ms = T0 + 10_000
    await fresh.service.cycle('u1', signal())
    expect(fresh.executed).toHaveLength(1)

    const stale = setup()
    stale.api.items = [command({ requested_at: naive(T0) })]
    stale.nowRef.ms = T0 + 90_000
    await stale.service.cycle('u1', signal())
    expect(stale.executed).toHaveLength(0)
    expect(stale.api.sent[0]?.result.error_code).toBe('expired')
  })
})

describe('sending results', () => {
  it('keeps a result that could not be sent and sends the identical one later without running again', async () => {
    const { service, api, executed } = setup()
    api.items = [command()]
    api.outcomes = [{ kind: 'retry' }]
    const first = await service.cycle('u1', signal())
    expect(first.failed).toBe(false) // the poll worked; the send is retried next round
    expect(api.sent).toHaveLength(1)
    await service.cycle('u1', signal())
    expect(api.sent).toHaveLength(2)
    expect(api.sent[1]?.result).toEqual(api.sent[0]?.result)
    await service.cycle('u1', signal())
    expect(api.sent).toHaveLength(2)
    expect(executed).toHaveLength(1)
  })

  it('stops sending a result the server will never take', async () => {
    const { service, api, logs } = setup()
    api.items = [command()]
    api.outcomes = [{ kind: 'refused' }]
    await service.cycle('u1', signal())
    await service.cycle('u1', signal())
    expect(api.sent).toHaveLength(1)
    expect(logs).toContain('서버가 명령 결과를 받지 않아 더 보내지 않아요.')
  })

  it("does not put a command's contents in its log lines", async () => {
    const { service, api, logs } = setup()
    api.items = [
      command({
        command_type: 'browser.open',
        arguments: { url: 'https://example.com/secret-path' }
      })
    ]
    api.outcomes = [{ kind: 'refused' }]
    await service.cycle('u1', signal())
    expect(logs.join('\n')).not.toMatch(/secret|example\.com|https?:/)
  })

  it('sends a result waiting from an earlier run before it asks for new commands', async () => {
    const first = setup()
    first.api.items = [command()]
    first.api.outcomes = [{ kind: 'retry' }]
    await first.service.cycle('u1', signal())

    // A new run (restart) with the same journal file; the server no longer lists the command.
    const api = new FakeApi()
    const second = first.build({ api })
    await second.cycle('u1', signal())
    expect(api.sent).toHaveLength(1)
    expect(api.sent[0]?.result).toEqual(first.api.sent[0]?.result)
    expect(first.executed).toHaveLength(1)
  })

  it('sends results oldest first', async () => {
    const { service, api, nowRef } = setup()
    api.items = [command({ command_id: 1 }), command({ command_id: 2 })]
    api.outcomes = [{ kind: 'retry' }, { kind: 'retry' }]
    nowRef.ms = T0 + 1000
    await service.cycle('u1', signal())
    api.sent.length = 0
    api.items = []
    await service.cycle('u1', signal())
    expect(api.sent.map((entry) => entry.commandId)).toEqual(['1', '2'])
  })

  it('reports a failed poll without touching the results waiting', async () => {
    const { service, api } = setup()
    api.pendingFailure = { retryAfterMs: 7000 }
    const outcome = await service.cycle('u1', signal())
    expect(outcome).toEqual({ waitMs: 7000, failed: true })
  })
})

describe('after the app restarts', () => {
  it('does not run a command that was cut off while running, and reports it as unknown', async () => {
    const first = setup()
    first.api.items = [command()]
    // The process ends while the command runs: it never returns.
    first.behave(() => new Promise<never>(() => undefined))
    void first.service.cycle('u1', signal())
    await new Promise((resolve) => setTimeout(resolve, 20))

    const api = new FakeApi()
    api.items = [command()] // the server did not get a result, so it sends it again
    const second = first.build({ api })
    await second.cycle('u1', signal())
    expect(first.executed).toHaveLength(1)
    expect(api.sent).toHaveLength(1)
    expect(api.sent[0]?.result).toMatchObject({ status: 'unknown', observation_status: 'unknown' })
    expect(api.sent[0]?.result.failure_stage).toBeUndefined()
  })
})

describe('when the journal cannot be written', () => {
  it('runs nothing and says so', async () => {
    const { service, api, executed, files, logs } = setup()
    files.failWrites = true
    api.items = [command({ command_id: 1 }), command({ command_id: 2 })]
    const outcome = await service.cycle('u1', signal())
    expect(executed).toHaveLength(0)
    expect(api.sent).toHaveLength(0)
    expect(outcome.failed).toBe(true)
    expect(logs).toContain('명령 실행 기록을 쓸 수 없어 명령을 실행하지 않았어요.')
  })

  it('runs the command once the journal works again', async () => {
    const { service, api, executed, files } = setup()
    files.failWrites = true
    api.items = [command()]
    await service.cycle('u1', signal())
    files.failWrites = false
    await service.cycle('u1', signal())
    expect(executed).toHaveLength(1)
  })
})

describe('polling', () => {
  it('waits what the server asks, within limits', async () => {
    const { service, api } = setup()
    for (const [asked, waited] of [
      [undefined, 2000],
      [500, 1000],
      [5000, 5000],
      [120_000, 30_000]
    ] as const) {
      api.pollAfterMs = asked
      expect((await service.cycle('u1', signal())).waitMs).toBe(waited)
    }
  })

  it('backs off while the server cannot be reached and returns to normal after', async () => {
    const { service, api, sleeps } = setup()
    api.pendingFailure = {}
    service.start('u1')
    await waitUntil(() => sleeps.length >= 5)
    const failing = sleeps.slice(0, 5)
    expect(failing).toEqual([2000, 4000, 8000, 16_000, 30_000])
    api.pendingFailure = null
    const before = sleeps.length
    await waitUntil(() => sleeps.length >= before + 2)
    expect(sleeps[before + 1]).toBe(2000)
    await service.stop()
  })

  it('stops, and a stopped service sends nothing more', async () => {
    const { service, api } = setup()
    service.start('u1')
    await waitUntil(() => api.pendingCalls >= 2)
    await service.stop()
    const calls = api.pendingCalls
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(api.pendingCalls).toBe(calls)
  })

  it('leaves a running command alone when the same user is started again', async () => {
    // Repeated "signed in" notices for one user must not cancel what is running.
    const { api, behave, build, signals, executed } = setup()
    api.items = [command()]
    let finish: () => void = () => undefined
    behave(
      (invocation) =>
        new Promise((resolve) => {
          finish = () => resolve(observed(invocation))
        })
    )
    const service = build()
    service.start('u1')
    await waitUntil(() => executed.length === 1)
    service.start('u1')
    service.start('u1')
    expect(signals[0]?.aborted).toBe(false)
    finish()
    await waitUntil(() => api.sent.length === 1)
    expect(executed).toHaveLength(1)
    await service.stop()
  })

  it('does not start a second loop for the same user', async () => {
    // Every loop that is waiting for its next round holds one of these.
    const waiting: (() => void)[] = []
    const api = new FakeApi()
    const service = new CommandService({
      api,
      journal: new CommandJournal({ files: new MemoryFiles(), now: () => T0 }),
      executor: { execute: async (invocation) => observed(invocation) },
      platform: 'darwin',
      now: () => T0,
      clock: { serverTimeAt: (local) => local },
      sleep: (_ms, stopSignal) =>
        new Promise<void>((resolve) => {
          waiting.push(resolve)
          stopSignal.addEventListener('abort', () => resolve(), { once: true })
        })
    })
    service.start('u1')
    service.start('u1')
    await waitUntil(() => waiting.length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(waiting).toHaveLength(1)
    expect(api.pendingCalls).toBe(1)
    await service.stop()
  })

  it("ends the first user's loop when a different user starts", async () => {
    const { build } = setup()
    const api = new FakeApi()
    const service = build({ api })
    service.start('u1')
    await waitUntil(() => api.pendingCalls >= 1)
    service.start('u2')
    await new Promise((resolve) => setTimeout(resolve, 40))
    await service.stop()
    const after = api.pendingCalls
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(api.pendingCalls).toBe(after)
  })

  it("drops another account's history when a different user starts", async () => {
    const { service, api, files, build } = setup()
    api.items = [command({ command_id: 1 })]
    await service.cycle('u1', signal())
    expect(files.contents).toContain('"u1"')
    const other = build({ api: new FakeApi() })
    other.start('u2')
    await waitUntil(() => !(files.contents ?? '').includes('"u1"'))
    await other.stop()
  })
})

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
