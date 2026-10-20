import { describe, expect, it, vi } from 'vitest'
import type { AppControlPort } from '../../src/main/platform/ports'
import { CapabilityRegistry, platformCapabilities } from '../../src/main/tools/capability-registry'
import { RestoreTargetTracker } from '../../src/main/tools/restore-target'
import { ToolExecutor } from '../../src/main/tools/tool-executor'
import type { Result } from '../../src/shared/contracts/common'
import type { AppObservation, ToolInvocation } from '../../src/shared/contracts/tools'
import { ToolExecutionReportSchema } from '../../src/shared/contracts/tools'

const confirmed = (appId: string): Result<AppObservation> => ({
  ok: true,
  value: { kind: 'app', appId, status: 'confirmed' }
})

/** An app control whose calls can be held open and inspected. */
function fakeAppControl() {
  const calls: string[] = []
  const gates = new Map<string, () => void>()
  let hold: Promise<void> | null = null
  const wait = async () => {
    if (hold) await hold
  }
  const control = {
    list: vi.fn<AppControlPort['list']>(async () => {
      calls.push('list')
      return { ok: true, value: [{ appId: 'com.example.a', displayName: 'A', state: 'running' }] }
    }),
    launch: vi.fn<AppControlPort['launch']>(async (appId, options) => {
      calls.push(`launch:${appId}`)
      await wait()
      if (options?.signal?.aborted)
        return { ok: false, error: { code: 'cancelled', message: '취소' } }
      return confirmed(appId)
    }),
    activate: vi.fn<AppControlPort['activate']>(async (appId) => {
      calls.push(`activate:${appId}`)
      await wait()
      return confirmed(appId)
    }),
    restore: vi.fn<AppControlPort['restore']>(async (target) => {
      calls.push(`restore:${target.appId}`)
      return confirmed(target.appId)
    }),
    getForegroundWindow: vi.fn<AppControlPort['getForegroundWindow']>(async () => ({
      ok: true,
      value: { appId: 'com.example.front' }
    })),
    switchRecentTask: vi.fn<AppControlPort['switchRecentTask']>(),
    openUrl: vi.fn<AppControlPort['openUrl']>(async (url) => {
      calls.push(`url:${url}`)
      return { ok: true, value: { kind: 'url', url, status: 'dispatched' } }
    })
  } satisfies AppControlPort
  return {
    control,
    calls,
    holdCalls() {
      let release: () => void = () => undefined
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.set('current', release)
      return () => {
        hold = null
        release()
      }
    }
  }
}

function setup(options: { signedIn?: boolean; restoreTarget?: { appId: string } | null } = {}) {
  const app = fakeAppControl()
  const registry = new CapabilityRegistry(platformCapabilities('darwin'))
  let signedIn = options.signedIn ?? true
  let nowMs = 1_000
  const executor = new ToolExecutor({
    registry,
    appControl: app.control,
    auth: {
      requireSignedIn: () =>
        signedIn
          ? { ok: true, value: undefined }
          : {
              ok: false,
              error: { code: 'authentication_required', message: '로그인이 필요합니다.' }
            }
    },
    clock: { now: () => nowMs },
    restoreTarget: () => options.restoreTarget ?? null
  })
  return {
    executor,
    registry,
    app,
    setSignedIn: (value: boolean) => {
      signedIn = value
    },
    tick: (ms: number) => {
      nowMs += ms
    }
  }
}

