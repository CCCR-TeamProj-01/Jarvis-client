import { describe, expect, it } from 'vitest'
import {
  activityEventType,
  activityFor,
  eventTypeFor,
  resultForSending,
  runningAppCodes,
  usesApp
} from '../../src/main/commands/activity'
import type { CollectionConsent } from '../../src/main/commands/activity'
import { ActivityReportSchema, CommandResultSchema } from '../../src/main/commands/command-result'
import type { CommandResult } from '../../src/main/commands/command-result'

const CHROME = 'com.google.Chrome'
const FINISHED = '2026-10-22T03:00:02.000Z'
const BOTH: CollectionConsent = { activityEnabled: true, externalEnabled: true, revision: 3 }

const result = (overrides: Record<string, unknown> = {}): CommandResult =>
  CommandResultSchema.parse({
    attempt_no: 1,
    status: 'success',
    observation_status: 'confirmed',
    result_message: '앱 실행을(를) 마쳤어요.',
    started_at: '2026-10-22T03:00:01.000Z',
    finished_at: FINISHED,
    reported_at: FINISHED,
    app: { app_code: 'chrome', os_app_id: CHROME, display_name: 'Google Chrome' },
    ...overrides
  })
const input = (overrides: Partial<Parameters<typeof activityFor>[0]> = {}) => ({
  tool: 'apps.launch' as const,
  result: result(),
  consent: BOTH,
  runningBefore: new Set<string>(),
  runningNow: ['chrome', 'vscode'] as const,
  eventKey: 'act_1',
  ...overrides
})

describe('which tools use an app', () => {
  it('are the three that start or bring up an app', () => {
    for (const tool of ['apps.launch', 'apps.activate', 'apps.restore'] as const)
      expect(usesApp(tool)).toBe(true)
    for (const tool of [
      'apps.list',
      'browser.open',
      'folder.open',
      'system.volume',
      'system.mute'
    ] as const)
      expect(usesApp(tool)).toBe(false)
  })
})

describe('a start and a coming to the front', () => {
  it('is a start only when the app was seen not to be running', () => {
    expect(eventTypeFor('apps.launch', CHROME, new Set())).toBe('launched')
    expect(eventTypeFor('apps.launch', CHROME, new Set(['com.apple.Terminal']))).toBe('launched')
  })

  it('is only coming to the front when the app was already running', () => {
    expect(eventTypeFor('apps.launch', CHROME, new Set([CHROME]))).toBe('activated')
  })

  it('claims nothing about a launch when it was not known what was running', () => {
    expect(eventTypeFor('apps.launch', CHROME, null)).toBeNull()
  })

  it('is always coming to the front for activating and restoring, which start nothing', () => {
    for (const before of [null, new Set<string>(), new Set([CHROME])]) {
      expect(eventTypeFor('apps.activate', CHROME, before)).toBe('activated')
      expect(eventTypeFor('apps.restore', CHROME, before)).toBe('activated')
    }
  })

  it('is nothing for a tool that does not use an app', () => {
    expect(eventTypeFor('folder.open', CHROME, new Set())).toBeNull()
    expect(eventTypeFor('system.mute', CHROME, new Set())).toBeNull()
  })
})

describe('the apps that are running', () => {
  it('are the server’s codes, each once, in a fixed order', () => {
    expect(
      runningAppCodes(
        ['com.microsoft.VSCode', CHROME, 'com.google.Chrome', 'com.apple.calculator'],
        'darwin'
      )
    ).toEqual(['calculator', 'chrome', 'vscode'])
  })

  it('leave out every app the server has no code for', () => {
    expect(
      runningAppCodes(['org.example.Secret', '/Applications/Secret.app', 'Secret'], 'darwin')
    ).toEqual([])
    expect(runningAppCodes([], 'darwin')).toEqual([])
  })

  it('are none on a platform with no codes', () => {
    expect(runningAppCodes([CHROME, 'chrome.exe'], 'win32')).toEqual([])
  })
})

