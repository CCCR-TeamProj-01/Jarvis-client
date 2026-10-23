import { describe, expect, it, vi } from 'vitest'
import type { CollectionConsent } from '../../src/main/commands/activity'
import type { CollectionConsentPort } from '../../src/main/commands/collection-consent'
import type { CommandApiPort, PendingItem, SendOutcome } from '../../src/main/commands/command-api'
import { CommandJournal } from '../../src/main/commands/command-journal'
import type { CommandResult } from '../../src/main/commands/command-result'
import { CommandService } from '../../src/main/commands/command-service'
import { ServerCommandSchema } from '../../src/main/commands/server-command'
import type { Result } from '../../src/shared/contracts/common'
import { ToolExecutionReportSchema } from '../../src/shared/contracts/tools'
import type { ToolExecutionReport, ToolInvocation } from '../../src/shared/contracts/tools'
import { MemoryFiles } from '../helpers/memory-files'

const T0 = Date.parse('2026-10-22T03:00:00.000Z')
const CHROME = 'com.google.Chrome'
const BOTH: CollectionConsent = { activityEnabled: true, externalEnabled: true, revision: 3 }
const ACTIVITY_ONLY: CollectionConsent = {
  activityEnabled: true,
  externalEnabled: false,
  revision: 3
}
const NEITHER: CollectionConsent = { activityEnabled: false, externalEnabled: false, revision: 3 }
const signal = () => new AbortController().signal
const failure = (message = '서버에 연결할 수 없습니다.') =>
  ({ ok: false, error: { code: 'unavailable', message } }) as const

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

function launchChrome(id = 1, type = 'apps.launch'): PendingItem {
  return {
    kind: 'command',
    command: ServerCommandSchema.parse({
      command_id: id,
      attempt_no: 1,
      command_type: type,
      requested_app_code: 'chrome',
      arguments: {},
      requested_at: new Date(T0).toISOString()
    })
  }
}
const mute = (id = 9): PendingItem => ({
  kind: 'command',
  command: ServerCommandSchema.parse({
    command_id: id,
    attempt_no: 1,
    command_type: 'system.mute',
    requested_app_code: null,
    arguments: { muted: true },
    requested_at: new Date(T0).toISOString()
  })
})

type Status = 'confirmed' | 'dispatched' | 'unknown'
function report(invocation: ToolInvocation, status: Status = 'confirmed'): ToolExecutionReport {
  const tool = invocation.command.tool
  const outcome =
    tool === 'system.mute'
      ? ({
          status: 'observed',
          observation: { kind: 'audio', level: 30, muted: true, status }
        } as const)
      : ({ status: 'observed', observation: { kind: 'app', appId: CHROME, status } } as const)
  return ToolExecutionReportSchema.parse({
    requestId: invocation.requestId,
    executionId: invocation.executionId,
    tool,
    outcome,
    cancelRequested: false,
    expired: false
  })
}

/** The service with every outside thing in the test's hands. */
function setup(options: { withActivity?: boolean; platform?: NodeJS.Platform } = {}) {
  const files = new MemoryFiles()
  const api = new FakeApi()
  const nowRef = { ms: T0 + 1000 }
  const events: string[] = []
  const consents: (() => Promise<Result<CollectionConsent>>)[] = []
  const lists: (() => Promise<Result<readonly string[]>>)[] = []
  let defaultConsent: Result<CollectionConsent> = { ok: true, value: BOTH }
  let defaultList: Result<readonly string[]> = {
    ok: true,
    value: [CHROME, 'com.microsoft.VSCode', 'org.example.Secret']
  }
  let behave: (invocation: ToolInvocation) => ToolExecutionReport = (invocation) =>
    report(invocation)
  const executed: ToolInvocation[] = []
  const ids = vi.fn<() => string>()
  let counter = 0
  ids.mockImplementation(() => `act_${++counter}`)
  const consent: CollectionConsentPort = {
    read: vi.fn<CollectionConsentPort['read']>(async () => {
      events.push('consent')
      return (consents.shift() ?? (async () => defaultConsent))()
    })
  }
  const runningApps = vi.fn<(signal?: AbortSignal) => Promise<Result<readonly string[]>>>(
    async () => {
      events.push('list')
      return (lists.shift() ?? (async () => defaultList))()
    }
  )
  const build = (extra: { files?: MemoryFiles } = {}) =>
    new CommandService({
      api,
      journal: new CommandJournal({ files: extra.files ?? files, now: () => nowRef.ms }),
      executor: {
        async execute(invocation) {
          events.push(`run:${invocation.command.tool}`)
          executed.push(invocation)
          return behave(invocation)
        }
      },
      platform: options.platform ?? 'darwin',
      now: () => nowRef.ms,
      clock: { serverTimeAt: (local) => local },
      sleep: async () => undefined,
      ...(options.withActivity === false
        ? {}
        : { activity: { consent, runningApps, createId: ids } }),
      log: (message) => events.push(`log:${message}`)
    })
  return {
    files,
    api,
    nowRef,
    events,
    executed,
    consent,
    runningApps,
    ids,
    service: build(),
    build,
    consents,
    lists,
    setConsent: (value: Result<CollectionConsent>) => (defaultConsent = value),
    setList: (value: Result<readonly string[]>) => (defaultList = value),
    behave: (fn: typeof behave) => (behave = fn)
  }
}