let counter = 0
const launch = (appId = 'com.example.a', executionId = `exec-${++counter}`): ToolInvocation => ({
  requestId: 'req-1',
  executionId,
  command: { tool: 'apps.launch', arguments: { appId } }
})
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('execution and reporting', () => {
  it('runs each tool and reports what was observed', async () => {
    const { executor } = setup({ restoreTarget: { appId: 'com.example.back' } })
    const run = (command: ToolInvocation['command']) =>
      executor.execute({ requestId: 'r', executionId: `e-${++counter}`, command })

    expect(await run({ tool: 'apps.list', arguments: {} })).toMatchObject({
      outcome: { status: 'observed', observation: { kind: 'app_list' } }
    })
    expect(await run({ tool: 'apps.launch', arguments: { appId: 'com.example.a' } })).toMatchObject(
      {
        tool: 'apps.launch',
        outcome: { status: 'observed', observation: { kind: 'app', status: 'confirmed' } }
      }
    )
    expect(
      await run({ tool: 'apps.activate', arguments: { appId: 'com.example.a' } })
    ).toMatchObject({
      outcome: { status: 'observed' }
    })
    expect(await run({ tool: 'apps.restore', arguments: {} })).toMatchObject({
      outcome: { status: 'observed', observation: { appId: 'com.example.back' } }
    })
    expect(
      await run({ tool: 'browser.open', arguments: { url: 'https://example.com/' } })
    ).toMatchObject({
      outcome: { status: 'observed', observation: { kind: 'url', status: 'dispatched' } }
    })
  })

  it('produces reports that satisfy the shared contract', async () => {
    const { executor } = setup()
    const report = await executor.execute(launch())
    expect(ToolExecutionReportSchema.safeParse(report).success).toBe(true)
  })

  it('reports a failed tool with whether anything could have happened', async () => {
    const { executor, app } = setup()
    app.control.launch.mockResolvedValueOnce({
      ok: false,
      error: { code: 'not_found', message: '앱 없음' }
    })
    expect(await executor.execute(launch())).toMatchObject({
      outcome: { status: 'failed', error: { code: 'not_found' }, effect: 'none' }
    })
    app.control.launch.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: '알 수 없는 오류' }
    })
    expect(await executor.execute(launch())).toMatchObject({
      outcome: { status: 'failed', effect: 'possible' }
    })
  })

  it('reports unknown when the adapter throws, and does not run it again', async () => {
    const { executor, app } = setup()
    app.control.launch.mockRejectedValueOnce(new Error('boom'))
    const invocation = launch()
    const first = await executor.execute(invocation)
    expect(first.outcome).toMatchObject({ status: 'unknown' })
    expect(JSON.stringify(first)).not.toContain('boom')
    expect(await executor.execute(invocation)).toBe(first)
    expect(app.control.launch).toHaveBeenCalledTimes(1)
  })

  it('has nothing to restore without a recorded target', async () => {
    const { executor } = setup({ restoreTarget: null })
    expect(
      await executor.execute({
        requestId: 'r',
        executionId: 'restore-1',
        command: { tool: 'apps.restore', arguments: {} }
      })
    ).toMatchObject({ outcome: { status: 'failed', error: { code: 'not_found' }, effect: 'none' } })
  })
})