describe('what calls for an activity', () => {
  it('is a successful, confirmed use of a known app, with the consent', () => {
    expect(activityEventType(input())).toBe('launched')
    expect(activityEventType(input({ runningBefore: new Set([CHROME]) }))).toBe('activated')
    expect(activityEventType(input({ tool: 'apps.activate' }))).toBe('activated')
  })

  it('is nothing without the consent to collect activity', () => {
    expect(activityEventType(input({ consent: { ...BOTH, activityEnabled: false } }))).toBeNull()
    // The other consent does not stand in for it.
    expect(
      activityEventType(
        input({ consent: { activityEnabled: false, externalEnabled: true, revision: 3 } })
      )
    ).toBeNull()
  })

  it('is nothing for a request that was only handed over, or whose outcome is not known', () => {
    for (const observation_status of ['dispatched', 'unknown', 'not_applicable'])
      expect(activityEventType(input({ result: result({ observation_status }) }))).toBeNull()
  })

  it('is nothing for a result that is not a success, whatever it says it observed', () => {
    for (const status of ['failed', 'rejected', 'unknown'] as const) {
      // Not a body the app makes; the check must hold on its own.
      const odd = { ...result(), status, observation_status: 'confirmed' } as CommandResult
      expect(activityEventType(input({ result: odd }))).toBeNull()
    }
  })

  it('is nothing for a failure, a refusal or an unknown result', () => {
    expect(
      activityEventType(
        input({
          result: result({
            status: 'failed',
            observation_status: 'not_applicable',
            error_code: 'unavailable',
            failure_stage: 'dispatch'
          })
        })
      )
    ).toBeNull()
    expect(
      activityEventType(
        input({
          result: result({
            status: 'rejected',
            observation_status: 'not_applicable',
            error_code: 'unsupported',
            failure_stage: 'capability'
          })
        })
      )
    ).toBeNull()
    expect(
      activityEventType(
        input({
          result: result({
            status: 'unknown',
            observation_status: 'unknown',
            error_code: 'unknown'
          })
        })
      )
    ).toBeNull()
  })

  it('is nothing without an app the server knows', () => {
    const { app: _app, ...withoutApp } = result()
    expect(activityEventType(input({ result: withoutApp as CommandResult }))).toBeNull()
  })

  it('is nothing for a launch whose earlier state is not known, and for a tool with no app', () => {
    expect(activityEventType(input({ runningBefore: null }))).toBeNull()
    expect(activityEventType(input({ tool: 'folder.open' }))).toBeNull()
  })
})

describe('the activity', () => {
  it('names the event, its time, the revision and the running apps', () => {
    expect(activityFor(input())).toEqual({
      event_key: 'act_1',
      event_type: 'launched',
      occurred_at: FINISHED,
      collection_revision: 3,
      running_apps: ['chrome', 'vscode']
    })
  })

  it('has no list of apps without the extra consent, whatever list was taken', () => {
    const made = activityFor(input({ consent: { ...BOTH, externalEnabled: false } }))
    expect(made).toMatchObject({ event_type: 'launched' })
    expect(made).not.toHaveProperty('running_apps')
  })

  it('has no list when it could not be taken, but an empty one when nothing in the set was running', () => {
    expect(activityFor(input({ runningNow: null }))).not.toHaveProperty('running_apps')
    expect(activityFor(input({ runningNow: [] }))).toHaveProperty('running_apps', [])
  })

  it('carries the revision it was made under', () => {
    expect(activityFor(input({ consent: { ...BOTH, revision: 41 } }))?.collection_revision).toBe(41)
  })

  it('is none when nothing calls for one', () => {
    expect(activityFor(input({ consent: { ...BOTH, activityEnabled: false } }))).toBeUndefined()
  })

  it('does not share the list it was given', () => {
    const codes = ['chrome'] as const
    const made = activityFor(input({ runningNow: codes }))
    expect(made?.running_apps).not.toBe(codes)
  })
})

