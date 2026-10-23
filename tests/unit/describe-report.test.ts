import { describe, expect, it } from 'vitest'
import { describeToolReport } from '../../src/main/tools/describe-report'
import type { ToolExecutionReport } from '../../src/shared/contracts/tools'
import { ToolExecutionReportSchema } from '../../src/shared/contracts/tools'

const report = (
  tool: ToolExecutionReport['tool'],
  outcome: ToolExecutionReport['outcome'],
  extra: Partial<ToolExecutionReport> = {}
): ToolExecutionReport =>
  ToolExecutionReportSchema.parse({
    requestId: 'r',
    executionId: 'e',
    tool,
    outcome,
    cancelRequested: false,
    expired: false,
    ...extra
  })

describe('describeToolReport', () => {
  it('says what was confirmed, using a known display name', () => {
    const launched = report('apps.launch', {
      status: 'observed',
      observation: { kind: 'app', appId: 'com.apple.Safari', status: 'confirmed' }
    })
    expect(describeToolReport(launched, () => 'Safari')).toMatchObject({
      ok: true,
      text: 'Safari을(를) 열었어요.'
    })
  })

  it('falls back to the last part of the app ID without a display name', () => {
    const launched = report('apps.launch', {
      status: 'observed',
      observation: { kind: 'app', appId: 'com.apple.Safari', status: 'confirmed' }
    })
    expect(describeToolReport(launched).text).toBe('Safari을(를) 열었어요.')
  })

  it('does not claim more than a handed-over request proves', () => {
    const launched = report('apps.launch', {
      status: 'observed',
      observation: { kind: 'app', appId: 'com.apple.Safari', status: 'dispatched' }
    })
    expect(describeToolReport(launched).text).toBe('Safari 실행을 요청했어요.')
    const unsure = report('apps.activate', {
      status: 'observed',
      observation: { kind: 'app', appId: 'com.apple.Safari', status: 'unknown' }
    })
    expect(describeToolReport(unsure)).toMatchObject({
      ok: false,
      text: 'Safari(으)로 전환했는지 확인하지 못했어요.'
    })
  })

  it('describes listings, URLs and going back', () => {
    expect(
      describeToolReport(
        report('apps.list', {
          status: 'observed',
          observation: {
            kind: 'app_list',
            apps: [{ appId: 'a', displayName: 'A', state: 'running' }]
          }
        })
      ).text
    ).toBe('앱 1개를 확인했어요.')
    expect(
      describeToolReport(
        report('browser.open', {
          status: 'observed',
          observation: {
            kind: 'url',
            url: 'https://www.google.com/search?q=secret',
            status: 'dispatched'
          }
        })
      ).text
    ).toBe('www.google.com 주소를 브라우저로 전달했어요.')
    expect(
      describeToolReport(
        report('folder.open', {
          status: 'observed',
          observation: { kind: 'folder', alias: 'desktop', status: 'dispatched' }
        })
      )
    ).toMatchObject({ ok: true, text: '바탕 화면 폴더를 열도록 요청했어요.' })
    expect(
      describeToolReport(
        report('folder.open', {
          status: 'observed',
          observation: { kind: 'folder', alias: 'documents', status: 'unknown' }
        })
      )
    ).toMatchObject({ ok: false, text: '문서 폴더를 열었는지 확인하지 못했어요.' })
    const audio = (
      tool: 'system.volume' | 'system.mute',
      level: number | null,
      muted: boolean | null,
      status: 'confirmed' | 'dispatched' | 'unknown'
    ) =>
      describeToolReport(
        report(tool, {
          status: 'observed',
          observation: { kind: 'audio', level, muted, status }
        })
      )
    expect(audio('system.volume', 40, false, 'confirmed')).toMatchObject({
      ok: true,
      text: '볼륨을 40%로 맞췄어요.'
    })
    expect(audio('system.volume', 40, true, 'confirmed').text).toBe(
      '볼륨을 40%로 맞췄어요. 지금은 음소거 상태예요.'
    )
    expect(audio('system.volume', null, null, 'dispatched')).toMatchObject({
      ok: true,
      text: '볼륨 변경을 요청했어요.'
    })
    expect(audio('system.volume', 12, false, 'unknown')).toMatchObject({
      ok: false,
      text: '볼륨을 바꿨는지 확인하지 못했어요. 지금은 12%예요.'
    })
    expect(audio('system.mute', 30, true, 'confirmed').text).toBe('음소거했어요.')
    expect(audio('system.mute', 30, false, 'confirmed').text).toBe('음소거를 해제했어요.')
    expect(audio('system.mute', null, null, 'dispatched').text).toBe('음소거 변경을 요청했어요.')
    expect(audio('system.mute', 30, false, 'unknown')).toMatchObject({
      ok: false,
      text: '음소거 상태를 확인하지 못했어요.'
    })
    expect(
      describeToolReport(
        report('apps.restore', {
          status: 'observed',
          observation: { kind: 'app', appId: 'com.apple.Notes', status: 'confirmed' }
        })
      ).text
    ).toBe('Notes(으)로 돌아갔어요.')
  })

  it('tells apart requests that never started', () => {
    expect(
      describeToolReport(
        report(
          'apps.launch',
          { status: 'not_started', reason: 'cancelled' },
          { cancelRequested: true }
        )
      ).text
    ).toContain('취소')
    expect(
      describeToolReport(
        report('apps.launch', { status: 'not_started', reason: 'expired' }, { expired: true })
      ).text
    ).toContain('시간이 지나')
    expect(
      describeToolReport(
        report('apps.launch', {
          status: 'not_started',
          reason: 'rejected',
          error: { code: 'authentication_required', message: '로그인이 필요합니다.' }
        })
      )
    ).toMatchObject({ ok: false, text: '앱 실행을(를) 실행하지 않았어요. 로그인이 필요합니다.' })
  })

  it('separates a failure with no effect from one that may have acted', () => {
    const failed = (effect: 'none' | 'possible') =>
      describeToolReport(
        report('apps.launch', {
          status: 'failed',
          error: { code: 'unavailable', message: '앱을 열 수 없어요.' },
          effect
        })
      ).text
    expect(failed('none')).toContain('실패했어요')
    expect(failed('possible')).toContain('결과를 확인하지 못했어요')
    expect(
      describeToolReport(report('apps.launch', { status: 'unknown', reason: '모름' })).text
    ).toBe('앱 실행 결과를 확인하지 못했어요.')
  })
})