describe('validation and re-checking', () => {
  it('rejects malformed invocations without touching the desktop', async () => {
    const { executor, app } = setup()
    for (const bad of [
      {},
      { requestId: 'r', executionId: 'e', command: { tool: 'rm', arguments: {} } },
      {
        requestId: 'r',
        executionId: 'e',
        command: { tool: 'apps.launch', arguments: { appId: '/bin/sh -c x', extra: 1 } }
      },
      {
        requestId: 'r',
        executionId: 'e',
        command: { tool: 'browser.open', arguments: { url: 'file:///etc/passwd' } }
      }
    ])
      expect(await executor.execute(bad as never)).toMatchObject({
        outcome: { status: 'not_started', reason: 'rejected', error: { code: 'invalid_input' } }
      })
    expect(app.calls).toEqual([])
  })

  it('refuses everything before sign-in', async () => {
    const { executor, app } = setup({ signedIn: false })
    expect(await executor.execute(launch())).toMatchObject({
      outcome: {
        status: 'not_started',
        reason: 'rejected',
        error: { code: 'authentication_required' }
      }
    })
    expect(app.calls).toEqual([])
  })

  it('allows the same execution again after sign-in, since the first never started', async () => {
    const { executor, setSignedIn, app } = setup({ signedIn: false })
    const invocation = launch()
    await executor.execute(invocation)
    setSignedIn(true)
    expect(await executor.execute(invocation)).toMatchObject({ outcome: { status: 'observed' } })
    expect(app.control.launch).toHaveBeenCalledTimes(1)
  })

  it('reports unsupported and unavailable tools without running them', async () => {
    const { executor, registry, app } = setup()
    registry.update('apps.launch', 'unsupported', '지원하지 않음')
    expect(await executor.execute(launch())).toMatchObject({
      outcome: { status: 'not_started', reason: 'rejected', error: { code: 'unsupported' } }
    })
    registry.update('apps.launch', 'permission_required', '접근성 권한 필요')
    expect(await executor.execute(launch())).toMatchObject({
      outcome: { error: { code: 'permission_denied' } }
    })
    registry.update('apps.launch', 'unavailable', '일시적으로 사용 불가')
    expect(await executor.execute(launch())).toMatchObject({
      outcome: { error: { code: 'unavailable' } }
    })
    expect(app.calls).toEqual([])
  })

  it('re-checks authentication and capability when a queued execution finally starts', async () => {
    const { executor, app, setSignedIn, registry } = setup()
    const release = app.holdCalls()
    const first = executor.execute(launch('com.example.a', 'first'))
    const second = executor.execute(launch('com.example.b', 'second'))
    const third = executor.execute(launch('com.example.c', 'third'))
    await flush()
    setSignedIn(false)
    registry.update('apps.launch', 'unavailable', '중단')
    release()
    expect(await first).toMatchObject({ outcome: { status: 'observed' } })
    expect(await second).toMatchObject({
      outcome: {
        status: 'not_started',
        reason: 'rejected',
        error: { code: 'authentication_required' }
      }
    })
    expect(await third).toMatchObject({ outcome: { status: 'not_started' } })
    expect(app.calls).toEqual(['launch:com.example.a'])
  })
})

describe('duplicate execution IDs', () => {
  it('runs once and returns the same report to every caller', async () => {
    const { executor, app } = setup()
    const invocation = launch()
    const [a, b] = await Promise.all([executor.execute(invocation), executor.execute(invocation)])
    expect(a).toBe(b)
    expect(await executor.execute(invocation)).toBe(a)
    expect(app.control.launch).toHaveBeenCalledTimes(1)
  })

  it('shares an in-flight execution instead of starting a second one', async () => {
    const { executor, app } = setup()
    const release = app.holdCalls()
    const invocation = launch()
    const first = executor.execute(invocation)
    await flush()
    const duplicate = executor.execute(invocation)
    release()
    expect(await duplicate).toBe(await first)
    expect(app.control.launch).toHaveBeenCalledTimes(1)
  })

  it('rejects a reused ID that carries a different command', async () => {
    const { executor, app } = setup()
    await executor.execute(launch('com.example.a', 'same-id'))
    expect(await executor.execute(launch('com.example.b', 'same-id'))).toMatchObject({
      outcome: { status: 'not_started', reason: 'rejected', error: { code: 'conflict' } }
    })
    expect(app.calls).toEqual(['launch:com.example.a'])
  })

  it('forgets old executions beyond its limit but never the recent ones', async () => {
    const app = fakeAppControl()
    const executor = new ToolExecutor({
      registry: new CapabilityRegistry(platformCapabilities('darwin')),
      appControl: app.control,
      auth: { requireSignedIn: () => ({ ok: true, value: undefined }) },
      clock: { now: () => 0 },
      restoreTarget: () => null,
      maxFinished: 2
    })
    for (const id of ['a', 'b', 'c']) await executor.execute(launch('com.example.a', id))
    await executor.execute(launch('com.example.a', 'c'))
    expect(app.control.launch).toHaveBeenCalledTimes(3)
    await executor.execute(launch('com.example.a', 'a'))
    expect(app.control.launch).toHaveBeenCalledTimes(4)
  })

  it('drops the previous user history and cancels their work on a new session', async () => {
    const { executor, app } = setup()
    const invocation = launch('com.example.a', 'shared-id')
    await executor.execute(invocation)
    executor.resetForNewSession()
    await executor.execute(invocation)
    expect(app.control.launch).toHaveBeenCalledTimes(2)
  })
})