const sentActivity = (t: ReturnType<typeof setup>, index = 0) => t.api.sent[index]?.result.activity

describe('a launch that starts an app', () => {
  it('reports it as started, with the running apps the server knows', async () => {
    const t = setup()
    t.setList({ ok: true, value: ['com.microsoft.VSCode', 'org.example.Secret'] })
    t.api.items = [launchChrome()]
    // After the launch the list includes the new app.
    t.lists.push(async () => ({ ok: true, value: ['com.microsoft.VSCode'] }))
    t.lists.push(async () => ({
      ok: true,
      value: [CHROME, 'com.microsoft.VSCode', 'org.example.Secret']
    }))
    await t.service.cycle('u1', signal())
    const result = t.api.sent[0]!.result
    expect(result).toMatchObject({
      status: 'success',
      observation_status: 'confirmed',
      app: { app_code: 'chrome' }
    })
    expect(result.activity).toEqual({
      event_key: 'act_1',
      event_type: 'launched',
      occurred_at: result.finished_at,
      collection_revision: 3,
      running_apps: ['chrome', 'vscode']
    })
  })

  it('reports a launch of an app that was already running as only brought to the front', async () => {
    const t = setup()
    t.api.items = [launchChrome()]
    t.lists.push(async () => ({ ok: true, value: [CHROME] }))
    await t.service.cycle('u1', signal())
    expect(sentActivity(t)).toMatchObject({ event_type: 'activated' })
  })

  it('looks at what is running before the app starts, and again after', async () => {
    const t = setup()
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.events.slice(0, 4)).toEqual(['consent', 'list', 'run:apps.launch', 'list'])
  })

  it('does not let taking the lists move the times of the result', async () => {
    const t = setup()
    t.api.items = [launchChrome()]
    t.runningApps.mockImplementation(async () => {
      t.nowRef.ms += 5_000
      return { ok: true, value: [] }
    })
    t.behave((invocation) => {
      t.nowRef.ms += 300
      return report(invocation)
    })
    await t.service.cycle('u1', signal())
    const result = t.api.sent[0]!.result
    // Started when the command was taken; finished when the tool returned; nothing later.
    expect(Date.parse(result.finished_at) - Date.parse(result.started_at)).toBeLessThan(6_000)
    expect(Date.parse(result.finished_at)).toBeLessThanOrEqual(T0 + 1000 + 5_000 + 300)
    expect(result.reported_at).toBe(result.finished_at)
    expect(result.activity?.occurred_at).toBe(result.finished_at)
  })
})

describe('bringing an app to the front', () => {
  it('reports it as brought to the front, and takes no list before', async () => {
    const t = setup()
    t.api.items = [launchChrome(1, 'apps.activate')]
    await t.service.cycle('u1', signal())
    expect(sentActivity(t)).toMatchObject({
      event_type: 'activated',
      running_apps: ['chrome', 'vscode']
    })
    expect(t.events.filter((event) => event === 'list')).toHaveLength(1)
  })
})

