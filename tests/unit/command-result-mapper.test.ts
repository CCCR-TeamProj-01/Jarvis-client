import { describe, expect, it } from 'vitest'
import { CommandResultSchema } from '../../src/main/commands/command-result'
import { rejectedResult, resultFromReport } from '../../src/main/commands/result-mapper'
import type { ResultContext } from '../../src/main/commands/result-mapper'
import type { ClientError } from '../../src/shared/contracts/common'
import { ToolExecutionReportSchema } from '../../src/shared/contracts/tools'
import type { ToolExecutionReport, ToolName } from '../../src/shared/contracts/tools'

const command = { attempt_no: 3 }
const timing = {
  startedAtMs: Date.parse('2026-10-22T03:00:00.000Z'),
  finishedAtMs: Date.parse('2026-10-22T03:00:01.500Z')
}
const context: ResultContext = { platform: 'darwin', timing }

function report(
  tool: ToolName,
  outcome: ToolExecutionReport['outcome'],
  flags: { cancelRequested?: boolean; expired?: boolean } = {}
): ToolExecutionReport {
  return ToolExecutionReportSchema.parse({
    requestId: 'req',
    executionId: 'exec',
    tool,
    outcome,
    cancelRequested: flags.cancelRequested ?? false,
    expired: flags.expired ?? false
  })
}

const error = (code: ClientError['code']): ClientError => ({ code, message: '내부 메시지' })

describe('observed results', () => {
  it.each(['confirmed', 'dispatched', 'unknown'] as const)(
    'reports an app observed as %s as a success with that observation level',
    (status) => {
      const result = resultFromReport(
        command,
        report('apps.launch', {
          status: 'observed',
          observation: { kind: 'app', appId: 'com.google.Chrome', status }
        }),
        { ...context, app: { appCode: 'chrome', osAppId: 'com.google.Chrome' } }
      )
      expect(result).toMatchObject({
        attempt_no: 3,
        status: 'success',
        observation_status: status,
        app: { app_code: 'chrome', os_app_id: 'com.google.Chrome' }
      })
      expect(result.error_code).toBeUndefined()
      expect(result.failure_stage).toBeUndefined()
    }
  )

  it('words a confirmed result as done and a handed-over one as requested', () => {
    const done = resultFromReport(
      command,
      report('system.mute', {
        status: 'observed',
        observation: { kind: 'audio', level: 0, muted: true, status: 'confirmed' }
      }),
      context
    )
    const handed = resultFromReport(
      command,
      report('folder.open', {
        status: 'observed',
        observation: { kind: 'folder', alias: 'downloads', status: 'dispatched' }
      }),
      context
    )
    expect(done.result_message).toContain('마쳤어요')
    expect(handed.result_message).toContain('요청했어요')
    expect(handed.result_message).toContain('확인하지 못했어요')
  })

  it('uses not_applicable where the tool has no observation level', () => {
    const result = resultFromReport(
      command,
      report('apps.list', { status: 'observed', observation: { kind: 'app_list', apps: [] } }),
      context
    )
    expect(result).toMatchObject({ status: 'success', observation_status: 'not_applicable' })
  })

  it('names the display name the OS gave, then the built-in name', () => {
    const observed = report('apps.activate', {
      status: 'observed',
      observation: { kind: 'app', appId: 'com.tinyspeck.slackmacgap', status: 'confirmed' }
    })
    const withName = resultFromReport(command, observed, {
      ...context,
      app: { appCode: 'slack', osAppId: 'com.tinyspeck.slackmacgap' },
      displayName: () => 'Slack 데스크톱'
    })
    const withoutName = resultFromReport(command, observed, {
      ...context,
      app: { appCode: 'slack', osAppId: 'com.tinyspeck.slackmacgap' }
    })
    expect(withName.app?.display_name).toBe('Slack 데스크톱')
    expect(withoutName.app?.display_name).toBe('Slack')
  })

  it('finds the app of a restore from its OS ID, and omits it when it is not a known one', () => {
    const known = resultFromReport(
      command,
      report('apps.restore', {
        status: 'observed',
        observation: { kind: 'app', appId: 'com.apple.Terminal', status: 'confirmed' }
      }),
      context
    )
    const other = resultFromReport(
      command,
      report('apps.restore', {
        status: 'observed',
        observation: { kind: 'app', appId: 'com.example.Unlisted', status: 'confirmed' }
      }),
      context
    )
    expect(known.app).toEqual({
      app_code: 'terminal',
      os_app_id: 'com.apple.Terminal',
      display_name: 'Terminal'
    })
    expect(other.app).toBeUndefined()
  })

  it('does not attach an app to a non-app observation', () => {
    const result = resultFromReport(
      command,
      report('browser.open', {
        status: 'observed',
        observation: {
          kind: 'url',
          url: 'https://example.com/private?token=abc',
          status: 'dispatched'
        }
      }),
      { ...context, app: { appCode: 'chrome', osAppId: 'com.google.Chrome' } }
    )
    expect(result.app).toBeUndefined()
  })
})