describe('ordering, cancellation and expiry', () => {
  it('runs desktop-changing tools one at a time, in order', async () => {
    const { executor, app } = setup()
    const release = app.holdCalls()
    const a = executor.execute(launch('com.example.a', 'o1'))
    const b = executor.execute(launch('com.example.b', 'o2'))
    await flush()
    expect(app.calls).toEqual(['launch:com.example.a'])
    release()
    await Promise.all([a, b])
    expect(app.calls).toEqual(['launch:com.example.a', 'launch:com.example.b'])
  })

  it('does not queue read-only listing behind a slow launch', async () => {
    const { executor, app } = setup()
    app.holdCalls()
    void executor.execute(launch('com.example.a', 'slow'))
    await flush()
    const listed = await executor.execute({
      requestId: 'r',
      executionId: 'list-1',
      command: { tool: 'apps.list', arguments: {} }
    })
    expect(listed.outcome.status).toBe('observed')
  })

  it('cancels a queued execution before it starts', async () => {
    const { executor, app } = setup()
    const release = app.holdCalls()
    const first = executor.execute(launch('com.example.a', 'c1'))
    const queued = executor.execute(launch('com.example.b', 'c2'))
    await flush()
    expect(await executor.cancel('c2')).toEqual({ ok: true, value: 'prevented_start' })
    release()
    await first
    expect(await queued).toMatchObject({
      cancelRequested: true,
      outcome: { status: 'not_started', reason: 'cancelled' }
    })
    expect(app.calls).toEqual(['launch:com.example.a'])
  })

  it('records a cancel of a running execution without claiming it was undone', async () => {
    const { executor, app } = setup()
    const release = app.holdCalls()
    const running = executor.execute(launch('com.example.a', 'r1'))
    await flush()
    expect(await executor.cancel('r1')).toEqual({ ok: true, value: 'requested' })
    app.control.launch.mockImplementationOnce(async (appId) => confirmed(appId))
    release()
    const report = await running
    expect(report.cancelRequested).toBe(true)
    // The adapter finished its work before noticing the cancel, so the effect stands.
    expect(report.outcome.status === 'observed' || report.outcome.status === 'not_started').toBe(
      true
    )
  })

  it('reports the result of cancelling things that are done or unknown', async () => {
    const { executor } = setup()
    await executor.execute(launch('com.example.a', 'done'))
    expect(await executor.cancel('done')).toEqual({ ok: true, value: 'already_finished' })
    expect(await executor.cancel('nothing')).toEqual({ ok: true, value: 'not_found' })
  })

  it('honours an abort signal given by the caller', async () => {
    const { executor, app } = setup()
    const controller = new AbortController()
    controller.abort()
    const report = await executor.execute(launch(), { signal: controller.signal })
    expect(report).toMatchObject({
      cancelRequested: true,
      outcome: { status: 'not_started', reason: 'cancelled' }
    })
    expect(app.calls).toEqual([])
  })

  it('does not start an execution whose deadline has passed', async () => {
    const { executor, app } = setup()
    const report = await executor.execute(launch(), { deadlineMs: 500 })
    expect(report).toMatchObject({
      expired: true,
      outcome: { status: 'not_started', reason: 'expired' }
    })
    expect(ToolExecutionReportSchema.safeParse(report).success).toBe(true)
    expect(app.calls).toEqual([])
  })

  it('flags expiry that happens while running but keeps the real outcome', async () => {
    const { executor, app, tick } = setup()
    app.control.launch.mockImplementationOnce(async (appId) => {
      tick(2_000)
      return confirmed(appId)
    })
    const report = await executor.execute(launch(), { deadlineMs: 1_500 })
    expect(report.expired).toBe(true)
    expect(report.outcome).toMatchObject({ status: 'observed' })
  })

  it('cancels in-flight work when the session changes', async () => {
    const { executor, app } = setup()
    const release = app.holdCalls()
    const running = executor.execute(launch('com.example.a', 's1'))
    const queued = executor.execute(launch('com.example.b', 's2'))
    await flush()
    executor.resetForNewSession()
    release()
    await running
    expect(await queued).toMatchObject({ outcome: { status: 'not_started', reason: 'cancelled' } })
  })
})

