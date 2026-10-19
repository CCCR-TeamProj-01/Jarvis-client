import { describe, expect, it } from 'vitest'
import {
  HttpUrlSchema,
  ToolCommandSchema,
  ToolExecutionReportSchema,
  UrlObservationSchema
} from '../../src/shared/contracts/tools'

describe('tool input boundary', () => {
  it.each(['https://example.com/path', 'http://localhost:3000/'])(
    'accepts supported URL %s',
    (url) => {
      expect(HttpUrlSchema.safeParse(url).success).toBe(true)
    }
  )

  it.each([
    '',
    'not a url',
    '/relative/path',
    'javascript:alert(1)',
    'file:///tmp/file',
    'ftp://example.com',
    ' https://example.com'
  ])('rejects unsupported URL %s without throwing outside Zod', (url) => {
    expect(HttpUrlSchema.safeParse(url).success).toBe(false)
  })

  it('accepts registered app IDs but rejects injected paths and unknown tools', () => {
    expect(
      ToolCommandSchema.safeParse({
        tool: 'apps.launch',
        arguments: { appId: 'chrome' }
      }).success
    ).toBe(true)
    expect(
      ToolCommandSchema.safeParse({
        tool: 'apps.launch',
        arguments: { appId: 'chrome', executablePath: '/bin/sh' }
      }).success
    ).toBe(false)
    expect(
      ToolCommandSchema.safeParse({
        tool: 'shell.execute',
        arguments: { command: 'anything' }
      }).success
    ).toBe(false)
    expect(
      ToolCommandSchema.safeParse({
        tool: 'browser.open',
        arguments: { appId: 'chrome' }
      }).success
    ).toBe(false)
  })
})

describe('observed effects and cancellation', () => {
  const completed = {
    requestId: 'request-1',
    executionId: 'execution-1',
    tool: 'apps.launch',
    outcome: {
      status: 'observed',
      observation: { kind: 'app', appId: 'chrome', status: 'confirmed' }
    },
    cancelRequested: false,
    expired: false
  }

  it('preserves an already observed effect when cancellation arrives too late', () => {
    const report = ToolExecutionReportSchema.parse({ ...completed, cancelRequested: true })
    expect(report.cancelRequested).toBe(true)
    expect(report.outcome.status).toBe('observed')
  })

  it('distinguishes prevented execution from an observed side effect', () => {
    const report = {
      ...completed,
      outcome: { status: 'not_started', reason: 'cancelled' },
      cancelRequested: true
    }
    expect(ToolExecutionReportSchema.safeParse(report).success).toBe(true)
    expect(ToolExecutionReportSchema.safeParse({ ...report, cancelRequested: false }).success).toBe(
      false
    )
    expect(
      ToolExecutionReportSchema.safeParse({
        ...report,
        outcome: { status: 'not_started', reason: 'expired' }
      }).success
    ).toBe(false)
  })

  it('does not allow app evidence for a different tool', () => {
    expect(
      ToolExecutionReportSchema.safeParse({ ...completed, tool: 'browser.open' }).success
    ).toBe(false)
    expect(ToolExecutionReportSchema.safeParse({ ...completed, tool: 'apps.list' }).success).toBe(
      false
    )
  })

  it('never represents URL handoff as confirmed page loading', () => {
    expect(
      UrlObservationSchema.safeParse({
        kind: 'url',
        url: 'https://example.com',
        status: 'dispatched'
      }).success
    ).toBe(true)
    expect(
      UrlObservationSchema.safeParse({
        kind: 'url',
        url: 'https://example.com',
        status: 'confirmed'
      }).success
    ).toBe(false)
  })
})
