import type { ClientError, Result } from '../../shared/contracts/common'
import type { AudioObservation } from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'
import type { CommandRunner } from './command-runner'
import type { SystemAudioPort } from './ports'
import { isPercent, verifyAudio } from './system-audio-support'
import type { AudioState } from './system-audio-support'

const OSASCRIPT = '/usr/bin/osascript'

/**
 * Output devices move in coarse steps (the built-in speakers use sixteenths, about 6 points), so
 * a level that lands within this distance of the request counts as the request.
 */
const LEVEL_TOLERANCE = 4

interface MacSystemAudioOptions {
  runner: CommandRunner
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * The AppleScript standard commands for the output volume. They are not addressed to another
 * application, so they need no automation permission. Only validated integers and booleans are
 * ever placed in a script, and the script is passed as one argument (no shell).
 */
export class MacSystemAudio implements SystemAudioPort {
  constructor(private readonly options: MacSystemAudioOptions) {}

  async setVolume(
    level: number,
    options?: LocalExecutionOptions
  ): Promise<Result<AudioObservation>> {
    if (!isPercent(level))
      return failure('invalid_input', '볼륨은 0에서 100 사이의 정수여야 합니다.')
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const changed = await this.script(`set volume output volume ${level}`, options)
    if (!changed.ok) return changed
    return this.verify(options, (state) => (state.level === null ? null : near(state.level, level)))
  }

  async adjustVolume(
    delta: number,
    options?: LocalExecutionOptions
  ): Promise<Result<AudioObservation>> {
    if (!Number.isInteger(delta) || delta < -100 || delta > 100)
      return failure('invalid_input', '볼륨 변화량은 -100에서 100 사이의 정수여야 합니다.')
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const current = await this.read(options)
    if (!current.ok) return current
    if (current.value.level === null)
      return failure('unavailable', '이 출력 장치는 볼륨을 읽을 수 없어 올리거나 내릴 수 없습니다.')
    const target = Math.min(100, Math.max(0, current.value.level + delta))
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const changed = await this.script(`set volume output volume ${target}`, options)
    if (!changed.ok) return changed
    return this.verify(options, (state) =>
      state.level === null ? null : near(state.level, target)
    )
  }

  async setMuted(
    muted: boolean,
    options?: LocalExecutionOptions
  ): Promise<Result<AudioObservation>> {
    if (typeof muted !== 'boolean')
      return failure('invalid_input', '음소거 값이 올바르지 않습니다.')
    if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
    const changed = await this.script(
      `set volume output muted ${muted ? 'true' : 'false'}`,
      options
    )
    if (!changed.ok) return changed
    return this.verify(options, (state) => (state.muted === null ? null : state.muted === muted))
  }

  // --- internals -------------------------------------------------------------------------------

  private async script(source: string, options?: LocalExecutionOptions): Promise<Result<string>> {
    const result = await this.options.runner.run(OSASCRIPT, ['-e', source], {
      ...(options?.signal ? { signal: options.signal } : {})
    })
    if (!result.ok) return result
    if (result.value.code !== 0) return failure('unavailable', '시스템 볼륨을 바꾸지 못했습니다.')
    return { ok: true, value: result.value.stdout }
  }

  private verify(
    options: LocalExecutionOptions | undefined,
    check: (state: AudioState) => boolean | null
  ): Promise<Result<AudioObservation>> {
    return verifyAudio(() => this.read(options), check)
  }

  private async read(options?: LocalExecutionOptions): Promise<Result<AudioState>> {
    const output = await this.script('get volume settings', options)
    if (!output.ok) return output
    const level = /output volume:(\d+|missing value)/.exec(output.value)?.[1]
    const muted = /output muted:(true|false|missing value)/.exec(output.value)?.[1]
    if (level === undefined || muted === undefined)
      return failure('unavailable', '시스템 볼륨 상태를 읽지 못했습니다.')
    const parsed = level === 'missing value' ? null : Number.parseInt(level, 10)
    return {
      ok: true,
      value: {
        level: parsed !== null && isPercent(parsed) ? parsed : null,
        muted: muted === 'true' ? true : muted === 'false' ? false : null
      }
    }
  }
}

const near = (actual: number, wanted: number) => Math.abs(actual - wanted) <= LEVEL_TOLERANCE
