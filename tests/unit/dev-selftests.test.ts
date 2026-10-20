import { beforeEach, describe, expect, it, vi } from 'vitest'

const { started, starter } = vi.hoisted(() => {
  const started = { names: [] as string[], released: [] as string[] }
  const starter = (name: string) => () => {
    started.names.push(name)
    return () => {
      started.released.push(name)
    }
  }
  return { started, starter }
})
vi.mock('../../src/main/sensors/dev-selftest', () => ({ startSensorSelfTest: starter('sensor') }))
vi.mock('../../src/main/speech/dev-voice-selftest', () => ({
  startSpeechSelfTest: starter('speech'),
  startVoiceSelfTest: starter('voice')
}))
vi.mock('../../src/main/gesture/dev-hand-selftest', () => ({ startHandSelfTest: starter('hand') }))
vi.mock('../../src/main/tools/dev-tool-selftest', () => ({ startToolSelfTest: starter('tool') }))

import {
  parseHandSelfTestSeconds,
  startDevSelfTests
} from '../../src/main/application/dev-selftests'

beforeEach(() => {
  started.names = []
  started.released = []
})

const run = (env: Record<string, string>, isPackaged = false) =>
  startDevSelfTests({
    isPackaged,
    env,
    auth: {} as never,
    sensors: {} as never,
    voice: {} as never,
    conversation: {} as never,
    handTracking: {} as never,
    tools: {} as never
  })

describe('startDevSelfTests', () => {
  it('starts nothing unless its variable is set', () => {
    run({})
    expect(started.names).toEqual([])
  })

  it('starts each check from its own variable', () => {
    run({
      JARVIS_SENSOR_SELFTEST: '1',
      JARVIS_SPEECH_SELFTEST: '1',
      JARVIS_VOICE_SELFTEST: '2',
      JARVIS_HAND_SELFTEST: '5',
      JARVIS_TOOL_SELFTEST: '[]'
    })
    expect(started.names.sort()).toEqual(['hand', 'sensor', 'speech', 'tool', 'voice'])
  })

  it('the sensor and speech checks need exactly "1"', () => {
    run({ JARVIS_SENSOR_SELFTEST: 'yes', JARVIS_SPEECH_SELFTEST: '0' })
    expect(started.names).toEqual([])
  })

  it('never runs in a packaged app, whatever is set', () => {
    run({ JARVIS_SENSOR_SELFTEST: '1', JARVIS_TOOL_SELFTEST: '[]' }, true)
    expect(started.names).toEqual([])
  })

  it('the function it returns releases every check', () => {
    const stop = run({ JARVIS_SENSOR_SELFTEST: '1', JARVIS_HAND_SELFTEST: '3' })
    stop()
    expect(started.released.sort()).toEqual(['hand', 'sensor'])
  })
})

describe('parseHandSelfTestSeconds', () => {
  it('reads seconds, treats 0 and "forever" as until sign-out, and falls back for nonsense', () => {
    expect(parseHandSelfTestSeconds('15')).toBe(15)
    expect(parseHandSelfTestSeconds('0')).toBe(0)
    expect(parseHandSelfTestSeconds('forever')).toBe(0)
    expect(parseHandSelfTestSeconds('abc')).toBe(5)
    expect(parseHandSelfTestSeconds('-3')).toBe(5)
  })
})
