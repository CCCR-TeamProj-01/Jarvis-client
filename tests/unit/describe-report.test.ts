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
    expect(describeToolReport(launched, () => 'Safari')).toEqual({
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
    expect(describeToolReport(unsure)).toEqual({
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
    ).toEqual({ ok: true, text: '바탕 화면 폴더를 열도록 요청했어요.' })
    expect(
      describeToolReport(
        report('folder.open', {
          status: 'observed',
          observation: { kind: 'folder', alias: 'documents', status: 'unknown' }
        })
      )
    ).toEqual({ ok: false, text: '문서 폴더를 열었는지 확인하지 못했어요.' })
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
    expect(audio('system.volume', 40, false, 'confirmed')).toEqual({
      ok: true,
      text: '볼륨을 40%로 맞췄어요.'
    })
    expect(audio('system.volume', 40, true, 'confirmed').text).toBe(
      '볼륨을 40%로 맞췄어요. 지금은 음소거 상태예요.'
    )
    expect(audio('system.volume', null, null, 'dispatched')).toEqual({
      ok: true,
      text: '볼륨 변경을 요청했어요.'
    })
    expect(audio('system.volume', 12, false, 'unknown')).toEqual({
      ok: false,
      text: '볼륨을 바꿨는지 확인하지 못했어요. 지금은 12%예요.'
    })
    expect(audio('system.mute', 30, true, 'confirmed').text).toBe('음소거했어요.')
    expect(audio('system.mute', 30, false, 'confirmed').text).toBe('음소거를 해제했어요.')
    expect(audio('system.mute', null, null, 'dispatched').text).toBe('음소거 변경을 요청했어요.')
    expect(audio('system.mute', 30, false, 'unknown')).toEqual({
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
    ).toEqual({ ok: false, text: '앱 실행을(를) 실행하지 않았어요. 로그인이 필요합니다.' })
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
