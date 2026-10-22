import { join } from 'node:path'

export type DevEnvResult = 'skipped' | 'missing' | 'loaded' | 'failed'

interface DevEnvOptions {
  /** A packaged app never reads the file, even when one is there. */
  isPackaged: boolean
  /** The project folder, where `.env` lives. */
  root: string
  /** Reads a `.env` file into `process.env` without replacing a value that is already set. */
  load?(path: string): void
  /** Fixed wording only: never the file's contents or the error's own text. */
  log?(message: string): void
}

/**
 * Development only: reads the project's `.env` into the environment before anything looks at it, so
 * the settings that are otherwise typed in front of every `pnpm dev` can live in a file. A value
 * already set by the shell wins over the file. A file that is not there is the normal case; one
 * that cannot be read is reported, without saying what was in it.
 */
export function loadDevEnv({
  isPackaged,
  root,
  load = (path) => process.loadEnvFile(path),
  log = (message) => console.warn(`[env] ${message}`)
}: DevEnvOptions): DevEnvResult {
  if (isPackaged) return 'skipped'
  try {
    load(join(root, '.env'))
    return 'loaded'
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
    log('.env 파일을 읽지 못했어요. 형식과 권한을 확인해 주세요.')
    return 'failed'
  }
}
