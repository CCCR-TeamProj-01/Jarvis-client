import { describe, expect, it } from 'vitest'
import {
  AudioObservationSchema,
  FolderObservationSchema,
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
      ToolCommandSchema.safeParse({ tool: 'folder.open', arguments: { alias: 'downloads' } })
        .success
    ).toBe(true)
    for (const alias of ['/Users/me', '..', 'Downloads', '', 'downloads ', 'trash'])
      expect(
        ToolCommandSchema.safeParse({ tool: 'folder.open', arguments: { alias } }).success
      ).toBe(false)
    expect(
      ToolCommandSchema.safeParse({
        tool: 'folder.open',
        arguments: { alias: 'downloads', path: '/etc' }
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
    expect(ToolExecutionReportSchema.safeParse({ ...completed, tool: 'folder.open' }).success).toBe(
      false
    )
  })

  it('accepts only bounded integer volume changes and boolean mute values', () => {
    const parse = (value: unknown) => ToolCommandSchema.safeParse(value).success
    expect(parse({ tool: 'system.volume', arguments: { mode: 'set', level: 0 } })).toBe(true)
    expect(parse({ tool: 'system.volume', arguments: { mode: 'set', level: 100 } })).toBe(true)
    expect(parse({ tool: 'system.volume', arguments: { mode: 'adjust', delta: -100 } })).toBe(true)
    expect(parse({ tool: 'system.mute', arguments: { muted: false } })).toBe(true)
    for (const bad of [
      { mode: 'set', level: 101 },
      { mode: 'set', level: -1 },
      { mode: 'set', level: 1.5 },
      { mode: 'set', level: '10' },
      { mode: 'set', level: Number.NaN },
      { mode: 'adjust', delta: 101 },
      { mode: 'adjust', level: 10 },
      { mode: 'set', delta: 10 },
      { mode: 'set', level: 10, delta: 10 },
      { mode: 'toggle' },
      { level: 10 }
    ])
      expect(parse({ tool: 'system.volume', arguments: bad })).toBe(false)
    for (const bad of [{ muted: 'true' }, { muted: 1 }, {}, { muted: true, extra: 1 }])
      expect(parse({ tool: 'system.mute', arguments: bad })).toBe(false)
  })

  it('represents the audio state read back, never a bare request', () => {
    const observation = { kind: 'audio', level: 40, muted: false, status: 'confirmed' }
    expect(AudioObservationSchema.safeParse(observation).success).toBe(true)
    expect(
      AudioObservationSchema.safeParse({ ...observation, level: null, muted: null }).success
    ).toBe(true)
    expect(AudioObservationSchema.safeParse({ ...observation, level: 101 }).success).toBe(false)
    expect(AudioObservationSchema.safeParse({ ...observation, status: 'done' }).success).toBe(false)
    for (const tool of ['system.volume', 'system.mute'])
      expect(
        ToolExecutionReportSchema.safeParse({
          ...completed,
          tool,
          outcome: { status: 'observed', observation }
        }).success
      ).toBe(true)
    expect(ToolExecutionReportSchema.safeParse({ ...completed, tool: 'system.mute' }).success).toBe(
      false
    )
  })

  it('never represents a folder handoff as a confirmed window, and carries no path', () => {
    const observation = { kind: 'folder', alias: 'downloads', status: 'dispatched' }
    expect(FolderObservationSchema.safeParse(observation).success).toBe(true)
    expect(FolderObservationSchema.safeParse({ ...observation, status: 'confirmed' }).success).toBe(
      false
    )
    expect(FolderObservationSchema.safeParse({ ...observation, path: '/Users/me' }).success).toBe(
      false
    )
    expect(
      ToolExecutionReportSchema.safeParse({
        ...completed,
        tool: 'folder.open',
        outcome: { status: 'observed', observation }
      }).success
    ).toBe(true)
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