describe('CapabilityRegistry', () => {
  it('advances its revision only when something changes and notifies subscribers', () => {
    const registry = new CapabilityRegistry(platformCapabilities('darwin'))
    const seen = vi.fn<(snapshot: { revision: number }) => void>()
    const unsubscribe = registry.subscribe(seen)
    const start = registry.getSnapshot().revision
    expect(registry.update('apps.launch', 'available')).toBe(false)
    expect(registry.getSnapshot().revision).toBe(start)
    expect(registry.update('apps.launch', 'permission_required', '권한 필요')).toBe(true)
    expect(registry.getSnapshot().revision).toBe(start + 1)
    expect(registry.find('apps.launch')).toMatchObject({
      availability: 'permission_required',
      reason: '권한 필요'
    })
    expect(seen).toHaveBeenCalledTimes(1)
    unsubscribe()
    registry.update('apps.launch', 'available')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('returns copies so callers cannot alter it', () => {
    const registry = new CapabilityRegistry(platformCapabilities('darwin'))
    registry.getSnapshot().capabilities[0].availability = 'unavailable'
    expect(registry.getSnapshot().capabilities[0].availability).toBe('available')
  })

  it('offers app tools only where an adapter exists', () => {
    const byTool = (platform: NodeJS.Platform) =>
      Object.fromEntries(platformCapabilities(platform).map((c) => [c.tool, c.availability]))
    expect(byTool('darwin')).toMatchObject({
      'apps.launch': 'available',
      'browser.open': 'available'
    })
    expect(byTool('win32')).toMatchObject({
      'apps.launch': 'unsupported',
      'browser.open': 'available'
    })
    expect(byTool('linux')['apps.list']).toBe('unsupported')
  })
})

describe('RestoreTargetTracker', () => {
  it('keeps the latest usable foreground app and clears it for a new session', async () => {
    const results: Result<{ appId: string } | null>[] = [
      { ok: true, value: { appId: 'com.example.one' } },
      { ok: true, value: null },
      { ok: false, error: { code: 'unavailable', message: '실패' } }
    ]
    const tracker = new RestoreTargetTracker({
      getForegroundWindow: async () => results.shift()!
    })
    await tracker.capture()
    expect(tracker.current()).toEqual({ appId: 'com.example.one' })
    await tracker.capture()
    await tracker.capture()
    expect(tracker.current()).toEqual({ appId: 'com.example.one' })
    tracker.clear()
    expect(tracker.current()).toBeNull()
  })

  it('ignores a capture that a clear superseded', async () => {
    let resolve: (value: Result<{ appId: string } | null>) => void = () => undefined
    const tracker = new RestoreTargetTracker({
      getForegroundWindow: () =>
        new Promise((r) => {
          resolve = r
        })
    })
    const capturing = tracker.capture()
    tracker.clear()
    resolve({ ok: true, value: { appId: 'com.example.late' } })
    await capturing
    expect(tracker.current()).toBeNull()
  })
})