describe('what the user allowed', () => {
  it('reads it afresh before every command that uses an app', async () => {
    const t = setup()
    t.api.items = [launchChrome(1), launchChrome(2)]
    await t.service.cycle('u1', signal())
    expect(t.events.filter((event) => event === 'consent').length).toBeGreaterThanOrEqual(2)
    const beforeRuns = t.events.slice(0, t.events.indexOf('run:apps.launch'))
    expect(beforeRuns).toContain('consent')
  })

  it('looks at nothing and reports no activity without the consent', async () => {
    const t = setup()
    t.setConsent({ ok: true, value: NEITHER })
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.runningApps).not.toHaveBeenCalled()
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
    expect(t.api.sent[0]!.result.status).toBe('success')
    expect(t.executed).toHaveLength(1)
  })

  it('does not take the extra consent for the activity one', async () => {
    const t = setup()
    t.setConsent({
      ok: true,
      value: { activityEnabled: false, externalEnabled: true, revision: 3 }
    })
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.runningApps).not.toHaveBeenCalled()
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
  })

  it('reports the activity without the list of apps when only the first consent is on', async () => {
    const t = setup()
    t.setConsent({ ok: true, value: ACTIVITY_ONLY })
    t.api.items = [launchChrome()]
    t.lists.push(async () => ({ ok: true, value: [] }))
    await t.service.cycle('u1', signal())
    expect(sentActivity(t)).toMatchObject({ event_type: 'launched', collection_revision: 3 })
    expect(sentActivity(t)).not.toHaveProperty('running_apps')
    // Only the one look before a launch: nothing about other apps is looked at after.
    expect(t.runningApps).toHaveBeenCalledTimes(1)
  })

  it('does not look at what is running at all for activating when only the first consent is on', async () => {
    const t = setup()
    t.setConsent({ ok: true, value: ACTIVITY_ONLY })
    t.api.items = [launchChrome(1, 'apps.activate')]
    await t.service.cycle('u1', signal())
    expect(t.runningApps).not.toHaveBeenCalled()
    expect(sentActivity(t)).toMatchObject({ event_type: 'activated' })
  })

  it('reports no activity, and still runs and reports the command, when the consent cannot be read', async () => {
    const t = setup()
    t.setConsent(failure())
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.executed).toHaveLength(1)
    expect(t.api.sent).toHaveLength(1)
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
    expect(t.runningApps).not.toHaveBeenCalled()
  })

  it('treats a consent read that throws the same way', async () => {
    const t = setup()
    t.consents.push(async () => {
      throw new Error('boom')
    })
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result.status).toBe('success')
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
  })

  it('does not read it for commands that use no app', async () => {
    const t = setup()
    t.api.items = [mute()]
    await t.service.cycle('u1', signal())
    expect(t.consent.read).not.toHaveBeenCalled()
    expect(t.runningApps).not.toHaveBeenCalled()
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
  })

  it('reports nothing about activity when none is set up', async () => {
    const t = setup({ withActivity: false })
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
    expect(t.api.sent[0]!.result.status).toBe('success')
  })
})

describe('what is not made into an activity', () => {
  it('is a request that was only handed over', async () => {
    const t = setup()
    t.behave((invocation) => report(invocation, 'dispatched'))
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result).toMatchObject({
      status: 'success',
      observation_status: 'dispatched'
    })
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
    // No list is taken after, for nothing.
    expect(t.runningApps).toHaveBeenCalledTimes(1)
  })

  it('is a result that could not be told', async () => {
    const t = setup()
    t.behave((invocation) => report(invocation, 'unknown'))
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
  })

  it('is a failed launch', async () => {
    const t = setup()
    t.behave((invocation) =>
      ToolExecutionReportSchema.parse({
        requestId: invocation.requestId,
        executionId: invocation.executionId,
        tool: invocation.command.tool,
        outcome: {
          status: 'failed',
          effect: 'none',
          error: { code: 'not_found', message: 'x' }
        },
        cancelRequested: false,
        expired: false
      })
    )
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result.status).toBe('failed')
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
  })

  it('is an app the server has no code for on this platform', async () => {
    const t = setup({ platform: 'linux' })
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result.status).toBe('rejected')
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
    expect(t.runningApps).not.toHaveBeenCalled()
  })
})

