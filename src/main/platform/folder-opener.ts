import type { ClientError, Result } from '../../shared/contracts/common'
import { FolderAliasSchema } from '../../shared/contracts/tools'
import type { FolderAlias } from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'
import type { FolderOpenPort } from './ports'

interface FolderOpenerOptions {
  /** The OS standard folder for an alias (Electron `app.getPath`). May throw for an unknown one. */
  resolve(alias: FolderAlias): string
  isDirectory(path: string): Promise<boolean>
  /** Electron `shell.openPath`: resolves to '' on success, otherwise a description of the error. */
  openPath(path: string): Promise<string>
}

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/**
 * Opens a standard folder in the default file manager. Only an alias is accepted, so a path, a
 * relative path or a shell string can never reach the OS. The resolved path stays in this
 * function: it is neither reported nor put into an error message.
 */
export function createFolderOpener(options: FolderOpenerOptions): FolderOpenPort {
  return {
    async open(alias, execution?: LocalExecutionOptions) {
      const parsed = FolderAliasSchema.safeParse(alias)
      if (!parsed.success) return failure('invalid_input', '알 수 없는 폴더입니다.')
      if (execution?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')

      let path: string
      try {
        path = options.resolve(parsed.data)
        if (!(await options.isDirectory(path))) throw new Error('not a directory')
      } catch {
        return failure('not_found', '이 기기에서 해당 폴더를 찾을 수 없습니다.')
      }
      // A request cancelled while the folder was being checked must not open anything.
      if (execution?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')

      try {
        if ((await options.openPath(path)) !== '')
          return failure('unavailable', '파일 관리자로 폴더를 전달하지 못했습니다.')
      } catch {
        return failure('unavailable', '파일 관리자로 폴더를 전달하지 못했습니다.')
      }
      return { ok: true, value: { kind: 'folder', alias: parsed.data, status: 'dispatched' } }
    }
  }
}