describe('the outcome of a report', () => {
  const app = (tool: 'apps.launch' | 'apps.activate' | 'apps.restore', status: string) =>
    report(tool, {
      status: 'observed',
      observation: { kind: 'app', appId: 'com.apple.Safari', status }
    } as ToolExecutionReport['outcome'])

  it('is a success only for what was seen to happen', () => {
    for (const tool of ['apps.launch', 'apps.activate', 'apps.restore'] as const)
      expect(describeToolReport(app(tool, 'confirmed'))).toMatchObject({
        outcome: 'success',
        ok: true
      })
  })

  it('is only "requested" for a request that was handed over, and is not counted as a success', () => {
    for (const tool of ['apps.launch', 'apps.activate', 'apps.restore'] as const) {
      const described = describeToolReport(app(tool, 'dispatched'))
      expect(described.outcome).toBe('requested')
      expect(described.text).toMatch(/요청/)
      expect(described.text).not.toMatch(/열었어요|전환했어요|돌아갔어요/)
    }
  })

  it('is "unknown" when it could not be told whether it happened', () => {
    for (const tool of ['apps.launch', 'apps.activate', 'apps.restore'] as const)
      expect(describeToolReport(app(tool, 'unknown'))).toMatchObject({
        outcome: 'unknown',
        ok: false
      })
  })

  it('follows the status for a URL, a folder and the volume', () => {
    const url = (status: string) =>
      describeToolReport(
        report('browser.open', {
          status: 'observed',
          observation: { kind: 'url', url: 'https://example.com/x', status }
        } as ToolExecutionReport['outcome'])
      ).outcome
    expect([url('dispatched'), url('unknown')]).toEqual(['requested', 'unknown'])
    const folder = (status: string) =>
      describeToolReport(
        report('folder.open', {
          status: 'observed',
          observation: { kind: 'folder', alias: 'downloads', status }
        } as ToolExecutionReport['outcome'])
      ).outcome
    expect([folder('dispatched'), folder('unknown')]).toEqual(['requested', 'unknown'])
    const audio = (tool: 'system.volume' | 'system.mute', status: string) =>
      describeToolReport(
        report(tool, {
          status: 'observed',
          observation: { kind: 'audio', level: 30, muted: false, status }
        } as ToolExecutionReport['outcome'])
      ).outcome
    expect(
      (['confirmed', 'dispatched', 'unknown'] as const).map((status) =>
        audio('system.volume', status)
      )
    ).toEqual(['success', 'requested', 'unknown'])
    expect(
      (['confirmed', 'dispatched', 'unknown'] as const).map((status) =>
        audio('system.mute', status)
      )
    ).toEqual(['success', 'requested', 'unknown'])
  })

  it('is a success for a list of apps', () => {
    expect(
      describeToolReport(
        report('apps.list', { status: 'observed', observation: { kind: 'app_list', apps: [] } })
      ).outcome
    ).toBe('success')
  })

  it('is a failure for what did not run, whatever the reason', () => {
    const flags = {
      cancelled: { cancelRequested: true },
      expired: { expired: true },
      rejected: {}
    } as const
    for (const reason of ['cancelled', 'expired', 'rejected'] as const)
      expect(
        describeToolReport(
          report(
            'apps.launch',
            {
              status: 'not_started',
              reason,
              error: { code: 'invalid_input', message: '안 됐어요.' }
            },
            flags[reason]
          )
        )
      ).toMatchObject({ outcome: 'failure', ok: false })
  })

  it('is a failure when it failed having done nothing, and "unknown" when it may have acted', () => {
    const failed = (effect: 'none' | 'possible') =>
      describeToolReport(
        report('apps.activate', {
          status: 'failed',
          effect,
          error: { code: 'not_found', message: '앱이 실행 중이 아니에요.' }
        } as ToolExecutionReport['outcome'])
      )
    expect(failed('none')).toMatchObject({ outcome: 'failure', ok: false })
    expect(failed('possible')).toMatchObject({ outcome: 'unknown', ok: false })
  })

  it('is "unknown" for a result that could not be told', () => {
    expect(
      describeToolReport(report('system.mute', { status: 'unknown', reason: 'lost' }))
    ).toMatchObject({ outcome: 'unknown', ok: false })
  })
})
