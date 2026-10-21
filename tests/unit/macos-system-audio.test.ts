import { describe, expect, it, vi } from 'vitest'
import type { CommandRunner } from '../../src/main/platform/command-runner'
import { MacSystemAudio } from '../../src/main/platform/macos-system-audio'

interface FakeState {
  level: number | null
  muted: boolean
}

/**
 * An osascript that keeps the state of one output device. `step` quantises a requested level the
 * way real devices do, `failRead` and `failSet` make the matching script exit non-zero.
 */
function setup(
  initial: FakeState = { level: 30, muted: false },
  behaviour: {
    step?: (level: number) => number
    failRead?: boolean
    failSet?: boolean
    /** macOS ties mute to the level: above zero unmutes, zero mutes. */
    coupleMute?: boolean
  } = {}
) {
  const state = { ...initial }
  const scripts: string[] = []
  const run = vi.fn<CommandRunner['run']>(async (file, args) => {
    expect(file).toBe('/usr/bin/osascript')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('-e')
    const script = String(args[1])
    scripts.push(script)
    const ok = (stdout = '') => ({ ok: true as const, value: { code: 0, stdout, stderr: '' } })
    const bad = () => ({ ok: true as const, value: { code: 1, stdout: '', stderr: 'err' } })
    if (script === 'get volume settings')
      return behaviour.failRead
        ? bad()
        : ok(
            `output volume:${state.level ?? 'missing value'}, input volume:60, alert volume:100, output muted:${state.muted}\n`
          )
    const level = /^set volume output volume (\d+)$/.exec(script)?.[1]
    if (level !== undefined) {
      if (behaviour.failSet) return bad()
      if (state.level !== null) state.level = (behaviour.step ?? ((n) => n))(Number(level))
      if (behaviour.coupleMute) state.muted = state.level === 0
      return ok()
    }
    const muted = /^set volume output muted (true|false)$/.exec(script)?.[1]
    if (muted !== undefined) {
      if (behaviour.failSet) return bad()
      state.muted = muted === 'true'
      return ok()
    }
    throw new Error(`unexpected script: ${script}`)
  })
  return { audio: new MacSystemAudio({ runner: { run } }), run, scripts, state }
}

describe('macOS volume', () => {
  it('sets the level, reads it back and reports what the OS says', async () => {
    const { audio, scripts } = setup()
    expect(await audio.setVolume(40)).toEqual({
      ok: true,
      value: { kind: 'audio', level: 40, muted: false, status: 'confirmed' }
    })
    expect(scripts).toEqual(['set volume output volume 40', 'get volume settings'])
  })

  it('accepts a device that lands one step away from the request', async () => {
    const { audio } = setup(undefined, {
      step: (level) => Math.round(Math.round(level / 6.25) * 6.25)
    })
    const result = await audio.setVolume(40)
    expect(result).toMatchObject({ ok: true, value: { status: 'confirmed' } })
  })

  it('reports an unknown result when the level did not move to the request', async () => {
    const { audio } = setup({ level: 30, muted: false }, { step: () => 12 })
    expect(await audio.setVolume(80)).toEqual({
      ok: true,
      value: { kind: 'audio', level: 12, muted: false, status: 'unknown' }
    })
  })

  it('does not claim a volume for a device that cannot report one', async () => {
    const { audio } = setup({ level: null, muted: false })
    expect(await audio.setVolume(40)).toEqual({
      ok: true,
      value: { kind: 'audio', level: null, muted: false, status: 'dispatched' }
    })
  })

  it('falls back to a handoff when the state cannot be read back', async () => {
    const { audio } = setup(undefined, { failRead: true })
    expect(await audio.setVolume(40)).toEqual({
      ok: true,
      value: { kind: 'audio', level: null, muted: null, status: 'dispatched' }
    })
  })

  it('reports a failed change as unavailable', async () => {
    const { audio } = setup(undefined, { failSet: true })
    expect(await audio.setVolume(40)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('passes a runner failure through', async () => {
    const audio = new MacSystemAudio({
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
    expect(scripts[1]).toBe('set volume output volume 40')
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

  it('cannot step a device whose level it cannot read', async () => {
    const { audio, scripts } = setup({ level: null, muted: false })
    expect(await audio.adjustVolume(10)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' }
    })
    expect(scripts).toEqual(['get volume settings'])
  })

  it('does not touch mute itself and reports the state the OS ends up in', async () => {
    const plain = setup({ level: 30, muted: true })
    expect(await plain.audio.adjustVolume(10)).toMatchObject({
      ok: true,
      value: { level: 40, muted: true }
    })
    expect(plain.scripts.some((script) => script.includes('muted'))).toBe(false)
    // On macOS a level above zero unmutes and zero mutes; the report follows the OS.
    const coupled = setup({ level: 0, muted: true }, { coupleMute: true })
    expect(await coupled.audio.adjustVolume(10)).toMatchObject({
      ok: true,
      value: { level: 10, muted: false, status: 'confirmed' }
    })
    expect(await coupled.audio.setVolume(0)).toMatchObject({
      ok: true,
      value: { level: 0, muted: true, status: 'confirmed' }
    })
  })
})

describe('macOS mute', () => {
  it('mutes and unmutes, confirming from the OS state', async () => {
    const { audio, state } = setup()
    expect(await audio.setMuted(true)).toEqual({
      ok: true,
      value: { kind: 'audio', level: 30, muted: true, status: 'confirmed' }
    })
    expect(state.muted).toBe(true)
    expect(await audio.setMuted(false)).toMatchObject({
      ok: true,
      value: { muted: false, status: 'confirmed' }
    })
  })

  it('is fine to ask for the state it already has', async () => {
    const { audio } = setup({ level: 30, muted: true })
    expect(await audio.setMuted(true)).toMatchObject({
      ok: true,
      value: { muted: true, status: 'confirmed' }
    })
  })

  it('can confirm a mute even when the device has no level', async () => {
    const { audio } = setup({ level: null, muted: false })
    expect(await audio.setMuted(true)).toMatchObject({
      ok: true,
      value: { level: null, muted: true, status: 'confirmed' }
    })
  })
})

describe('input handling', () => {
  it('refuses anything but plain in-range numbers and booleans before running a script', async () => {
    const { audio, run } = setup()
    for (const level of [101, -1, 1.5, Number.NaN, Infinity, '40', '40; do shell script "x"', null])
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
    expect(scripts.some((script) => script.startsWith('set volume'))).toBe(false)
  })
})