describe('failed and unknown results', () => {
  it.each([
    ['not_found', 'precondition', 'not_found'],
    ['unsupported', 'capability', 'unsupported'],
    ['permission_denied', 'capability', 'permission_denied'],
    ['authentication_required', 'capability', 'permission_denied'],
    ['session_expired', 'capability', 'permission_denied'],
    ['invalid_input', 'validation', 'invalid_input'],
    ['unavailable', 'dispatch', 'unavailable'],
    ['internal', 'internal', 'internal'],
    ['rate_limited', 'internal', 'internal'],
    ['conflict', 'internal', 'internal']
  ] as const)(
    'maps a %s failure with no effect to stage %s and code %s',
    (code, stage, errorCode) => {
      const result = resultFromReport(
        command,
        report('folder.open', { status: 'failed', error: error(code), effect: 'none' }),
        context
      )
      expect(result).toMatchObject({
        status: 'failed',
        observation_status: 'not_applicable',
        failure_stage: stage,
        error_code: errorCode
      })
    }
  )

  it.each(['unavailable', 'internal', 'rate_limited'] as const)(
    'treats a %s failure that may have acted as an execution failure with unknown observation',
    (code) => {
      const result = resultFromReport(
        command,
        report('apps.launch', { status: 'failed', error: error(code), effect: 'possible' }),
        context
      )
      expect(result).toMatchObject({
        status: 'failed',
        observation_status: 'unknown',
        failure_stage: 'execution'
      })
    }
  )

  it('reports an unknown outcome as unknown, without a failure stage, and never as a failure', () => {
    const result = resultFromReport(
      command,
      report('system.volume', { status: 'unknown', reason: '읽어 온 값을 알 수 없어요' }),
      context
    )
    expect(result).toMatchObject({
      status: 'unknown',
      observation_status: 'unknown',
      error_code: 'unknown'
    })
    // The server refuses a stage on an unknown result.
    expect(result.failure_stage).toBeUndefined()
  })
})

describe('results of commands that never started', () => {
  it('reports a cancellation as failed with the cancellation stage', () => {
    const result = resultFromReport(
      command,
      report(
        'apps.launch',
        { status: 'not_started', reason: 'cancelled' },
        { cancelRequested: true }
      ),
      context
    )
    expect(result).toMatchObject({
      status: 'failed',
      observation_status: 'not_applicable',
      error_code: 'cancelled',
      failure_stage: 'cancellation'
    })
  })

  it('reports an expiry as failed with the timeout stage', () => {
    const result = resultFromReport(
      command,
      report('apps.launch', { status: 'not_started', reason: 'expired' }, { expired: true }),
      context
    )
    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'expired',
      failure_stage: 'timeout'
    })
  })

  it.each([
    ['unsupported', 'capability', 'unsupported'],
    ['permission_denied', 'capability', 'permission_denied'],
    ['authentication_required', 'capability', 'permission_denied'],
    ['unavailable', 'capability', 'unavailable'],
    ['invalid_input', 'validation', 'invalid_input']
  ] as const)('reports a refusal for %s as rejected', (code, stage, errorCode) => {
    const result = resultFromReport(
      command,
      report('apps.launch', { status: 'not_started', reason: 'rejected', error: error(code) }),
      context
    )
    expect(result).toMatchObject({
      status: 'rejected',
      observation_status: 'not_applicable',
      failure_stage: stage,
      error_code: errorCode
    })
  })

  it('reports a refusal without a reason as a capability refusal', () => {
    const result = resultFromReport(
      command,
      report('apps.launch', { status: 'not_started', reason: 'rejected' }),
      context
    )
    expect(result).toMatchObject({ status: 'rejected', failure_stage: 'capability' })
  })

  it('does not call a reused execution ID a refusal of the user', () => {
    const result = resultFromReport(
      command,
      report('apps.launch', {
        status: 'not_started',
        reason: 'rejected',
        error: error('conflict')
      }),
      context
    )
    expect(result).toMatchObject({
      status: 'failed',
      failure_stage: 'internal',
      error_code: 'internal'
    })
  })
})

describe('rejectedResult', () => {
  it('turns a translation refusal into a rejected result', () => {
    expect(
      rejectedResult(
        command,
        {
          failureStage: 'validation',
          errorCode: 'invalid_input',
          message: '명령의 인자가 올바르지 않아 실행하지 않았어요.'
        },
        timing
      )
    ).toEqual({
      started_at: '2026-10-22T03:00:00.000Z',
      finished_at: '2026-10-22T03:00:01.500Z',
      reported_at: '2026-10-22T03:00:01.500Z',
      attempt_no: 3,
      status: 'rejected',
      observation_status: 'not_applicable',
      error_code: 'invalid_input',
      failure_stage: 'validation',
      result_message: '명령의 인자가 올바르지 않아 실행하지 않았어요.'
    })
  })
})