describe('when what is running cannot be told', () => {
  it('makes no claim about a launch, but the result is reported as it always was', async () => {
    const t = setup()
    t.lists.push(async () => failure())
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.executed).toHaveLength(1)
    expect(t.api.sent[0]!.result).toMatchObject({
      status: 'success',
      observation_status: 'confirmed'
    })
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
  })

  it('treats a list that throws the same way', async () => {
    const t = setup()
    t.lists.push(async () => {
      throw new Error('boom')
    })
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result.status).toBe('success')
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
  })

  it('reports the activity without a list when only the list after the launch fails', async () => {
    const t = setup()
    t.lists.push(
      async () => ({ ok: true, value: [] }),
      async () => failure()
    )
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(sentActivity(t)).toMatchObject({ event_type: 'launched' })
    expect(sentActivity(t)).not.toHaveProperty('running_apps')
  })

  it('tells an empty list from one that failed', async () => {
    const t = setup()
    t.lists.push(
      async () => ({ ok: true, value: [] }),
      async () => ({ ok: true, value: ['org.example.Secret'] })
    )
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(sentActivity(t)).toHaveProperty('running_apps', [])
  })

  it('does not rerun a command because a list failed', async () => {
    const t = setup()
    t.lists.push(
      async () => failure(),
      async () => failure()
    )
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    await t.service.cycle('u1', signal())
    expect(t.executed).toHaveLength(1)
  })
})

describe('keeping the activity across a retry', () => {
  it('sends the same activity again, and takes no new list or key', async () => {
    const t = setup()
    t.api.items = [launchChrome()]
    t.api.outcomes.push({ kind: 'retry' })
    await t.service.cycle('u1', signal())
    const first = t.api.sent[0]!.result
    const lists = t.runningApps.mock.calls.length
    t.api.items = []
    await t.service.cycle('u1', signal())
    expect(t.api.sent).toHaveLength(2)
    expect(t.api.sent[1]!.result).toEqual(first)
    expect(t.runningApps.mock.calls.length).toBe(lists)
    expect(t.ids).toHaveBeenCalledTimes(1)
  })

  it('keeps it through a restart, from the journal', async () => {
    const t = setup()
    t.api.items = [launchChrome()]
    t.api.outcomes.push({ kind: 'retry' })
    await t.service.cycle('u1', signal())
    const first = t.api.sent[0]!.result
    const restarted = t.build()
    t.api.items = []
    await restarted.cycle('u1', signal())
    expect(t.api.sent[1]!.result).toEqual(first)
    expect(t.executed).toHaveLength(1)
  })

  it('makes a new key for each command', async () => {
    const t = setup()
    t.api.items = [launchChrome(1), launchChrome(2)]
    await t.service.cycle('u1', signal())
    expect(sentActivity(t, 0)?.event_key).toBe('act_1')
    expect(sentActivity(t, 1)?.event_key).toBe('act_2')
  })
})

