import { describe, expect, it, vi } from 'vitest'
import type { CommandRunner } from '../../src/main/platform/command-runner'
import { WindowsSystemAudio } from '../../src/main/platform/windows-system-audio'

interface FakeState {
  level: number
  muted: boolean
}

/**
 * A PowerShell that keeps the state of one playback device. It reads the two inputs the audio
 * script is given (`$level`, `$muted`) and answers with the state afterwards, like the real script.
 */
function setup(
  initial: FakeState = { level: 30, muted: false },
  behaviour: {
    /** What the device ends up at for a requested level. */
    step?: (level: number) => number
    fail?: boolean
    stdout?: string
  } = {}
) {
  const state = { ...initial }
  const scripts: string[] = []
  const calls: { file: string; args: readonly string[] }[] = []
  const run = vi.fn<CommandRunner['run']>(async (file, args) => {
    calls.push({ file, args })
    const script = Buffer.from(String(args[args.length - 1]), 'base64').toString('utf16le')
    scripts.push(script)
    if (behaviour.fail) return { ok: true as const, value: { code: 1, stdout: '', stderr: 'err' } }
    const level = /^\$level = (\$null|\d+)$/m.exec(script)?.[1]
    const muted = /^\$muted = (\$null|\$true|\$false)$/m.exec(script)?.[1]
    if (level === undefined || muted === undefined) throw new Error('script has no inputs')
    if (level !== '$null') state.level = (behaviour.step ?? ((n) => n))(Number(level))
    if (muted !== '$null') state.muted = muted === '$true'
    return {
      ok: true as const,
      value: {
        code: 0,
        stdout:
          behaviour.stdout ?? `${JSON.stringify({ level: state.level, muted: state.muted })}\r\n`,
        stderr: ''
      }
    }
  })
  return {
    audio: new WindowsSystemAudio({ runner: { run }, systemRoot: 'C:\\WINDOWS' }),
    run,
    scripts,
    calls,
    state
  }
}

const inputs = (script: string) => ({
  level: /^\$level = (.*)$/m.exec(script)?.[1],
  muted: /^\$muted = (.*)$/m.exec(script)?.[1]
})

