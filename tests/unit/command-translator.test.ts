import { describe, expect, it } from 'vitest'
import {
  APP_CODES,
  appCodeFor,
  appDisplayNameFor,
  osAppIdFor
} from '../../src/main/commands/app-codes'
import { invocationFor, translateCommand } from '../../src/main/commands/command-translator'
import { ServerCommandSchema, executionIdFor } from '../../src/main/commands/server-command'
import type { ServerCommand } from '../../src/main/commands/server-command'
import { ToolInvocationSchema } from '../../src/shared/contracts/tools'

function command(overrides: Partial<Record<keyof ServerCommand, unknown>> = {}): ServerCommand {
  return ServerCommandSchema.parse({
    command_id: 7,
    attempt_no: 1,
    command_type: 'apps.launch',
    requested_app_code: null,
    arguments: {},
    requested_at: '2026-10-22T03:00:00Z',
    ...overrides
  })
}

function translate(overrides: Partial<Record<keyof ServerCommand, unknown>>, platform = 'darwin') {
  return translateCommand(command(overrides), platform as NodeJS.Platform)
}

describe('ServerCommandSchema', () => {
  it('accepts the documented shape and ignores fields it does not know', () => {
    const parsed = ServerCommandSchema.safeParse({
      command_id: 7,
      attempt_no: 2,
      command_type: 'folder.open',
      requested_app_code: null,
      arguments: { alias: 'downloads' },
      requested_at: '2026-10-22T03:00:00+09:00',
      future_field: true
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.command_id).toBe('7')
  })

  it.each([
    ['a string command ID', { command_id: '7' }],
    ['an unsafe integer command ID', { command_id: 2 ** 53 }],
    ['a zero attempt', { attempt_no: 0 }],
    ['a fractional attempt', { attempt_no: 1.5 }],
    ['an empty command type', { command_type: '' }],
    ['array arguments', { arguments: [] }],
    ['null arguments', { arguments: null }],
    ['a time without a zone', { requested_at: '2026-10-22T03:00:00' }],
    ['a non-time', { requested_at: 'yesterday' }]
  ])('rejects %s', (_name, overrides) => {
    const raw = {
      command_id: 7,
      attempt_no: 1,
      command_type: 'apps.launch',
      requested_app_code: 'chrome',
      arguments: {},
      requested_at: '2026-10-22T03:00:00Z',
      ...overrides
    }
    expect(ServerCommandSchema.safeParse(raw).success).toBe(false)
  })

  it('makes an execution ID that is stable for one command and attempt only', () => {
    expect(executionIdFor({ command_id: '7', attempt_no: 1 })).toBe(
      executionIdFor({ command_id: '7', attempt_no: 1 })
    )
    expect(executionIdFor({ command_id: '7', attempt_no: 1 })).not.toBe(
      executionIdFor({ command_id: '7', attempt_no: 2 })
    )
    expect(executionIdFor({ command_id: '7', attempt_no: 1 })).not.toBe(
      executionIdFor({ command_id: '8', attempt_no: 1 })
    )
  })
})

describe('app codes', () => {
  it('maps all fourteen codes on macOS to distinct bundle identifiers', () => {
    expect(APP_CODES).toHaveLength(14)
    const ids = APP_CODES.map((code) => osAppIdFor(code, 'darwin'))
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(14)
  })

  it('has no mapping on Windows or Linux', () => {
    for (const code of APP_CODES) {
      expect(osAppIdFor(code, 'win32')).toBeUndefined()
      expect(osAppIdFor(code, 'linux')).toBeUndefined()
    }
  })

  it('finds the code of a known application and nothing for others', () => {
    expect(appCodeFor('com.google.Chrome', 'darwin')).toBe('chrome')
    expect(appCodeFor('com.example.Other', 'darwin')).toBeUndefined()
    expect(appCodeFor('com.google.Chrome', 'win32')).toBeUndefined()
  })
})

describe('translateCommand: applications', () => {
  it.each(['apps.launch', 'apps.activate'] as const)('%s uses the top-level app code', (type) => {
    const result = translate({ command_type: type, requested_app_code: 'slack' })
    expect(result).toEqual({
      ok: true,
      value: {
        command: { tool: type, arguments: { appId: 'com.tinyspeck.slackmacgap' } },
        app: { appCode: 'slack', osAppId: 'com.tinyspeck.slackmacgap' }
      }
    })
  })

  it.each([
    ['no code', { requested_app_code: null }],
    ['an empty code', { requested_app_code: '' }],
    ['a code outside the fixed set', { requested_app_code: 'photoshop' }],
    ['a code in the wrong case', { requested_app_code: 'Chrome' }],
    ['a code with spaces', { requested_app_code: ' chrome' }],
    [
      'arguments the server should not send',
      { requested_app_code: 'chrome', arguments: { appId: 'x' } }
    ]
  ])('refuses %s as invalid input', (_name, overrides) => {
    expect(translate({ command_type: 'apps.launch', ...overrides })).toMatchObject({
      ok: false,
      rejection: { failureStage: 'validation', errorCode: 'invalid_input' }
    })
  })

  it('refuses a known code where the platform has no mapping', () => {
    expect(
      translate({ command_type: 'apps.activate', requested_app_code: 'chrome' }, 'win32')
    ).toMatchObject({
      ok: false,
      rejection: { failureStage: 'capability', errorCode: 'unsupported' }
    })
  })

  it('translates a restore and ignores a stray app code', () => {
    expect(translate({ command_type: 'apps.restore', requested_app_code: 'chrome' })).toEqual({
      ok: true,
      value: { command: { tool: 'apps.restore', arguments: {} } }
    })
  })

  it('refuses a restore that carries arguments', () => {
    expect(translate({ command_type: 'apps.restore', arguments: { appId: 'x' } })).toMatchObject({
      ok: false,
      rejection: { errorCode: 'invalid_input' }
    })
  })
})

describe('translateCommand: other tools', () => {
  it('opens a URL', () => {
    expect(
      translate({ command_type: 'browser.open', arguments: { url: 'https://example.com/a?b=1' } })
    ).toEqual({
      ok: true,
      value: {
        command: { tool: 'browser.open', arguments: { url: 'https://example.com/a?b=1' } }
      }
    })
  })

  it.each([
    ['a file URL', { url: 'file:///etc/passwd' }],
    ['a javascript URL', { url: 'javascript:alert(1)' }],
    ['a relative URL', { url: 'example.com' }],
    ['a URL with surrounding space', { url: ' https://example.com' }],
    ['no URL', {}],
    ['an extra key', { url: 'https://example.com', browser: 'chrome' }]
  ])('refuses %s', (_name, args) => {
    expect(translate({ command_type: 'browser.open', arguments: args })).toMatchObject({
      ok: false,
      rejection: { failureStage: 'validation', errorCode: 'invalid_input' }
    })
  })

  it.each(['downloads', 'documents', 'desktop', 'pictures', 'home', 'music', 'videos'])(
    'opens the %s folder',
    (alias) => {
      expect(translate({ command_type: 'folder.open', arguments: { alias } })).toEqual({
        ok: true,
        value: { command: { tool: 'folder.open', arguments: { alias } } }
      })
    }
  )

  it.each([
    ['an unknown alias', { alias: 'system' }],
    ['a path', { alias: '/Users/someone' }],
    ['a traversal', { alias: '../' }],
    ['a different case', { alias: 'Downloads' }],
    ['no alias', {}],
    ['a path key', { alias: 'downloads', path: '/tmp' }]
  ])('refuses a folder request with %s', (_name, args) => {
    expect(translate({ command_type: 'folder.open', arguments: args })).toMatchObject({
      ok: false,
      rejection: { errorCode: 'invalid_input' }
    })
  })

  it.each([
    [{ mode: 'set', level: 0 }],
    [{ mode: 'set', level: 100 }],
    [{ mode: 'adjust', delta: -100 }],
    [{ mode: 'adjust', delta: 100 }],
    [{ mode: 'adjust', delta: 0 }]
  ])('accepts the volume change %j', (args) => {
    expect(translate({ command_type: 'system.volume', arguments: args })).toEqual({
      ok: true,
      value: { command: { tool: 'system.volume', arguments: args } }
    })
  })

  it.each([
    [{ mode: 'set', level: 101 }],
    [{ mode: 'set', level: -1 }],
    [{ mode: 'set', level: 50.5 }],
    [{ mode: 'set', level: '50' }],
    [{ mode: 'adjust', delta: 101 }],
    [{ mode: 'adjust', delta: -101 }],
    [{ mode: 'adjust', delta: 1.5 }],
    [{ mode: 'set', delta: 10 }],
    [{ mode: 'adjust', level: 10 }],
    [{ mode: 'jump', level: 10 }],
    [{ level: 10 }],
    [{}]
  ])('refuses the volume change %j', (args) => {
    expect(translate({ command_type: 'system.volume', arguments: args })).toMatchObject({
      ok: false,
      rejection: { failureStage: 'validation', errorCode: 'invalid_input' }
    })
  })

  it('translates mute and refuses a non-boolean', () => {
    expect(translate({ command_type: 'system.mute', arguments: { muted: true } })).toEqual({
      ok: true,
      value: { command: { tool: 'system.mute', arguments: { muted: true } } }
    })
    for (const muted of ['true', 1, null]) {
      expect(translate({ command_type: 'system.mute', arguments: { muted } })).toMatchObject({
        ok: false,
        rejection: { errorCode: 'invalid_input' }
      })
    }
  })
})

describe('translateCommand: commands this client does not run', () => {
  it.each(['apps.list', 'apps.close', 'browser.search', 'system.status'])(
    'refuses %s as unsupported even with valid arguments',
    (type) => {
      expect(
        translate({
          command_type: type,
          requested_app_code: 'chrome',
          arguments: { query: 'weather', engine: 'google' }
        })
      ).toMatchObject({
        ok: false,
        rejection: { failureStage: 'capability', errorCode: 'unsupported' }
      })
    }
  )

  it.each([
    'system.power',
    'files.search',
    'apps.install',
    'APPS.LAUNCH',
    'apps.launch ',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty'
  ])('refuses the unknown type %j as unsupported', (type) => {
    expect(translate({ command_type: type, requested_app_code: 'chrome' })).toMatchObject({
      ok: false,
      rejection: { failureStage: 'capability', errorCode: 'unsupported' }
    })
  })
})

describe('invocationFor', () => {
  it('builds an invocation the executor accepts, with the stable execution ID', () => {
    const source = command({ command_type: 'system.mute', arguments: { muted: false } })
    const translated = translateCommand(source, 'darwin')
    if (!translated.ok) throw new Error('expected a translation')
    const invocation = invocationFor(source, translated.value.command)
    expect(ToolInvocationSchema.safeParse(invocation).success).toBe(true)
    expect(invocation.executionId).toBe(executionIdFor(source))
    expect(invocationFor(source, translated.value.command, 'req_1').requestId).toBe('req_1')
  })
})

describe('app display names', () => {
  it('has a name for every code on macOS and none elsewhere', () => {
    for (const code of APP_CODES) {
      expect(appDisplayNameFor(code, 'darwin')?.length).toBeGreaterThan(0)
      expect(appDisplayNameFor(code, 'win32')).toBeUndefined()
    }
  })
})