describe('when the settings change before the result is sent', () => {
  async function waitingResult() {
    const t = setup()
    t.api.items = [launchChrome()]
    t.api.outcomes.push({ kind: 'retry' })
    await t.service.cycle('u1', signal())
    // The next send happens later than the consent is trusted for.
    t.nowRef.ms += 120_000
    t.api.items = []
    return t
  }

  it('drops the activity when the consent was withdrawn, and still sends the result', async () => {
    const t = await waitingResult()
    t.setConsent({ ok: true, value: NEITHER })
    await t.service.cycle('u1', signal())
    expect(t.api.sent).toHaveLength(2)
    expect(t.api.sent[1]!.result).not.toHaveProperty('activity')
    expect(t.api.sent[1]!.result.status).toBe('success')
    expect(t.api.sent[1]!.result.finished_at).toBe(t.api.sent[0]!.result.finished_at)
  })

  it('drops the activity when the revision has moved on', async () => {
    const t = await waitingResult()
    t.setConsent({ ok: true, value: { ...BOTH, revision: 4 } })
    await t.service.cycle('u1', signal())
    expect(t.api.sent[1]!.result).not.toHaveProperty('activity')
  })

  it('drops only the list of apps when the extra consent was withdrawn', async () => {
    const t = await waitingResult()
    t.setConsent({ ok: true, value: ACTIVITY_ONLY })
    await t.service.cycle('u1', signal())
    expect(sentActivity(t, 1)).toBeDefined()
    expect(sentActivity(t, 1)).not.toHaveProperty('running_apps')
  })

  it('drops the activity when the consent cannot be read now', async () => {
    const t = await waitingResult()
    t.setConsent(failure())
    await t.service.cycle('u1', signal())
    expect(t.api.sent[1]!.result).not.toHaveProperty('activity')
  })

  it('does not forget the activity in the journal, so a later send can still use it', async () => {
    const t = await waitingResult()
    t.setConsent(failure())
    t.api.outcomes.push({ kind: 'retry' })
    await t.service.cycle('u1', signal())
    t.nowRef.ms += 120_000
    t.setConsent({ ok: true, value: BOTH })
    await t.service.cycle('u1', signal())
    expect(sentActivity(t, 2)).toMatchObject({ event_key: 'act_1', collection_revision: 3 })
  })

  it('does not use another user’s consent for a result waiting for this one', async () => {
    const t = setup()
    // u2 has a result waiting, with an activity made under their consent.
    t.api.items = [launchChrome(1)]
    t.api.outcomes.push({ kind: 'retry' })
    await t.service.cycle('u2', signal())
    // u1 then runs under a consent that allows nothing, which is now the one held.
    t.setConsent({ ok: true, value: NEITHER })
    t.api.items = [launchChrome(2)]
    await t.service.cycle('u1', signal())
    // u2 is back: their own consent is asked, not the one u1 left behind.
    t.setConsent({ ok: true, value: BOTH })
    t.api.items = []
    await t.service.cycle('u2', signal())
    const resent = t.api.sent.filter((entry) => entry.commandId === '1')
    expect(resent).toHaveLength(2)
    expect(resent[1]!.result.activity).toBeDefined()
  })

  it('reads the consent again once told it may have changed, even within the time it is trusted', async () => {
    const forgotten = setup()
    forgotten.api.items = [launchChrome(1)]
    forgotten.api.outcomes.push({ kind: 'retry' })
    await forgotten.service.cycle('u1', signal())
    // The user withdraws the consent a moment later.
    forgotten.setConsent({ ok: true, value: NEITHER })
    forgotten.service.forgetConsent()
    forgotten.api.items = []
    await forgotten.service.cycle('u1', signal())
    expect(forgotten.api.sent[1]!.result).not.toHaveProperty('activity')

    // Without being told, the consent read a moment ago is the one used.
    const held = setup()
    held.api.items = [launchChrome(1)]
    held.api.outcomes.push({ kind: 'retry' })
    await held.service.cycle('u1', signal())
    held.setConsent({ ok: true, value: NEITHER })
    held.api.items = []
    await held.service.cycle('u1', signal())
    expect(held.api.sent[1]!.result.activity).toBeDefined()
  })

  it('reads the consent again after the service was stopped and started', async () => {
    const t = setup()
    t.api.items = [launchChrome(1)]
    t.api.outcomes.push({ kind: 'retry' })
    await t.service.cycle('u1', signal())
    await t.service.stop()
    // The same user is back at once; what was read before they left is not trusted.
    t.setConsent({ ok: true, value: NEITHER })
    t.api.items = []
    await t.service.cycle('u1', signal())
    expect(t.api.sent[1]!.result).not.toHaveProperty('activity')
  })

  it('does not go on trusting an earlier consent after a read of it failed', async () => {
    const t = setup()
    t.api.items = [launchChrome(1)]
    t.api.outcomes.push({ kind: 'retry' }, { kind: 'retry' })
    await t.service.cycle('u1', signal())
    // The next command cannot read the consent: nothing may be assumed from before.
    t.setConsent(failure())
    t.api.items = [launchChrome(2)]
    await t.service.cycle('u1', signal())
    t.api.items = []
    await t.service.cycle('u1', signal())
    const first = t.api.sent.filter((entry) => entry.commandId === '1')
    expect(first).toHaveLength(3)
    // Sent at once after the first, while the consent read a moment ago was still trusted.
    expect(first[1]!.result.activity).toBeDefined()
    // Sent after a read failed: it is read again, cannot be told, and the activity is left out.
    expect(first[2]!.result).not.toHaveProperty('activity')
  })

  it('leaves out an activity the schema would not take, and still reports the command', async () => {
    const t = setup()
    t.ids.mockReturnValue('')
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result).toMatchObject({ status: 'success' })
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
    t.ids.mockReturnValue('a'.repeat(161))
    t.api.items = [launchChrome(2)]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[1]!.result).not.toHaveProperty('activity')
  })

  it('trusts a consent read a moment ago, so a result sent at once costs no second read', async () => {
    const t = setup()
    t.api.items = [launchChrome()]
    await t.service.cycle('u1', signal())
    expect(t.consent.read).toHaveBeenCalledTimes(1)
  })

  it('reads again for one sent after that moment', async () => {
    const t = await waitingResult()
    const reads = vi.mocked(t.consent.read).mock.calls.length
    await t.service.cycle('u1', signal())
    expect(vi.mocked(t.consent.read).mock.calls.length).toBe(reads + 1)
  })

  it('is told for another user afresh, never from the first one', async () => {
    const t = setup()
    t.api.items = [launchChrome(1)]
    await t.service.cycle('u1', signal())
    t.api.items = [launchChrome(2)]
    await t.service.cycle('u2', signal())
    expect(t.consent.read).toHaveBeenCalledTimes(2)
  })
})

