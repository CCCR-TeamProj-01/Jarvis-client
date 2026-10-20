import { describe, expect, it, vi } from 'vitest'
import { TurnTools } from '../../src/main/conversation/turn-tools'
import type { ConversationNotice } from '../../src/main/conversation/ports'
import type { CapabilityRegistryPort, ToolExecutorPort } from '../../src/main/tools/ports'
import type { ToolExecutionReport, ToolInvocation } from '../../src/shared/contracts/tools'
import type { LocalExecutionOptions } from '../../src/main/ports'

const observedApp = (invocation: ToolInvocation): ToolExecutionReport => ({
  requestId: invocation.requestId,
  executionId: invocation.executionId,
  tool: invocation.command.tool,
  outcome: {
    status: 'observed',
    observation: { kind: 'app', appId: 'com.apple.Safari', status: 'confirmed' }
  },
  cancelRequested: false,
  expired: false
})

function setup(options: { maxCalls?: number } = {}) {
  const calls: { invocation: ToolInvocation; options?: LocalExecutionOptions }[] = []
  const executor: ToolExecutorPort = {
    execute: vi.fn<ToolExecutorPort['execute']>(async (invocation, execution) => {
      calls.push({ invocation, options: execution })
      if (invocation.command.tool === 'apps.list')
        return {
          requestId: invocation.requestId,
          executionId: invocation.executionId,
          tool: 'apps.list',
          outcome: {
            status: 'observed',
            observation: {
              kind: 'app_list',
              apps: [{ appId: 'com.apple.Safari', displayName: 'Safari', state: 'running' }]
            }
          },
          cancelRequested: false,
          expired: false
        }
      return observedApp(invocation)
    }),
    cancel: vi.fn<ToolExecutorPort['cancel']>()
  }
  const registry: CapabilityRegistryPort = {
    getSnapshot: () => ({ revision: 3, capabilities: [] })
  }
  const abort = new AbortController()
  const notices: ConversationNotice[] = []
  const tools = new TurnTools({
    executor,
    registry,
    clock: { now: () => 5_000 },
    requestId: 'req-1',
    signal: abort.signal,
    notify: (notice) => notices.push(notice),
    ...options
  })
  return { tools, calls, executor, abort, notices }
}

const launch = (executionId = 'e1') => ({
  executionId,
  command: { tool: 'apps.launch', arguments: { appId: 'com.apple.Safari' } }
})

describe('TurnTools', () => {
  it('shows the assistant what this device can do', () => {
    expect(setup().tools.capabilities()).toEqual({ revision: 3, capabilities: [] })
  })

  it('runs a valid request through the executor under this request, with a private execution ID', async () => {
    const { tools, calls } = setup()
    const report = await tools.execute(launch('e1'))
    expect(calls[0]?.invocation).toEqual({
      requestId: 'req-1',
      executionId: 'req-1:e1',
      command: { tool: 'apps.launch', arguments: { appId: 'com.apple.Safari' } }
    })
    // The assistant gets its own ID back.
    expect(report.executionId).toBe('e1')
    expect(report.outcome.status).toBe('observed')
  })

  it('passes the request’s expiry on as a deadline and its cancellation as a signal', async () => {
    const { tools, calls, abort } = setup()
    await tools.execute({ ...launch(), expiresInMs: 2_000 })
    expect(calls[0]?.options?.deadlineMs).toBe(7_000)
    expect(calls[0]?.options?.signal).toBe(abort.signal)
  })

  it('does not run a request that has already expired', async () => {
    const { tools, executor, notices } = setup()
    const report = await tools.execute({ ...launch(), expiresInMs: 0 })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(report.outcome).toMatchObject({ status: 'not_started', reason: 'expired' })
    expect(report.expired).toBe(true)
    expect(notices).toHaveLength(1)
  })

  it('refuses a malformed or unknown tool without running it', async () => {
    const { tools, executor, notices } = setup()
    for (const command of [
      { tool: 'shell.run', arguments: { cmd: 'rm -rf /' } },
      { tool: 'apps.launch', arguments: {} },
      { tool: 'browser.open', arguments: { url: 'file:///etc/passwd' } },
      'apps.list',
      null
    ]) {
      const report = await tools.execute({ executionId: `e-${JSON.stringify(command)}`, command })
      expect(report.outcome).toMatchObject({ status: 'not_started', reason: 'rejected' })
    }
    expect(executor.execute).not.toHaveBeenCalled()
    expect(notices.every((notice) => notice.type === 'tool' && !notice.ok)).toBe(true)
  })

  it('answers a repeated ID with the first result and runs it once', async () => {
    const { tools, executor, notices } = setup()
    const first = await tools.execute(launch('same'))
    const second = await tools.execute(launch('same'))
    expect(second).toBe(first)
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(notices).toHaveLength(1)
  })

  it('stops a runaway assistant at the call limit', async () => {
    const { tools, executor } = setup({ maxCalls: 2 })
    await tools.execute(launch('1'))
    await tools.execute(launch('2'))
    const third = await tools.execute(launch('3'))
    expect(third.outcome).toMatchObject({ status: 'not_started', reason: 'rejected' })
    expect(executor.execute).toHaveBeenCalledTimes(2)
  })

  it('counts invalid attempts too', async () => {
    const { tools } = setup({ maxCalls: 2 })
    await tools.execute({ executionId: 'a', command: 'nope' })
    await tools.execute({ executionId: 'b', command: 'nope' })
    const third = await tools.execute(launch('c'))
    expect(third.outcome).toMatchObject({ status: 'not_started', reason: 'rejected' })
  })

  it('refuses calls once the request is over, and once it was cancelled', async () => {
    const closing = setup()
    closing.tools.close()
    expect((await closing.tools.execute(launch())).outcome).toMatchObject({
      status: 'not_started',
      reason: 'cancelled'
    })
    const cancelled = setup()
    cancelled.abort.abort()
    const report = await cancelled.tools.execute(launch())
    expect(report.outcome).toMatchObject({ status: 'not_started', reason: 'cancelled' })
    expect(report.cancelRequested).toBe(true)
    expect(cancelled.executor.execute).not.toHaveBeenCalled()
  })

  it('tells the user what happened, with names learnt from an app listing', async () => {
    const { tools, notices } = setup()
    await tools.execute({ executionId: 'l', command: { tool: 'apps.list', arguments: {} } })
    await tools.execute(launch('a'))
    expect(notices).toEqual([
      {
        type: 'tool',
        requestId: 'req-1',
        executionId: 'l',
        text: '앱 1개를 확인했어요.',
        ok: true
      },
      {
        type: 'tool',
        requestId: 'req-1',
        executionId: 'a',
        text: 'Safari을(를) 열었어요.',
        ok: true
      }
    ])
  })

  it('runs several requests at once', async () => {
    const { tools, executor } = setup()
    const reports = await Promise.all([tools.execute(launch('x')), tools.execute(launch('y'))])
    expect(reports.map((report) => report.executionId)).toEqual(['x', 'y'])
    expect(executor.execute).toHaveBeenCalledTimes(2)
  })
})
