import { describe, expect, it } from 'vitest'
import { CommandResultSchema } from '../../src/main/commands/command-result'
import type { CommandResult } from '../../src/main/commands/command-result'
import { commandLabel, summarizeUnrun } from '../../src/main/commands/result-summary'

const result = (overrides: Record<string, unknown> = {}): CommandResult =>
  CommandResultSchema.parse({
    attempt_no: 1,
    status: 'rejected',
    observation_status: 'not_applicable',
    error_code: 'unsupported',
    failure_stage: 'capability',
    result_message: '이 기기에서는 지원하지 않는 명령이에요.',
    started_at: '2026-10-23T03:00:00.000Z',
    finished_at: '2026-10-23T03:00:00.000Z',
    reported_at: '2026-10-23T03:00:00.000Z',
    ...overrides
  })

describe('the name of a command', () => {
  it('is what the user would call it', () => {
    expect(commandLabel('apps.launch')).toBe('앱 실행')
    expect(commandLabel('apps.activate')).toBe('앱 전환')
    expect(commandLabel('apps.close')).toBe('앱 종료')
    expect(commandLabel('browser.search')).toBe('검색 열기')
    expect(commandLabel('system.status')).toBe('시스템 상태 확인')
  })

  it('is just "command" for a type this client does not know, and never the type the server chose', () => {
    for (const type of ['apps.explode', '__proto__', 'constructor', 'toString', '', 'rm -rf /'])
      expect(commandLabel(type)).toBe('명령')
    expect(commandLabel(null)).toBe('명령')
  })
})

describe('the words for a command that was not run', () => {
  it('says which command it was and why it was not run, as a failure', () => {
    expect(summarizeUnrun('apps.close', result())).toEqual({
      outcome: 'failure',
      ok: false,
      text: '앱 종료: 이 기기에서는 지원하지 않는 명령이에요.'
    })
  })

  it('is a failure for a command that came too late', () => {
    const late = result({
      status: 'failed',
      error_code: 'expired',
      failure_stage: 'timeout',
      result_message: '요청 시간이 지나 실행하지 않았어요.'
    })
    expect(summarizeUnrun('apps.launch', late)).toMatchObject({
      outcome: 'failure',
      text: '앱 실행: 요청 시간이 지나 실행하지 않았어요.'
    })
  })

  it('is "unknown" when it was cut short and whether it ran is not known', () => {
    const cut = result({
      status: 'unknown',
      observation_status: 'unknown',
      error_code: 'unknown',
      failure_stage: undefined,
      result_message: '명령이 실행됐는지 확인하지 못했어요.'
    })
    expect(summarizeUnrun('folder.open', cut)).toEqual({
      outcome: 'unknown',
      ok: false,
      text: '폴더 열기: 명령이 실행됐는지 확인하지 못했어요.'
    })
  })

  it('names a command it cannot name just "command"', () => {
    expect(summarizeUnrun(null, result()).text).toMatch(/^명령: /)
    expect(summarizeUnrun('apps.explode', result()).text).not.toContain('apps.explode')
  })

  it('is never counted as a success', () => {
    for (const status of ['failed', 'rejected'] as const)
      expect(
        summarizeUnrun(
          'apps.launch',
          result({ status, failure_stage: 'validation', error_code: 'invalid_input' })
        ).ok
      ).toBe(false)
  })
})