describe('what the server answers', () => {
  it('notes it, without treating the command as failed, when the activity was not recorded', async () => {
    const t = setup()
    t.api.items = [launchChrome()]
    t.api.outcomes.push({ kind: 'stored', activityRecorded: false })
    await t.service.cycle('u1', signal())
    expect(
      t.events.some((event) => event.startsWith('log:서버가 앱 사용 기록을 저장하지 않았어요'))
    ).toBe(true)
    // Settled: the result is not sent again.
    t.api.items = []
    await t.service.cycle('u1', signal())
    expect(t.api.sent).toHaveLength(1)
  })

  it('says nothing when it was recorded, or when no activity was sent', async () => {
    const t = setup()
    t.api.items = [launchChrome(1), mute(2)]
    t.api.outcomes.push(
      { kind: 'stored', activityRecorded: true },
      { kind: 'stored', activityRecorded: false }
    )
    await t.service.cycle('u1', signal())
    expect(t.events.some((event) => event.startsWith('log:서버가 앱 사용 기록'))).toBe(false)
  })

  it('settles a result the server refused, whatever it said of the activity', async () => {
    const t = setup()
    t.api.items = [launchChrome()]
    t.api.outcomes.push({ kind: 'refused' })
    await t.service.cycle('u1', signal())
    t.api.items = []
    await t.service.cycle('u1', signal())
    expect(t.api.sent).toHaveLength(1)
  })
})

describe('restoring the window of an app', () => {
  const restore = (): PendingItem => ({
    kind: 'command',
    command: ServerCommandSchema.parse({
      command_id: 5,
      attempt_no: 1,
      command_type: 'apps.restore',
      requested_app_code: null,
      arguments: {},
      requested_at: new Date(T0).toISOString()
    })
  })
  const restored = (invocation: ToolInvocation) =>
    ToolExecutionReportSchema.parse({
      requestId: invocation.requestId,
      executionId: invocation.executionId,
      tool: 'apps.restore',
      outcome: {
        status: 'observed',
        observation: { kind: 'app', appId: CHROME, status: 'confirmed' }
      },
      cancelRequested: false,
      expired: false
    })

  it('is reported as brought to the front, never as a start, and takes no list before', async () => {
    const t = setup()
    t.behave(restored)
    t.api.items = [restore()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result).toMatchObject({ status: 'success', app: { app_code: 'chrome' } })
    expect(sentActivity(t)).toMatchObject({
      event_type: 'activated',
      running_apps: ['chrome', 'vscode']
    })
    expect(t.runningApps).toHaveBeenCalledTimes(1)
  })

  it('reports nothing for an app the server has no code for', async () => {
    const t = setup()
    t.behave((invocation) =>
      ToolExecutionReportSchema.parse({
        ...restored(invocation),
        outcome: {
          status: 'observed',
          observation: { kind: 'app', appId: 'org.example.Secret', status: 'confirmed' }
        }
      })
    )
    t.api.items = [restore()]
    await t.service.cycle('u1', signal())
    expect(t.api.sent[0]!.result).toMatchObject({ status: 'success' })
    expect(t.api.sent[0]!.result).not.toHaveProperty('app')
    expect(t.api.sent[0]!.result).not.toHaveProperty('activity')
  })
})