describe('the activity as the schema takes it', () => {
  const activity = {
    event_key: 'act_1',
    event_type: 'launched',
    occurred_at: FINISHED,
    collection_revision: 0
  }

  it('takes what the server takes: a start or a coming to the front', () => {
    expect(ActivityReportSchema.safeParse(activity).success).toBe(true)
    expect(ActivityReportSchema.safeParse({ ...activity, event_type: 'activated' }).success).toBe(
      true
    )
  })

  it('never takes a close, which is not reported', () => {
    expect(ActivityReportSchema.safeParse({ ...activity, event_type: 'closed' }).success).toBe(
      false
    )
  })

  it('refuses a key that is empty or too long, a bad time and a bad revision', () => {
    for (const bad of [
      { event_key: '' },
      { event_key: 'a'.repeat(161) },
      { occurred_at: 'yesterday' },
      { collection_revision: -1 },
      { collection_revision: 1.5 }
    ])
      expect(ActivityReportSchema.safeParse({ ...activity, ...bad }).success).toBe(false)
    expect(
      ActivityReportSchema.safeParse({ ...activity, event_key: 'a'.repeat(160) }).success
    ).toBe(true)
  })

  it('takes only the server’s app codes, once each, and no more than a hundred', () => {
    expect(
      ActivityReportSchema.safeParse({ ...activity, running_apps: ['chrome', 'slack'] }).success
    ).toBe(true)
    expect(ActivityReportSchema.safeParse({ ...activity, running_apps: [] }).success).toBe(true)
    for (const running_apps of [
      ['chrome', 'chrome'],
      ['Secret App'],
      ['/Applications/X.app'],
      ['']
    ])
      expect(ActivityReportSchema.safeParse({ ...activity, running_apps }).success).toBe(false)
  })

  it('refuses a field it does not know, such as a window title or a path', () => {
    for (const extra of [{ window_title: 'x' }, { path: '/Users/x' }, { url: 'https://x' }])
      expect(ActivityReportSchema.safeParse({ ...activity, ...extra }).success).toBe(false)
  })

  it('is part of a result only with its app and only on a success', () => {
    expect(CommandResultSchema.safeParse({ ...result(), activity }).success).toBe(true)
    const { app: _app, ...withoutApp } = result()
    expect(CommandResultSchema.safeParse({ ...withoutApp, activity }).success).toBe(false)
    expect(
      CommandResultSchema.safeParse({
        ...result({
          status: 'failed',
          observation_status: 'not_applicable',
          error_code: 'internal',
          failure_stage: 'internal'
        }),
        activity
      }).success
    ).toBe(false)
  })
})

describe('the result as it is sent', () => {
  const withActivity = (running_apps?: string[]): CommandResult =>
    CommandResultSchema.parse({
      ...result(),
      activity: {
        event_key: 'act_1',
        event_type: 'launched',
        occurred_at: FINISHED,
        collection_revision: 3,
        ...(running_apps ? { running_apps } : {})
      }
    })

  it('is unchanged when it has no activity', () => {
    const plain = result()
    expect(resultForSending(plain, null)).toBe(plain)
    expect(resultForSending(plain, BOTH)).toBe(plain)
  })

  it('is unchanged while the consent and the revision are as they were', () => {
    const sent = withActivity(['chrome'])
    expect(resultForSending(sent, BOTH)).toBe(sent)
  })

  it('leaves the activity out when the consent cannot be told', () => {
    expect(resultForSending(withActivity(['chrome']), null)).not.toHaveProperty('activity')
  })

  it('leaves it out when the consent was withdrawn, or the revision has moved on', () => {
    for (const consent of [
      { ...BOTH, activityEnabled: false },
      { ...BOTH, revision: 4 },
      { ...BOTH, revision: 2 }
    ])
      expect(resultForSending(withActivity(['chrome']), consent)).not.toHaveProperty('activity')
  })

  it('keeps everything else of the result when the activity is left out', () => {
    const sent = withActivity(['chrome'])
    const { activity: _activity, ...rest } = sent
    expect(resultForSending(sent, null)).toEqual(rest)
  })

  it('leaves out only the list of apps when the extra consent was withdrawn', () => {
    const sent = resultForSending(withActivity(['chrome', 'vscode']), {
      ...BOTH,
      externalEnabled: false
    })
    expect(sent.activity).toBeDefined()
    expect(sent.activity).not.toHaveProperty('running_apps')
    expect(sent.activity).toMatchObject({
      event_key: 'act_1',
      event_type: 'launched',
      collection_revision: 3
    })
  })

  it('does not change what it was given', () => {
    const original = withActivity(['chrome'])
    const before = JSON.stringify(original)
    resultForSending(original, null)
    resultForSending(original, { ...BOTH, externalEnabled: false })
    expect(JSON.stringify(original)).toBe(before)
  })
})