describe('Windows volume', () => {
  it('sets the level, reads it back and reports what the OS says', async () => {
    const { audio, scripts } = setup()
    expect(await audio.setVolume(40)).toEqual({
      ok: true,
      value: { kind: 'audio', level: 40, muted: false, status: 'confirmed' }
    })
    expect(scripts.map(inputs)).toEqual([
      { level: '40', muted: '$null' },
      { level: '$null', muted: '$null' }
    ])
  })

  it('runs the fixed PowerShell with an encoded script and no shell', async () => {
    const { audio, calls } = setup()
    await audio.setVolume(40)
    expect(calls[0].file).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(calls[0].args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ])
    expect(calls[0].args).toHaveLength(6)
  })

  it('accepts a device that lands one point away from the request', async () => {
    const { audio } = setup(undefined, { step: (level) => level + 1 })
    expect(await audio.setVolume(40)).toMatchObject({ ok: true, value: { status: 'confirmed' } })
  })

  it('reports an unknown result when the level did not move to the request', async () => {
    const { audio } = setup({ level: 30, muted: false }, { step: () => 12 })
    expect(await audio.setVolume(80)).toEqual({
      ok: true,
      value: { kind: 'audio', level: 12, muted: false, status: 'unknown' }
    })
  })

  it('reports a failed change as unavailable', async () => {
    const { audio } = setup(undefined, { fail: true })
    expect(await audio.setVolume(40)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('does not trust output it cannot read', async () => {
    for (const stdout of ['', 'not json', '{"level":150,"muted":false}', '{"level":50}', '{}'])
      expect(await setup(undefined, { stdout }).audio.setVolume(40)).toMatchObject({
        ok: false,
        error: { code: 'unavailable' }
      })
  })

  it('passes a runner failure through', async () => {
    const audio = new WindowsSystemAudio({
      runner: {
        run: async () => ({
          ok: false,
          error: { code: 'unavailable', message: 'OS 명령을 실행하지 못했습니다.' }
        })
      }
    })
    expect(await audio.setVolume(40)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })
})

describe('relative volume', () => {
  it('moves from the current level', async () => {
    const { audio, scripts } = setup({ level: 30, muted: false })
    expect(await audio.adjustVolume(10)).toMatchObject({
      ok: true,
      value: { level: 40, status: 'confirmed' }
    })
    expect(scripts.map(inputs)[1]).toEqual({ level: '40', muted: '$null' })
    expect(await audio.adjustVolume(-15)).toMatchObject({ ok: true, value: { level: 25 } })
  })

  it('stays within 0 to 100', async () => {
    expect(await setup({ level: 95, muted: false }).audio.adjustVolume(30)).toMatchObject({
      ok: true,
      value: { level: 100, status: 'confirmed' }
    })
    expect(await setup({ level: 5, muted: false }).audio.adjustVolume(-30)).toMatchObject({
      ok: true,
      value: { level: 0, status: 'confirmed' }
    })
  })

  it('does not touch mute itself and reports the state the OS ends up in', async () => {
    const { audio, scripts } = setup({ level: 30, muted: true })
    expect(await audio.adjustVolume(10)).toMatchObject({
      ok: true,
      value: { level: 40, muted: true, status: 'confirmed' }
    })
    expect(scripts.every((script) => inputs(script).muted === '$null')).toBe(true)
  })

  it('does not apply a change when the level cannot be read', async () => {
    const { audio, scripts } = setup(undefined, { fail: true })
    expect(await audio.adjustVolume(10)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(scripts).toHaveLength(1)
    expect(inputs(scripts[0])).toEqual({ level: '$null', muted: '$null' })
  })
})

describe('Windows mute', () => {
  it('mutes and unmutes, confirming from the OS state', async () => {
    const { audio, state, scripts } = setup()
    expect(await audio.setMuted(true)).toEqual({
      ok: true,
      value: { kind: 'audio', level: 30, muted: true, status: 'confirmed' }
    })
    expect(state.muted).toBe(true)
    expect(inputs(scripts[0])).toEqual({ level: '$null', muted: '$true' })
    expect(await audio.setMuted(false)).toMatchObject({
      ok: true,
      value: { muted: false, status: 'confirmed' }
    })
    expect(inputs(scripts[2])).toEqual({ level: '$null', muted: '$false' })
  })

  it('is fine to ask for the state it already has', async () => {
    const { audio } = setup({ level: 30, muted: true })
    expect(await audio.setMuted(true)).toMatchObject({
      ok: true,
      value: { muted: true, status: 'confirmed' }
    })
  })
})

describe('input handling', () => {
  it('refuses anything but plain in-range numbers and booleans before running a script', async () => {
    const { audio, run } = setup()
    for (const level of [101, -1, 1.5, Number.NaN, Infinity, '40', '40; calc', null])
      expect(await audio.setVolume(level as never)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    for (const delta of [101, -101, 0.5, Number.NaN, '5', undefined])
      expect(await audio.adjustVolume(delta as never)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    for (const muted of ['true', 1, null, undefined])
      expect(await audio.setMuted(muted as never)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    expect(run).not.toHaveBeenCalled()
  })

  it('does nothing for a request that is already cancelled', async () => {
    const { audio, run } = setup()
    const controller = new AbortController()
    controller.abort()
    for (const result of [
      await audio.setVolume(40, { signal: controller.signal }),
      await audio.adjustVolume(5, { signal: controller.signal }),
      await audio.setMuted(true, { signal: controller.signal })
    ])
      expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('does not apply a relative change that was cancelled while the level was read', async () => {
    const controller = new AbortController()
    const { audio, scripts } = setup()
    const original = (audio as unknown as { read: (o?: unknown) => Promise<unknown> }).read
    ;(audio as unknown as { read: (o?: unknown) => Promise<unknown> }).read = async function (
      this: unknown,
      options?: unknown
    ) {
      const state = await original.call(this, options)
      controller.abort()
      return state
    }
    expect(await audio.adjustVolume(10, { signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(scripts.map(inputs).some((script) => script.level !== '$null')).toBe(false)
  })
})
