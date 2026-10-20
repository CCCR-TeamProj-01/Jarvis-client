import { execFile } from 'node:child_process'
import type { Result } from '../../shared/contracts/common'

export interface CommandResult {
  /** Exit code; null when the process was ended by a signal. */
  code: number | null
  stdout: string
  stderr: string
}

export interface CommandRunOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Runs a fixed executable with an argument array. There is deliberately no shell and no string
 * form, so request data can never be interpreted as a command line.
 */
export interface CommandRunner {
  run(
    file: string,
    args: readonly string[],
    options?: CommandRunOptions
  ): Promise<Result<CommandResult>>
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024

export const nodeCommandRunner: CommandRunner = {
  run(file, args, options = {}) {
    return new Promise((resolve) => {
      if (options.signal?.aborted)
        return resolve({
          ok: false,
          error: { code: 'cancelled', message: '요청이 취소되었습니다.' }
        })
      const child = execFile(
        file,
        [...args],
        {
          encoding: 'utf8',
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          signal: options.signal
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ ok: true, value: { code: 0, stdout, stderr } })
          const failure = error as NodeJS.ErrnoException & {
            killed?: boolean
            code?: number | string
          }
          if (options.signal?.aborted)
            return resolve({
              ok: false,
              error: { code: 'cancelled', message: '요청이 취소되었습니다.' }
            })
          if (failure.killed)
            return resolve({
              ok: false,
              error: { code: 'unavailable', message: 'OS 명령이 제한 시간 안에 끝나지 않았습니다.' }
            })
          if (typeof failure.code === 'number')
            return resolve({ ok: true, value: { code: failure.code, stdout, stderr } })
          resolve({
            ok: false,
            error: { code: 'unavailable', message: 'OS 명령을 실행하지 못했습니다.' }
          })
        }
      )
      child.stdin?.end()
    })
  }
}