describe('what the server is never told', () => {
  const leaky: ToolExecutionReport[] = [
    report('browser.open', {
      status: 'observed',
      observation: {
        kind: 'url',
        url: 'https://example.com/path?token=SECRET-TOKEN',
        status: 'dispatched'
      }
    }),
    report('system.volume', {
      status: 'observed',
      observation: { kind: 'audio', level: 37, muted: false, status: 'confirmed' }
    }),
    report('folder.open', {
      status: 'failed',
      error: { code: 'not_found', message: '/Users/someone/Secret 폴더를 찾을 수 없어요' },
      effect: 'none'
    }),
    report('apps.launch', {
      status: 'not_started',
      reason: 'rejected',
      error: { code: 'unsupported', message: 'raw OS error: EACCES /private/var/secret' }
    }),
    report('system.mute', {
      status: 'unknown',
      reason: 'osascript said volume 37 at /Users/someone'
    })
  ]

  it.each(leaky.map((entry, index) => [index, entry] as const))(
    'keeps URLs, paths, volume values and error text out of report %i',
    (_index, entry) => {
      const result = resultFromReport(command, entry, context)
      expect(CommandResultSchema.safeParse(result).success).toBe(true)
      const wire = JSON.stringify(result)
      expect(wire).not.toMatch(/SECRET|token|https?:|\/Users|\/private|EACCES|osascript/i)
      expect(result.result_message ?? '').not.toMatch(/\d/)
    }
  )

  it('produces results the server schema accepts for every tool and outcome kind', () => {
    const tools: ToolName[] = [
      'apps.launch',
      'apps.activate',
      'apps.restore',
      'browser.open',
      'folder.open',
      'system.volume',
      'system.mute',
      'apps.list'
    ]
    for (const tool of tools) {
      for (const outcome of [
        { status: 'failed', error: error('internal'), effect: 'possible' },
        { status: 'unknown', reason: 'x' },
        { status: 'not_started', reason: 'rejected', error: error('unsupported') }
      ] as const) {
        const result = resultFromReport(command, report(tool, outcome), context)
        expect(CommandResultSchema.safeParse(result).success).toBe(true)
      }
    }
  })
})

describe("times and the server's own rules", () => {
  const failed = report('folder.open', {
    status: 'failed',
    error: error('not_found'),
    effect: 'none'
  })

  it('fixes the three times when the result is made, so a resend is identical', () => {
    const first = resultFromReport(command, failed, context)
    const again = resultFromReport(command, failed, { ...context })
    expect(first).toEqual(again)
    expect(first.started_at).toBe('2026-10-22T03:00:00.000Z')
    expect(first.finished_at).toBe('2026-10-22T03:00:01.500Z')
    expect(first.reported_at).toBe(first.finished_at)
  })

  it('never lets the finish precede the start when the clock went backwards', () => {
    const result = resultFromReport(command, failed, {
      ...context,
      timing: { startedAtMs: timing.startedAtMs, finishedAtMs: timing.startedAtMs - 5000 }
    })
    expect(result.finished_at).toBe(result.started_at)
  })

  it('refuses a stage on a success or an unknown result, as the server does', () => {
    const base = {
      attempt_no: 1,
      observation_status: 'unknown',
      started_at: '2026-10-22T03:00:00.000Z',
      finished_at: '2026-10-22T03:00:01.000Z',
      reported_at: '2026-10-22T03:00:01.000Z'
    }
    for (const status of ['success', 'unknown']) {
      expect(
        CommandResultSchema.safeParse({ ...base, status, failure_stage: 'observation' }).success
      ).toBe(false)
      expect(CommandResultSchema.safeParse({ ...base, status }).success).toBe(true)
    }
    for (const status of ['failed', 'rejected']) {
      expect(
        CommandResultSchema.safeParse({ ...base, status, failure_stage: 'execution' }).success
      ).toBe(true)
    }
  })

  it('refuses a body whose finish precedes its start, and a missing or zoneless time', () => {
    const base = {
      attempt_no: 1,
      status: 'failed',
      observation_status: 'not_applicable',
      started_at: '2026-10-22T03:00:05.000Z',
      finished_at: '2026-10-22T03:00:01.000Z',
      reported_at: '2026-10-22T03:00:05.000Z'
    }
    expect(CommandResultSchema.safeParse(base).success).toBe(false)
    expect(CommandResultSchema.safeParse({ ...base, finished_at: base.started_at }).success).toBe(
      true
    )
    expect(
      CommandResultSchema.safeParse({
        ...base,
        finished_at: base.started_at,
        reported_at: undefined
      }).success
    ).toBe(false)
    expect(
      CommandResultSchema.safeParse({
        ...base,
        finished_at: base.started_at,
        started_at: '2026-10-22T03:00:05'
      }).success
    ).toBe(false)
  })

  it('refuses unknown fields, which the server refuses too', () => {
    const result = resultFromReport(command, failed, context)
    expect(CommandResultSchema.safeParse({ ...result, url: 'https://example.com' }).success).toBe(
      false
    )
  })
})
